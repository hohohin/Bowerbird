import { canvasPromptReferences } from "./creativeCanvas.ts";
import type { Asset, CanvasEdge, CanvasNode } from "./types";

/** Imported conversations retain their graph, but never the author's executable job/session. */
export function canvasConversationTurn(node: CanvasNode, nodes: readonly CanvasNode[], edges: readonly CanvasEdge[], assets: Map<string, Asset>) {
  if (node.kind !== "prompt") return null;
  let payload;
  try { payload = JSON.parse(node.payloadJson); } catch { return null; }
  if (!payload || payload.job_id || typeof payload.text !== "string") return null;
  const scopedNodes = nodes.filter(candidate => candidate.projectId === node.projectId);
  const scopedEdges = edges.filter(edge => edge.projectId === node.projectId);
  const references = canvasPromptReferences(node.id, scopedNodes, scopedEdges, assets);
  const inputEdges = scopedEdges.filter(edge => edge.toNodeId === node.id && ["input", "continued", "retry", "branch"].includes(edge.kind))
    .sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id));
  const referenceNodeIds = references.map(asset => inputEdges.map(edge => scopedNodes.find(candidate => candidate.id === edge.fromNodeId))
    .find(candidate => candidate?.assetId === asset.id)?.id ?? null);
  const outputs = scopedEdges.filter(edge => edge.fromNodeId === node.id && edge.kind === "produced")
    .sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id))
    .flatMap(edge => {
      const output = scopedNodes.find(candidate => candidate.id === edge.toNodeId);
      const asset = output?.assetId ? assets.get(output.assetId) : undefined;
      return asset ? [asset] : [];
    });
  return { node, text: payload.text as string, ratio: typeof payload.ratio === "string" ? payload.ratio : null,
    provider: typeof payload.provider === "string" ? payload.provider : "codex-cli",
    appliedPrompt: typeof payload.applied_prompt === "string" ? payload.applied_prompt : payload.text,
    references, referenceNodeIds, outputs };
}

export function canvasConversationTurns(selected: CanvasNode, nodes: readonly CanvasNode[], edges: readonly CanvasEdge[], assets: Map<string, Asset>) {
  return nodes.filter(node => node.projectId === selected.projectId
    && (selected.threadId ? node.threadId === selected.threadId : node.id === selected.id))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    // The shipped example includes removed early drafts whose source image was deleted before export.
    // Keep graph/data intact, but do not teach from an incomplete, already-hidden draft.
    .flatMap(node => {
      const turn = canvasConversationTurn(node, nodes, edges, assets);
      return turn && !(node.hiddenAt != null && turn.references.some(asset => !asset.store_path)) ? [turn] : [];
    });
}
