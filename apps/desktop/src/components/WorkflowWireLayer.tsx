import { canvasWirePath as path, dragWire, type DragOffset } from "../lib/canvasDragPreview";
import type { canvasConversationCards } from "../lib/canvasConversationCards";
import { contentInputPort } from "../lib/canvasContentInput";
import { readCanvasNote } from "../lib/canvasNotes";
import { canvasSessionImages, hiddenWorkflowSessionIds } from "../lib/canvasSessionOutputs";
import { generationInputNode, workflowBindingKey, workflowCardWidth, workflowPortY, type CanvasWorkflow, type WorkflowInput, type WorkflowNode } from "../lib/canvasWorkflow";
import type { CanvasNode } from "../lib/types";
import type { WorkflowDiagnostic } from "../lib/workflowDiagnostics";
import type { WorkflowPortTarget } from "../lib/useWorkflowPortGeometry";
import { workflowTriggerMode } from "../lib/workflowTriggerSchedule";
import type { AutomaticGesture, Connection, ConnectionMenuState, DisconnectTarget, MaterialAnchor, PendingConnectionCard } from "./CanvasWorkflowLayer";

interface WorkflowWireLayerProps {
  automatic: AutomaticGesture | null;
  cardMounted: (id: string) => boolean;
  cardPoint: (id: string, side: "input" | "output") => { x: number; y: number; owner: string; selected: boolean; } | null;
  chooseDisconnect: (target: DisconnectTarget, point: { x: number; y: number; }, quick?: boolean) => void;
  collapsedAnchor: (id: string) => CanvasNode | undefined;
  connection: Connection | null;
  connectionMenu: ConnectionMenuState | null;
  conversationCards: ReturnType<typeof canvasConversationCards> | undefined;
  cursor: React.MutableRefObject<{ x: number; y: number; }>;
  disconnectKey: (node: WorkflowNode, port: string, binding: WorkflowInput) => string;
  displayPoint: (node: WorkflowNode) => WorkflowNode | { x: number; y: number; };
  document: CanvasWorkflow;
  draftElement: React.RefObject<SVGPathElement>;
  embeddedPoint: (id: string, input?: boolean) => { x: number; y: number; owner: string; selected: boolean; } | null;
  frames: Map<string, { x: number; y: number; width: number; height: number; index: number; total: number; }>;
  generationResultAnchors: Map<string, { nodeId: string; cellId?: string; } | undefined>;
  graphById: Map<string, CanvasNode>;
  graphNodes: CanvasNode[];
  groupById: Map<string, MaterialAnchor>;
  materialById: Map<string, MaterialAnchor>;
  nodeDiagnostic: (nodeId: string) => WorkflowDiagnostic | undefined;
  outputPath: (from: { x: number; y: number; }, to: { x: number; y: number; }, drag?: DragOffset) => string;
  pending: PendingConnectionCard[];
  portRect: (node: CanvasNode | undefined, kind: WorkflowPortTarget["kind"], port: string, image?: boolean) => { x: number; y: number; width: number; height: number; } | undefined;
  renderedNodes: WorkflowNode[];
  scopedPoint: (id: string, side: "input" | "output", scope?: string) => { x: number; y: number; owner: string; selected: boolean; } | null;
  sourcePoint: (binding: WorkflowInput, receiver?: WorkflowNode) => { x: number; y: number; owner: string; selected: boolean; } | null;
  toBoardPoint: (clientX: number, clientY: number) => { x: number; y: number; };
  visibleGraphNodeIds: ReadonlySet<string> | undefined;
  wireElement: React.RefObject<SVGSVGElement>;
  wireSelected: (id: string | undefined) => boolean;
  workflowNodeMounted: (node: WorkflowNode) => boolean;
}

