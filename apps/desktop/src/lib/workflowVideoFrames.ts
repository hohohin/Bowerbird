import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "./api";
import { generationInputNode, type WorkflowInput, type WorkflowNode, type WorkflowValue } from "./canvasWorkflow";
import type { CanvasNode } from "./types";
import { isVideoPath } from "./videoGeneration";
import { readVideoBoundaryFrame, readVideoLastFrame } from "./videoFrame";
import { saveVideoFrame } from "./saveVideoFrame";
import type { AutomaticOutput } from "./workflowAutoConnect";

type VideoFramePosition = NonNullable<WorkflowInput["videoFrame"]>["position"];

/** Use the selected video identity while planning; only a saved frame is committed. */
export function videoFrameOutputPreview(output: AutomaticOutput, position: VideoFramePosition): AutomaticOutput {
  const assetId = output.binding.assetId;
  if (!assetId) throw new Error("视频来源尚无可用文件");
  return { ...output, media: "image", binding: { ...output.binding, videoFrame: { position, assetId } } };
}

export async function materializeVideoFrameOutput(projectId: string, output: AutomaticOutput, position: VideoFramePosition,
  isCurrent: () => boolean = () => true): Promise<AutomaticOutput> {
  const ensureCurrent = () => {
    if (!isCurrent()) throw new DOMException("连接已取消", "AbortError");
  };
  ensureCurrent();
  const plan = videoFrameOutputPreview(output, position);
  const [asset] = await api.getAssetsByIds([plan.binding.assetId!]);
  ensureCurrent();
  const path = asset?.store_path;
  if (!path || !isVideoPath(path)) throw new Error("视频文件不可用，请检查来源卡片");
  const frame = await readVideoBoundaryFrame(`${convertFileSrc(path)}?frame=${crypto.randomUUID()}`, path, position);
  ensureCurrent();
  const image = await saveVideoFrame(frame, projectId);
  ensureCurrent();
  return { ...plan, binding: { ...plan.binding, videoFrame: { position, assetId: image.id } } };
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
