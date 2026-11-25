import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "./api";
import { generationInputNode, workflowFrameLabel, type WorkflowInput, type WorkflowNode, type WorkflowValue } from "./canvasWorkflow";
import type { CanvasNode } from "./types";
import { isVideoPath } from "./videoGeneration";
import { readVideoBoundaryFrame, readVideoLastFrame } from "./videoFrame";
import { saveVideoFrame } from "./saveVideoFrame";
import type { AutomaticOutput } from "./workflowAutoConnect";
import { WorkflowInputError } from "./workflowDiagnostics";

type VideoFramePosition = NonNullable<WorkflowInput["videoFrame"]>["position"];

/** A card binding follows its producer on every run. A material binding keeps its saved frame. */
export function videoFrameOutputPreview(output: AutomaticOutput, position: VideoFramePosition): AutomaticOutput {
  const assetId = output.binding.assetId;
  if (!assetId && !(output.binding.nodeId && output.binding.portId)) throw new Error("视频来源尚无可用文件");
  return { ...output, media: "image", binding: { ...output.binding, videoAudio: undefined, videoFrame: assetId ? { position, assetId } : { position } } };
}

export async function materializeVideoFrameOutput(projectId: string, output: AutomaticOutput, position: VideoFramePosition,
  isCurrent: () => boolean = () => true): Promise<AutomaticOutput> {
  const plan = videoFrameOutputPreview(output, position);
  const id = output.binding.assetId;
  if (!id) throw new Error("视频来源尚无可用文件");
  const assetId = await saveBoundaryFrame(projectId, id, position, isCurrent);
  return { ...plan, binding: { ...plan.binding, videoAudio: undefined, videoFrame: { position, assetId } } };
}

async function saveBoundaryFrame(projectId: string, videoId: string, position: VideoFramePosition, isCurrent: () => boolean) {
  const ensureCurrent = () => {
    if (!isCurrent()) throw new DOMException("连接已取消", "AbortError");
  };
  ensureCurrent();
  const [asset] = await api.getAssetsByIds([videoId]);
  ensureCurrent();
  const path = asset?.store_path;
  if (!path || !isVideoPath(path)) throw new Error("视频文件不可用，请检查来源卡片");
  const frame = await readVideoBoundaryFrame(`${convertFileSrc(path)}?frame=${crypto.randomUUID()}`, path, position);
  ensureCurrent();
  const image = await saveVideoFrame(frame, projectId);
  ensureCurrent();
  return image.id;
}

/** Resolve only this consumer's values. The saved wire continues to follow the producer. */
export async function resolveDynamicVideoFrame(projectId: string, node: WorkflowNode, binding: WorkflowInput,
  value: WorkflowValue, halted: () => boolean): Promise<WorkflowValue> {
  const frame = binding.videoFrame;
  if (!frame || halted()) return value;
  const ids = value.assetIds ?? [];
  if (ids.length !== 1) throw new WorkflowInputError("首尾帧引用需要上游输出一个视频，请检查上游生成结果", node, binding);
  try {
    const frameId = await saveBoundaryFrame(projectId, ids[0], frame.position, () => !halted());
    return { ...value, assetIds: [frameId], nodeIds: undefined };
  } catch (error) {
    if (halted()) return value;
    throw new WorkflowInputError(`无法提取上游视频的${workflowFrameLabel(frame)}：${error instanceof Error ? error.message : String(error)}`, node, binding);
  }
}

/** Only canvas video image sockets become frames; the generator's video output stays a video. */
export function videoFrameInputValues(node: WorkflowNode, values: Record<string, WorkflowValue[]>, canvas: readonly CanvasNode[], nodes: readonly WorkflowNode[] = []) {
  if (node.kind === "agent") return [];
  const inputs = generationInputNode(node, nodes).inputs.image ?? [];
  return (values.image ?? []).filter((_, index) => {
    const input = inputs[index];
    if (input?.autoConnect) return false;
    return input?.assetNodeId || input?.canvasNodeId && canvas.some(card => card.id === input.canvasNodeId && card.kind === "prompt");
  });
}
export async function resolveVideoCardOutputs(node: WorkflowNode, values: Record<string, WorkflowValue[]>,
  canvas: readonly CanvasNode[], projectId: string, halted: () => boolean, nodes: readonly WorkflowNode[] = []) {
  const selected = videoFrameInputValues(node, values, canvas, nodes);
  const ids = [...new Set(selected.flatMap(value => value.assetIds ?? []))];
  if (!ids.length) return;
  const assets = await api.getAssetsByIds(ids);
  const replacements = new Map<string, string>();
  for (const asset of assets) {
    if (!isVideoPath(asset.store_path)) continue;
    if (halted()) return;
    // Refresh the file even when a previous trim kept its path and asset identity.
    const path = asset.store_path!;
    const frame = await readVideoLastFrame(`${convertFileSrc(path)}?tail=${crypto.randomUUID()}`, path);
    if (halted()) return;
    const image = await api.importImageBytes({ dataUrl: frame.dataUrl, projectId, source: "video-frame",
      fileName: `${asset.name || "视频"}-尾帧.png` });
    replacements.set(asset.id, image.id);
  }
  for (const value of selected) {
    value.assetIds = value.assetIds?.map(id => replacements.get(id) ?? id);
    if (replacements.size) value.nodeIds = undefined;
  }
}
