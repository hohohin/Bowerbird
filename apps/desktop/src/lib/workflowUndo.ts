import { workflowRuns, type CanvasWorkflow, type WorkflowNode, type WorkflowRun } from "./canvasWorkflow.ts";

export interface WorkflowEditUndo {
  nodes: { id: string; before?: WorkflowNode; after?: WorkflowNode }[];
  removedRuns: WorkflowRun[];
  runOrder: string[];
}

/** Record only the nodes changed by a user edit, excluding background saves. */
export function workflowEditUndo(before: CanvasWorkflow, after: CanvasWorkflow): WorkflowEditUndo | null {
  const previous = new Map(before.nodes.map(node => [node.id, node]));
  const next = new Map(after.nodes.map(node => [node.id, node]));
  const nodes = [...new Set([...previous.keys(), ...next.keys()])].flatMap(id => {
    const before = previous.get(id), after = next.get(id);
    return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ id, before, after }];
  });
  if (!nodes.length) return null;
  const runs = new Set(workflowRuns(after).map(run => run.id));
  return structuredClone({ nodes, removedRuns: workflowRuns(before).filter(run => !runs.has(run.id)), runOrder: workflowRuns(before).map(run => run.id) });
}

/** Revert changed fields without rewinding other cards or newer execution results. */
export function restoreWorkflowEdit(nodes: WorkflowNode[], undo: WorkflowEditUndo): WorkflowNode[] {
  const changes = new Map(undo.nodes.map(change => [change.id, change]));
  const restored = nodes.flatMap(node => {
    const change = changes.get(node.id);
    if (!change) return [node];
    if (!change.before) return [];
    if (!change.after) return [node];
    const result = { ...node };
    for (const key of new Set([...Object.keys(change.before), ...Object.keys(change.after)]) as Set<keyof WorkflowNode>) {
      if (JSON.stringify(change.before[key]) === JSON.stringify(change.after[key])) continue;
      // Model completion may have replaced the output invalidated by this edit.
      if (key === "outputs" && JSON.stringify(node.outputs) !== JSON.stringify(change.after.outputs)) continue;
      if (key in change.before) Object.assign(result, { [key]: structuredClone(change.before[key]) });
      else delete result[key];
    }
    return [result];
  });
  const ids = new Set(nodes.map(node => node.id));
  return [...restored, ...undo.nodes.flatMap(change => change.before && !change.after && !ids.has(change.id) ? [structuredClone(change.before)] : [])];
}