export function WorkflowWireLayer({
  automatic, cardMounted, cardPoint, chooseDisconnect, collapsedAnchor, connection, connectionMenu,
  conversationCards, cursor, disconnectKey, displayPoint, document, draftElement, embeddedPoint,
  frames, generationResultAnchors, graphById, graphNodes, groupById, materialById, nodeDiagnostic,
  outputPath, pending, portRect, renderedNodes, scopedPoint, sourcePoint, toBoardPoint,
  visibleGraphNodeIds, wireElement, wireSelected, workflowNodeMounted,
}: WorkflowWireLayerProps) {
  const automaticWires = new Set<string>();
  return <svg ref={wireElement} className="workflow-wires">
    {document.nodes.filter(node => workflowNodeMounted(node) && !collapsedAnchor(node.id) && (node.kind === "agent" || node.kind === "generation" && node.generation?.media !== "video")).flatMap(node => (node.sessionNodeIds ?? []).map(id => {
      const current = node.kind === "generation" && node.outputs.image?.nodeIds?.includes(id)
        ? generationResultAnchors.get(node.id) : undefined;
      const anchorId = current?.nodeId ?? conversationCards?.aliases.get(id) ?? id;
      const session = graphById.get(anchorId);
      const embedded = embeddedPoint(id, true);
      if (!embedded && (conversationCards?.routedIds.has(id) || visibleGraphNodeIds && !visibleGraphNodeIds.has(anchorId) && !materialById.has(anchorId))) return null;
      return session && cardMounted(anchorId) && <path key={`agent-session-${node.id}-${id}`} className={`is-image${wireSelected(node.id) || wireSelected(anchorId) ? " is-selected" : ""}`} data-workflow-session-link={id}
        data-workflow-generator={node.id} {...dragWire(cardPoint(node.id, "output")!, embedded ?? cardPoint(anchorId, "input")!)} />;
    }))}
    {document.nodes.filter(node => workflowNodeMounted(node) && !collapsedAnchor(node.id) && (node.kind === "generation" || node.kind === "comfy-video")).flatMap(node => {
      const hiddenSessions = hiddenWorkflowSessionIds([node]);
      if (!hiddenSessions.size) return [];
      return graphNodes.filter(session => hiddenSessions.has(session.id)).flatMap(session =>
        canvasSessionImages(session, graphNodes).flatMap(output => {
          const anchorId = conversationCards?.aliases.get(output.id) ?? output.id;
          const visible = materialById.get(anchorId) ?? conversationCards?.cards.get(anchorId)?.anchor;
          if (!visible || !cardMounted(visible.id) || output.hiddenAt != null || conversationCards?.hiddenIds.has(anchorId)) return [];
          return <path key={`generated-${node.id}-${output.id}`} className={`is-image${wireSelected(node.id) || wireSelected(visible.id) ? " is-selected" : ""}`} data-workflow-generated-link={output.id}
            data-workflow-generator={node.id} {...dragWire(cardPoint(node.id, "output")!, cardPoint(anchorId, "input")!, outputPath, true)} />;
        }));
    })}
    {document.nodes.filter(workflowNodeMounted).map(node => {
      const group = node.resultGroupId && groupById.get(node.resultGroupId);
      return group && cardMounted(group.id) && <path key={`group-${node.id}`} className={`is-image${wireSelected(node.id) || wireSelected(group.id) ? " is-selected" : ""}`} data-workflow-product-link={group.id} {...dragWire(cardPoint(node.id, "output")!, { x: group.x, y: group.y + group.height / 2, owner: group.id })} />;
    })}
    {document.nodes.filter(node => workflowNodeMounted(node) && !collapsedAnchor(node.id)).flatMap(node => (node.resultNodeIds ?? []).map(id => {
      const result = graphById.get(id);
      const type = node.kind === "voice" || node.kind === "comfy-video" || node.kind === "generation" || node.action === "layers" ? "image" : "text";
      return result && cardMounted(id) && <path key={id} className={`is-${type}${wireSelected(node.id) || wireSelected(id) ? " is-selected" : ""}`} data-workflow-result-link={id} {...dragWire(cardPoint(node.id, "output")!, cardPoint(result.id, "input")!, outputPath, true)} />;
    }))}
    {renderedNodes.filter(workflowNodeMounted).flatMap(node => Object.entries(node.kind === "comfy-video" ? generationInputNode(node).inputs : node.inputs).flatMap(([port, inputs]) => inputs.map((binding, index) => {
      if (node.kind === "trigger" && port === "completion" && workflowTriggerMode(node) !== "completion") return null;
      const automaticKey = binding.autoConnect && `${binding.autoConnect}:${node.textTarget?.nodeId ?? node.id}`;
      if (automaticKey && automaticWires.has(automaticKey)) return null;
      if (automaticKey) automaticWires.add(automaticKey);
      const frame = port === "text" ? frames.get(node.id) : undefined;
      const from = frame ? { x: frame.x + frame.width, y: frame.y + frame.height / 2, selected: wireSelected(binding.canvasNodeId) } : sourcePoint(binding, node);
      if (!from || ("owner" in from && from.owner && !cardMounted(from.owner))) return null;
      let to = node.kind === "trigger" ? { x: node.x, y: workflowPortY(node, "input", port) } : cardPoint(node.id, "input") ?? { x: node.x, y: node.y };
      if (port === "signal") {
        const card = node.textSource && graphById.get(node.textSource);
        if (node.textSource && !card) return null;
        const { x, y } = card || displayPoint(node);
        if (!collapsedAnchor(node.id)) to = { x: x + (card ? card.width : workflowCardWidth(node)) - 34, y: y - 18 };
      }
      if (node.textTarget) {
        const target = node.textTarget;
        const nativeCard = graphById.get(target.nodeId);
        const inputPort = nativeCard ? contentInputPort(readCanvasNote(nativeCard), target) : undefined;
        const rect = inputPort === undefined ? undefined : portRect(nativeCard, "input", inputPort, port === "image");
        const automaticPoint = binding.autoConnect && scopedPoint(target.nodeId, "input", target.cellId);
        if (automaticPoint) to = automaticPoint;
        else if (rect) to = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        else return null;
      }
      const diagnostic = nodeDiagnostic(node.id);
      const failedWire = diagnostic?.source && (workflowBindingKey(diagnostic.source) === workflowBindingKey(binding)
        || inputs.length === 1 && node.promptReferences?.some(ref => ref.type === port && ref.label === diagnostic.referenceLabel));
      return <path key={`${node.id}-${port}-${index}`} {...dragWire(from, { ...to, owner: node.textTarget?.nodeId ?? node.textSource ?? collapsedAnchor(node.id)?.id ?? node.id })} style={frame && !failedWire ? { stroke: "#66baff", opacity: 1 } : undefined} data-auto-connection={binding.autoConnect} data-workflow-target={node.id} data-workflow-signal-link={port === "signal" ? node.id : undefined} data-workflow-text-link={node.textTarget?.cellId} className={`is-${binding.autoConnect ? "automatic" : port}${failedWire ? " is-error" : ""}${from.selected || wireSelected(collapsedAnchor(node.id)?.id ?? node.id) ? " is-selected" : ""}`}
        onContextMenu={event => {
          if (!binding.autoConnect && port !== "signal") return;
          event.preventDefault(); event.stopPropagation();
          chooseDisconnect({ nodeId: node.textTarget?.nodeId ?? node.id, wireKey: disconnectKey(node, port, binding) }, { x: event.clientX, y: event.clientY });
        }} />;
    })))}
    {pending.filter(card => card.target.nodeId !== card.node.id).map(({ node, target, connectionId }) => {
      const from = cardPoint(node.id, "output"), to = scopedPoint(target.nodeId ?? target.canvasNodeId!, "input", target.cellId);
      return from && to && <path key={connectionId} data-auto-connection={connectionId} data-workflow-target={target.nodeId} className="is-automatic" d={path(from, to)} />;
    })}
    {connection && (() => { const from = sourcePoint(connection); return from && <path ref={draftElement} className="is-draft" d={path(from, toBoardPoint(cursor.current.x, cursor.current.y))} />; })()}
    {automatic?.dragged && !connectionMenu && (() => { const anchor = automatic.completion?.anchor ?? scopedPoint(automatic.id, automatic.side, automatic.scope) ?? toBoardPoint(automatic.start.x, automatic.start.y), point = toBoardPoint(cursor.current.x, cursor.current.y); return <path ref={draftElement} className="is-draft" data-workflow-completion-draft={automatic.completion ? "" : undefined} d={automatic.side === "output" ? path(anchor, point) : path(point, anchor)} />; })()}
  </svg>;
}
