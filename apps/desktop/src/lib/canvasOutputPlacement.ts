import type { CanvasNode, ProjectCanvasSnapshot } from "./types";
import { canvasConversationCards } from "./canvasConversationCards";
import { containedSessionOutputIds, contentRoutedWorkflowSessionIds, hiddenWorkflowSessionIds, workflowGenerationCardProjection, workflowGenerationResultAnchor } from "./canvasSessionOutputs";
import { readCanvasNote } from "./canvasNotes";
import { isWorkflowGenerationResult, workflowCardWidth, type CanvasWorkflow, type WorkflowNode } from "./canvasWorkflow";
import { placeCanvasCardNearSource } from "./canvasReferencePlacement";

export function workflowLayoutRect(node: WorkflowNode) {
  return { x: node.x, y: node.y, width: node.layoutSize?.width ?? workflowCardWidth(node),
    height: node.layoutSize?.height ?? (node.kind === "trigger" ? 92 : node.kind === "comfy-video" ? 360 : 280) };
}

export function workflowArrangementEdges(workflow: readonly WorkflowNode[], canvas: readonly CanvasNode[], conversations: ReturnType<typeof canvasConversationCards>,
  collapsedAnchors: ReadonlyMap<string, CanvasNode> = new Map()) {
  const byId = new Map(workflow.map(node => [node.id, node]));
  const visibleId = (id: string) => {
    const node = byId.get(id);
    return collapsedAnchors.get(id)?.id ?? node?.textSource ?? node?.textTarget?.nodeId ?? id;
  };
  return workflow.flatMap(node => [
    ...Object.entries(node.inputs).flatMap(([port, inputs]) => inputs.flatMap(input => {
      const id = input.nodeId ?? input.canvasNodeId;
      if (!id) return [];
      const fromNodeId = visibleId(id), toNodeId = visibleId(node.id);
      const source = input.nodeId && byId.get(input.nodeId);
      if (source && !node.textTarget && node.kind !== "trigger" && port !== "signal" && isWorkflowGenerationResult(input, source)) {
        const result = workflowGenerationResultAnchor(source, canvas, conversations);
        const resultId = collapsedAnchors.get(source.id)?.id ?? result?.nodeId;
        if (resultId) return [{ fromNodeId, toNodeId: resultId }, { fromNodeId: resultId, toNodeId }]
          .filter(edge => edge.fromNodeId !== edge.toNodeId);
      }
      return [{ fromNodeId, toNodeId }];
    })),
    ...[...(node.sessionNodeIds ?? []), ...(node.resultNodeIds ?? []), ...(node.resultGroupId ? [node.resultGroupId] : [])]
      .filter(id => (conversations.aliases.get(id) ?? id) !== collapsedAnchors.get(node.id)?.id)
      .map(id => ({ fromNodeId: visibleId(node.id), toNodeId: id })),
  ]);
}

function visibleOutputProjection(canvas: ProjectCanvasSnapshot, document: CanvasWorkflow) {
  const archived = new Set(canvas.threads.filter(thread => thread.archivedAt != null).map(thread => thread.id));
  const grouped = new Set(canvas.groupItems.map(item => item.nodeId));
  const contained = new Set([...grouped, ...containedSessionOutputIds(canvas.nodes, document.nodes)]);
  const active = canvas.nodes.filter(node => !node.threadId || !archived.has(node.threadId));
  const hidden = hiddenWorkflowSessionIds(document.nodes, active);
  const conversations = canvasConversationCards(active, {}, hidden, contained, contentRoutedWorkflowSessionIds(active, document.nodes));
  return { active, contained, hidden, conversations, ...workflowGenerationCardProjection(document, active, conversations, contained) };
}

/** Use the same folded/embedded projection as the canvas, never its hidden history. */
export function canvasOutputObstacles(canvas: ProjectCanvasSnapshot, workflow: readonly WorkflowNode[], exclude: ReadonlySet<string> = new Set()) {
  const { active, contained, hidden, conversations, anchors } = visibleOutputProjection(canvas, { schema_version: 1, nodes: [...workflow], run: null });
  const visible = (node: CanvasNode) => node.hiddenAt == null && !exclude.has(node.id) && !contained.has(node.id)
    && !hidden.has(node.id) && !conversations.hiddenIds.has(node.id)
    && !(node.kind === "note" && readCanvasNote(node).note_type === "section");
  return [...active.filter(visible).map(node => {
    const card = conversations.cards.get(node.id);
    if (node.kind !== "prompt" || !card?.outputs.length) return node;
    const image = JSON.parse(card.outputs[card.outputs.length - 1].payloadJson).snapshot;
    const ratio = image?.width && image?.height ? image.height / image.width : 1;
    return { ...node, height: node.width * ratio };
  }), ...canvas.groups.filter(group => !exclude.has(group.id)),
    ...workflow.filter(node => node.kind !== "text" && !exclude.has(node.id) && !anchors.has(node.id)).map(workflowLayoutRect)];
}

/** An H3 result replaces its own card on its first independent delivery. */
export function firstWorkflowVideoOutputPoint(canvas: ProjectCanvasSnapshot, document: CanvasWorkflow, source: WorkflowNode) {
  if (source.kind !== "comfy-video") return;
  const { active, contained, origins, exempt } = visibleOutputProjection(canvas, document);
  if (exempt.has(source.id) || active.some(node => node.kind === "asset" && !contained.has(node.id) && origins.get(node.id)?.id === source.id)) return;
  return { x: source.x, y: source.y };
}

export function placeWorkflowOutput(canvas: ProjectCanvasSnapshot, workflow: readonly WorkflowNode[], source: WorkflowNode,
  size: { width: number; height: number }, exclude: ReadonlySet<string> = new Set()) {
  const rect = workflowLayoutRect(workflow.find(node => node.id === source.id) ?? source), x = rect.x + rect.width + 64;
  return placeCanvasCardNearSource({ x, y: rect.y, ...size }, canvasOutputObstacles(canvas, workflow, exclude), x);
}
