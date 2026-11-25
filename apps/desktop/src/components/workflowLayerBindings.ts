import type { WorkflowNode } from "../lib/canvasWorkflow";
import type { ChatSummary } from "../lib/localChat";
import type { Asset } from "../lib/types";
import { workflowAssetMedia } from "../lib/workflowCanvasCapabilities";
import type { MaterialAnchor } from "./WorkflowLayerTypes";

export function findAgentChatSummary(node: WorkflowNode | undefined, summaries: Record<string, ChatSummary>, projectId: string) {
  if (node?.kind !== "agent") return undefined;
  return node.chatConversationId ? summaries[node.chatConversationId]
    : Object.values(summaries).find(chat => chat.projectId === projectId && chat.nodeId === node.id);
}

export function resolveAssetMediaType(id: string, materialByAsset: ReadonlyMap<string, MaterialAnchor>, assets: readonly Asset[]) {
  const material = materialByAsset.get(id);
  return material?.audio ? "audio" : material?.video ? "video" : workflowAssetMedia(assets.find(asset => asset.id === id));
}

export function hasTableWriter(nodes: readonly WorkflowNode[], nodeId: string, cellId?: string, matches?: (node: WorkflowNode) => boolean) {
  return nodes.some(node => node.textTarget?.nodeId === nodeId && node.textTarget.cellId === cellId && (!matches || matches(node)));
}
