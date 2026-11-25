import type { WorkflowInput, WorkflowNode } from "./canvasWorkflow";
import { sameWorkflowValue } from "./workflowExternalChanges";

const proDenial = "工作流卡片的创建、编辑和运行需要 Pro；已有结果仍可查看和导出";

export function isWorkflowProDenied(error: unknown): boolean {
  return (error instanceof Error ? error.message : error) === proDenial;
}

function isBindingSubsequence(before: WorkflowInput[], after: WorkflowInput[], renumber = false) {
  let cursor = 0;
  return after.every((binding, index) => {
    while (cursor < before.length) {
      const previous = before[cursor++];
      if (sameWorkflowValue(previous, binding)
        || renumber && binding.slot === index + 1 && sameWorkflowValue({ ...previous, slot: binding.slot }, binding)) return true;
    }
    return false;
  });
}

function removesOnlyBindings(before: WorkflowNode["inputs"], after: WorkflowNode["inputs"], renumber = false) {
  return Object.entries(after).every(([port, bindings]) =>
    isBindingSubsequence(before[port] ?? [], bindings, renumber && (port === "text" || port === "image")));
}

function editableFields({
  x: _x, y: _y, layoutSize: _layoutSize, inputs: _inputs, savedComfyAudio: _audio, savedComfyR2V: _r2v,
  outputs: _outputs, outputPorts: _outputPorts, sessionNodeIds: _sessions, activeSessionNodeId: _session,
  resultNodeIds: _results, resultGroupId: _group, completionSeen: _seen,
  describeCache: _described, profileCache: _profile, triggerSchedule, ...node
}: WorkflowNode) {
  if (!triggerSchedule) return node;
  const { status: _status, at, ...schedule } = triggerSchedule;
  return { ...node, triggerSchedule: { ...schedule, ...(typeof schedule.dailyAt !== "string" && { at }) } };
}

/** Native canvas_workflow_save remains authoritative. Match its cleanup rules for the UI precheck. */
export function workflowDefinitionRequiresPro(before: WorkflowNode[], after: WorkflowNode[]): boolean {
  const previous = before.filter(node => node.kind !== "text");
  const paidIds = new Set(previous.map(node => node.id));
  const previousById = new Map(before.map(node => [node.id, node]));
  let cursor = 0;
  for (const node of after) {
    if (node.kind === "text") {
      if (paidIds.has(node.id)) return true;
      if (Object.values(node.inputs).some(bindings => bindings.some(input => input.nodeId && paidIds.has(input.nodeId)))) {
        const old = previousById.get(node.id);
        if (!old || !sameWorkflowValue(old.textTarget, node.textTarget) || !removesOnlyBindings(old.inputs, node.inputs)) return true;
      }
      continue;
    }
    while (cursor < previous.length && previous[cursor].id !== node.id) cursor++;
    const old = previous[cursor++];
    if (!old) return true;
    const numbered = node.kind === "generation" || node.kind === "agent" || node.kind === "planner";
    if (!sameWorkflowValue(editableFields(old), editableFields(node))
      || !removesOnlyBindings(old.inputs, node.inputs, numbered)
      || !removesOnlyBindings(old.savedComfyR2V ?? {}, node.savedComfyR2V ?? {})
      || !isBindingSubsequence(old.savedComfyAudio ?? [], node.savedComfyAudio ?? [])) return true;
  }
  return false;
}
