import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "./api";
import { generationInputNode, type WorkflowNode, type WorkflowValue } from "./canvasWorkflow";
import type { CanvasNode } from "./types";
import { isVideoPath } from "./videoGeneration";
import { readVideoLastFrame } from "./videoFrame";

/** Only canvas video image sockets become frames; the generator's video output stays a video. */
export async function resolveVideoCardOutputs(node: WorkflowNode, values: Record<string, WorkflowValue[]>,
  canvas: readonly CanvasNode[], projectId: string, halted: () => boolean) {
  const inputs = generationInputNode(node).inputs.image ?? [];
  const selected = (values.image ?? []).filter((_, index) => {
    const input = inputs[index];
    return input?.assetNodeId || input?.canvasNodeId && canvas.some(card => card.id === input.canvasNodeId && card.kind === "prompt");
  });
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
