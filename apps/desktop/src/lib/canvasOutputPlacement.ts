import type { CanvasNode, ProjectCanvasSnapshot } from "./types";
import { canvasConversationCards } from "./canvasConversationCards";
import { containedSessionOutputIds, contentRoutedWorkflowSessionIds, hiddenWorkflowSessionIds, workflowGenerationResultAnchor } from "./canvasSessionOutputs";
import { readCanvasNote } from "./canvasNotes";
import { isWorkflowGenerationResult, workflowCardWidth, type WorkflowNode } from "./canvasWorkflow";
import { placeCanvasCardNearSource } from "./canvasReferencePlacement";

export function workflowLayoutRect(node: WorkflowNode) {
  return { x: node.x, y: node.y, width: node.layoutSize?.width ?? workflowCardWidth(node),
    height: node.layoutSize?.height ?? (node.kind === "trigger" ? 92 : node.kind === "comfy-video" ? 360 : 280) };
}

export function workflowArrangementEdges(workflow: readonly WorkflowNode[], canvas: readonly CanvasNode[], conversations: ReturnType<typeof canvasConversationCards>) {
  const byId = new Map(workflow.map(node => [node.id, node]));
  const visibleId = (id: string) => {
    const node = byId.get(id);
    return node?.textSource ?? node?.textTarget?.nodeId ?? id;
  };
  return workflow.flatMap(node => [
    ...Object.entries(node.inputs).flatMap(([port, inputs]) => inputs.flatMap(input => {
      const id = input.nodeId ?? input.canvasNodeId;
      if (!id) return [];
      const fromNodeId = visibleId(id), toNodeId = visibleId(node.id);
      const source = input.nodeId && byId.get(input.nodeId);
      if (source && !node.textTarget && node.kind !== "trigger" && port !== "signal" && isWorkflowGenerationResult(input, source)) {
        const result = workflowGenerationResultAnchor(source, canvas, conversations);
        if (result) return [{ fromNodeId, toNodeId: result.nodeId }, { fromNodeId: result.nodeId, toNodeId }];
      }
      return [{ fromNodeId, toNodeId }];
    })),
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
