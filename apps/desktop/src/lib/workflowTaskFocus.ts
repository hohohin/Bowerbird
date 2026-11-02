import type { CanvasWorkflow, WorkflowNode } from "./canvasWorkflow";
import type { ProjectFocusResolution } from "./projectActivity";

/** Workflow cards have no thread field; persisted execution ownership is authoritative. */
export function resolveWorkflowTaskFocus(
  document: CanvasWorkflow,
  nodeId: string | null,
  threadId: string | null,
  threadReady: boolean,
): ProjectFocusResolution<WorkflowNode> {
  const node = document.nodes.find(candidate => candidate.id === nodeId);
  if (!node) return { state: "pending", node: null };
  if (!threadReady || !threadId) return { state: "rejected", node: null };
  const runs = document.runs ?? (document.run ? [document.run] : []);
  const owned = runs.some(run => run.threadId === threadId
    && (run.order.includes(node.id) || Object.prototype.hasOwnProperty.call(run.steps, node.id)));
  return owned ? { state: "ready", node } : { state: "rejected", node: null };
}
