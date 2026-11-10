import type { CanvasNode, ProjectCanvasSnapshot } from "./types";
import { canvasConversationCards } from "./canvasConversationCards";
import { containedSessionOutputIds, contentRoutedWorkflowSessionIds, hiddenWorkflowSessionIds } from "./canvasSessionOutputs";
import { readCanvasNote } from "./canvasNotes";
import { workflowCardWidth, type WorkflowNode } from "./canvasWorkflow";
import { placeCanvasCardNearSource } from "./canvasReferencePlacement";

export function workflowLayoutRect(node: WorkflowNode) {
  return { x: node.x, y: node.y, width: node.layoutSize?.width ?? workflowCardWidth(node),
    height: node.layoutSize?.height ?? (node.kind === "trigger" ? 92 : node.kind === "comfy-video" ? 360 : 280) };
}

export function workflowArrangementEdges(workflow: readonly WorkflowNode[]) {
  const visibleId = (id: string) => {
    const node = workflow.find(item => item.id === id);
    return node?.textSource ?? node?.textTarget?.nodeId ?? id;
  };
  return workflow.flatMap(node => [
    ...Object.values(node.inputs).flat().flatMap(input => input.nodeId || input.canvasNodeId
      ? [{ fromNodeId: visibleId(input.nodeId ?? input.canvasNodeId!), toNodeId: visibleId(node.id) }] : []),
    ...[...(node.sessionNodeIds ?? []), ...(node.resultNodeIds ?? []), ...(node.resultGroupId ? [node.resultGroupId] : [])]
      .map(id => ({ fromNodeId: visibleId(node.id), toNodeId: id })),
  ]);
}

/** Use the same folded/embedded projection as the canvas, never its hidden history. */
export function canvasOutputObstacles(canvas: ProjectCanvasSnapshot, workflow: readonly WorkflowNode[], exclude: ReadonlySet<string> = new Set()) {
  const archived = new Set(canvas.threads.filter(thread => thread.archivedAt != null).map(thread => thread.id));
  const grouped = new Set(canvas.groupItems.map(item => item.nodeId));
  const contained = new Set([...grouped, ...containedSessionOutputIds(canvas.nodes, workflow)]);
  const hidden = hiddenWorkflowSessionIds(workflow);
  const conversations = canvasConversationCards(canvas.nodes, {}, hidden, contained, contentRoutedWorkflowSessionIds(canvas.nodes, workflow));
  const visible = (node: CanvasNode) => node.hiddenAt == null && !exclude.has(node.id) && !contained.has(node.id)
    && !hidden.has(node.id) && !conversations.hiddenIds.has(node.id) && (!node.threadId || !archived.has(node.threadId))
    && !(node.kind === "note" && readCanvasNote(node).note_type === "section");
  return [...canvas.nodes.filter(visible).map(node => {
    const card = conversations.cards.get(node.id);
    if (node.kind !== "prompt" || !card?.outputs.length) return node;
    const latest = JSON.parse(card.latest.payloadJson), image = JSON.parse(card.outputs[card.outputs.length - 1].payloadJson).snapshot;
    const ratio = image?.width && image?.height ? image.height / image.width : 1;
    return { ...node, height: latest.status === "done" ? node.width * ratio : Math.max(node.height, 340) };
  }), ...canvas.groups.filter(group => !exclude.has(group.id)),
    ...workflow.filter(node => node.kind !== "text" && !exclude.has(node.id)).map(workflowLayoutRect)];
}

export function placeWorkflowOutput(canvas: ProjectCanvasSnapshot, workflow: readonly WorkflowNode[], source: WorkflowNode,
  size: { width: number; height: number }, exclude: ReadonlySet<string> = new Set()) {
  const rect = workflowLayoutRect(workflow.find(node => node.id === source.id) ?? source), x = rect.x + rect.width + 64;
  return placeCanvasCardNearSource({ x, y: rect.y, ...size }, canvasOutputObstacles(canvas, workflow, exclude), x);
}
