import type { WorkflowNode } from "../lib/canvasWorkflow";
import type { Asset } from "../lib/types";
import { workflowAssetMedia } from "../lib/workflowCanvasCapabilities";
import type { MaterialAnchor } from "./WorkflowLayerTypes";

export function resolveAssetMediaType(id: string, materialByAsset: ReadonlyMap<string, MaterialAnchor>, assets: ReadonlyMap<string, Asset>) {
  const material = materialByAsset.get(id);
  return material?.audio ? "audio" : material?.video ? "video" : workflowAssetMedia(assets.get(id));
}

export function hasTableWriter(nodes: readonly WorkflowNode[], nodeId: string, cellId?: string, matches?: (node: WorkflowNode) => boolean) {
  return nodes.some(node => node.textTarget?.nodeId === nodeId && node.textTarget.cellId === cellId && (!matches || matches(node)));
}
