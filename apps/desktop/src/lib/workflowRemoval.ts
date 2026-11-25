import { invalidateWorkflow, type WorkflowNode } from "./canvasWorkflow";
import type { CanvasWorkflowController } from "./canvasWorkflowRuntime";

/** Content cells keep their stored value when their hidden input writer is disconnected. */
export function removeWorkflowNodes(nodes: WorkflowNode[], removedIds: Iterable<string> = []): WorkflowNode[] {
  const removed = new Set(removedIds);
  const remainingInputs = (inputs: WorkflowNode["inputs"]) => Object.fromEntries(Object.entries(inputs)
    .map(([port, bindings]) => [port, bindings.filter(binding => !binding.nodeId || !removed.has(binding.nodeId))]));
  let remaining = nodes;
  for (const id of removed) remaining = invalidateWorkflow(remaining, id);
  for (;;) {
    remaining = remaining.filter(node => !removed.has(node.id)).map(node => ({ ...node,
      inputs: remainingInputs(node.inputs),
      ...(node.savedComfyR2V && { savedComfyR2V: remainingInputs(node.savedComfyR2V) }),
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
    await controller.edit(nodes);
    return;
  }
  await controller.retrySave();
}
