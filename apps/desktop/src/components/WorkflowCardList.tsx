import { useMemo, useRef } from "react";
import { shallow } from "zustand/shallow";
import { agentOutputWriters } from "../lib/workflowAgentOutputs";
import { workflowInputProducers, workflowRuns, type WorkflowNode } from "../lib/canvasWorkflow";
import { sameWorkflowValue } from "../lib/workflowExternalChanges";
import { useLatestCallback } from "../lib/useCanvasFrame";
import { WorkflowCard, type CardContext } from "./WorkflowCard";

function useStableValue<T>(value: T, equal: (a: T, b: T) => boolean) {
  const previous = useRef(value);
  if (!equal(previous.current, value)) previous.current = value;
  return previous.current;
}

// Saving a document may normalize inputs or persist the measured layout. Neither
// creates a new card view when the editable definition is identical.
function useCardDefinitions(nodes: WorkflowNode[]) {
  const previous = useRef(new Map<string, { source: WorkflowNode; view: WorkflowNode }>());
  return useMemo(() => {
    const entries = new Map<string, { source: WorkflowNode; view: WorkflowNode }>();
    const byId = new Map<string, WorkflowNode>();
    for (const source of nodes) {
      const prior = previous.current.get(source.id);
      let entry = prior;
      if (!entry || source !== entry.source) {
        const { layoutSize: _measurement, ...definition } = source;
        const view = prior && sameWorkflowValue(definition, prior.view) ? prior.view : definition;
        entry = { source, view };
      }
      entries.set(source.id, entry);
      byId.set(source.id, entry.view);
    }
    previous.current = entries;
    return byId;
  }, [nodes]);
}

export function WorkflowCardList(context: CardContext) {
  const { props, layer } = context;
  const read = useLatestCallback(() => context);
  const { controller, document, renderedNodes, cardMounted, collapsedAnchor } = layer;
  const definitions = useCardDefinitions(renderedNodes);
  const names = useStableValue(layer.renderedNames, shallow);
  const history = useStableValue(workflowRuns(document), sameWorkflowValue);
  const shared = useMemo(() => ({}), [
    props.projectId, props.graphNodes, props.materials, props.panReady, props.onSelect, props.onNodeMenu,
    props.onOpenAgent, props.onOpenGeneration, props.onPeekInteraction, props.onToggleGenerationPin,
    props.onRemove, props.onDragStart, props.onDragMove, props.onDragEnd, props.onUndoGenerationConnection,
    props.getChatCardDefaults, props.onEdited, props.onNewAgentChat, props.onPlaced,
    layer.assets, layer.profiles, layer.state, layer.armed, layer.h3AutoOptimize, names, history,
    controller, controller.ready, controller.error,
  ]);

  // A connected card can display upstream output values, including content-card
  // writers. Agents also display connected output writers. Planners and templates inspect whole subgraphs.
  const sources = useMemo(() => {
    const nodes = Array.from(definitions.values());
    return new Map(nodes.map(node => {
      const inputs = Object.values(node.inputs).flat().flatMap(input => workflowInputProducers(nodes, input).map(id => definitions.get(id)));
      if (node.kind === "agent") inputs.push(...agentOutputWriters(node, nodes));
      return [node.id, node.kind === "planner" || node.templateInstance ? nodes : inputs];
    }));
  }, [definitions]);
  return renderedNodes.filter(node => node.kind !== "text" && (props.activeGenerationIds.has(node.id) ||
    (props.peekCard?.nodeId === node.id ? cardMounted(props.peekCard.anchorId) : cardMounted(node.id) && !collapsedAnchor(node.id)))).map(node => {
    const id = node.id;
    const failure = controller.cardFailure(id);
    const issue = (node.kind === "loop" || node.kind === "trigger" ? layer.flowIssues : layer.providerIssues).get(id);
    const keyIssue = node.trigger ? layer.flowIssues.get(id) : undefined;
    const activity = props.generationActivities.get(id);
    const offset = props.pinnedCardOffsets?.get(id);
    const peek = props.peekCard?.nodeId === id ? props.peekCard : undefined;
    const inputs = [
      ...sources.get(id)!, layer.nodeById.has(id), props.selectedIds.has(id), offset?.x, offset?.y,
      peek?.anchorId, peek?.point.x, peek?.point.y, layer.pendingAgentCards.has(id),
      layer.automatic?.id === id ? layer.automatic.side : null, layer.keyHover?.id === id, layer.staleReview === id,
      controller.startingAction(id), controller.isLocked(id), controller.canDiscardLocalVideo(id),
      failure?.key, failure?.dismissed, failure?.diagnostic, issue?.message, issue?.settings, keyIssue?.message,
      node.kind === "agent" ? layer.chatSummaries : undefined, node.kind === "loop" ? layer.providerIssues : undefined,
      activity?.running, activity?.session, activity?.jobId, activity?.failed, activity?.error, activity?.sessionStatus,
    ];
    return <WorkflowCard key={id} node={definitions.get(id)!} read={read} shared={shared} inputs={inputs} />;
  });
}
