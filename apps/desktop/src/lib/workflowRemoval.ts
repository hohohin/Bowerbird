import { invalidateWorkflow, type WorkflowNode } from "./canvasWorkflow";
import type { CanvasWorkflowController } from "./canvasWorkflowRuntime";

/** Content cells keep their stored value when their hidden input writer is disconnected. */
export function removeWorkflowNodes(nodes: WorkflowNode[], removedIds: Iterable<string> = []): WorkflowNode[] {
  const removed = new Set(removedIds);
  let remaining = nodes;
  for (const id of removed) remaining = invalidateWorkflow(remaining, id);
  for (;;) {
    remaining = remaining.filter(node => !removed.has(node.id)).map(node => ({ ...node,
      inputs: Object.fromEntries(Object.entries(node.inputs).map(([port, bindings]) => [port, bindings.filter(binding => !binding.nodeId || !removed.has(binding.nodeId))])),
    }));
    const emptyWriters = remaining.filter(node => node.kind === "text" && node.textTarget && !Object.values(node.inputs).flat().length);
    if (!emptyWriters.length) return remaining;
    for (const writer of emptyWriters) removed.add(writer.id);
  }
}

/** Repair an already-rejected optimistic deletion without reloading and losing newer edits. */
export async function retryWorkflowSave(controller: CanvasWorkflowController) {
  const nodes = removeWorkflowNodes(controller.document.nodes);
  if (JSON.stringify(nodes) !== JSON.stringify(controller.document.nodes)) {
    const before = controller.document;
    try { await controller.edit(nodes); }
    catch (error) {
      // The blocked save queue rejects after edit has updated the optimistic document.
      // Validation/lock errors before that point must still propagate.
      if (controller.document === before) throw error;
    }
  }
  await controller.retrySave();
}
