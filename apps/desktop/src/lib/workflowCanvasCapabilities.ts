import { workflowOutputs, type WorkflowNode, type WorkflowValue } from "./canvasWorkflow";
import type { AutomaticMedia, AutomaticOutput } from "./workflowAutoConnect";
import { readCanvasNote } from "./canvasNotes";
import { canvasInputValue } from "./canvasSessionOutputs";
import { isVideoPath } from "./videoGeneration";
import { isAudioPath } from "./audioMedia";
import type { Asset, CanvasNode } from "./types";

type Material = { id: string; assetId?: string; groupId?: string; assetIds?: string[]; mediaAssetIds?: string[]; video?: boolean };

/** The "image" workflow channel carries all three media types. */
export function workflowAssetMedia(asset?: Pick<Asset, "store_path" | "ext">): AutomaticMedia | undefined {
  for (const path of [asset?.store_path, asset?.ext && `asset.${asset.ext}`]) {
    if (!path) continue;
    if (isAudioPath(path) || /^data:audio\//i.test(path)) return "audio";
    if (isVideoPath(path) || /^data:video\//i.test(path)) return "video";
    if (/\.(?:png|jpe?g|webp|gif|avif|svg|ico|bmp|tiff?|heic|heif)(?:[?#].*)?$/i.test(path) || /^data:image\//i.test(path)) return "image";
  }
}

export function workflowSourceMediaLabel(assetIds: readonly string[], assets: readonly Asset[], source?: WorkflowNode) {
  if (assetIds.length) {
    let kind: AutomaticMedia | undefined;
    for (const id of assetIds) {
      const media = workflowAssetMedia(assets.find(asset => asset.id === id));
      if (!media || (kind && kind !== media)) return "素材";
      kind = media;
    }
    return kind === "audio" ? "音频" : kind === "video" ? "视频" : "图片";
  }
  if (source?.kind === "voice") return "音频";
  if (source?.kind === "comfy-video" || source?.generation?.media === "video" || (source?.kind === "agent" && source.skill === "hyperframes")) return "视频";
  if (source?.kind === "generation" || source?.kind === "agent" || source?.kind === "skill" || source?.kind === "instruction") return "图片";
  return "素材";
}

export function automaticValueMedia(value: WorkflowValue | undefined, assets: Asset[], pending = false): AutomaticMedia[] | undefined {
  // Partial metadata and future outputs cannot prove that a connection is incompatible.
  if (pending || value?.nodeIds?.length || !value?.assetIds?.length) return;
  const media: AutomaticMedia[] = [];
  for (const id of value.assetIds) {
    const asset = assets.find(asset => asset.id === id);
    const path = asset?.store_path || (asset?.ext ? `asset.${asset.ext}` : undefined);
    if (!path) return;
    const type = isVideoPath(path) ? "video" : isAudioPath(path) ? "audio" : "image";
    if (!media.includes(type)) media.push(type);
  }
  return media;
}

export function canvasAutomaticOutputs(id: string, nodes: WorkflowNode[], canvas: CanvasNode[], materials: Material[], assets: Asset[], latest = false): AutomaticOutput[] {
  const workflow = nodes.find(node => node.id === id);
  if (workflow) return workflowOutputs(workflow).filter(port => port.type !== "session" && port.type !== "signal"
    && (port.id !== "iteration" || workflowOutputs(workflow).length === 1)).map(port => ({
      binding: { nodeId: id, portId: port.id }, type: port.type,
      ...(port.type === "image" ? { media: workflow.kind === "voice" ? "audio" as const : workflow.kind === "comfy-video" || workflow.generation?.media === "video" || workflow.kind === "agent" && workflow.skill === "hyperframes" ? "video" as const : "image" as const } : {}),
    }));
  const card = canvas.find(node => node.id === id && node.hiddenAt == null);
  if (card?.kind === "note") {
    const note = readCanvasNote(card);
    if (!["text", "images", "document", "bubble"].includes(note.note_type)) return [];
    if (note.note_type === "bubble") return [{ binding: { canvasNodeId: id, cellId: "*text" }, type: "text" }];
    const outputs: AutomaticOutput[] = [
      { binding: { canvasNodeId: id, cellId: latest ? "*latest" : "*text" }, type: "text" },
      { binding: { canvasNodeId: id, cellId: latest ? "*latest-image" : "*" }, type: "image" },
    ];
    const pending = nodes.filter(node => node.textTarget?.nodeId === id);
    const available = outputs.flatMap(output => {
      const value: WorkflowValue | undefined = canvasInputValue(card, output.binding.cellId!, canvas);
      const future = pending.some(node => !!node.textTarget?.image === (output.type === "image"));
      const present = output.type === "text" ? !!value?.text?.trim() : !!value?.assetIds?.length || !!value?.nodeIds?.length;
      const media = automaticValueMedia(value, assets, future);
      return present || future ? [{ ...output, ...(media ? { media } : {}) }] : [];
    });
    // Empty cards can be wired in advance, without inventing an empty second channel.
    return available.length ? available : outputs.filter(output => output.type === (note.cells.length && note.cells.flat().every(cell => cell.content_type === "image") ? "image" : "text"));
  }
  if (card?.kind === "prompt") {
    const media = automaticValueMedia(canvasInputValue(card, "image", canvas), assets);
    return [{ binding: { canvasNodeId: id, cellId: "image" }, type: "image", ...(media ? { media } : {}) }];
  }
  const material = materials.find(item => item.id === id || item.groupId === id);
  if (material?.groupId) {
    const assetIds = material.mediaAssetIds ?? material.assetIds;
    const media = automaticValueMedia({ type: "image", assetIds }, assets);
    return [{ binding: { groupId: material.groupId, assetIds }, type: "image", ...(media ? { media } : {}) }];
  }
  const assetId = material?.assetId ?? card?.assetId;
  if (!assetId) return [];
  const media = material?.video ? ["video" as const] : automaticValueMedia({ type: "image", assetIds: [assetId] }, assets);
  return [{ binding: { assetId, assetNodeId: material?.id ?? card?.id }, type: "image", ...(media ? { media } : {}) }];
}
