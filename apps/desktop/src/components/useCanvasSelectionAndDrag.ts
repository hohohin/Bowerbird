import { useState, useRef, type PointerEvent, type RefObject } from "react";
import { canvasDragPreview } from "../lib/canvasDragPreview";
import { canvasNodeIdsInRect, canvasRectFromPoints, exceedsCanvasDragThreshold, prepareCanvasSnapAnchors, snapCanvasRectPrepared,
  type CanvasPoint, type CanvasRect, type CanvasSnapAnchor, type CanvasSnapGuide, type PreparedCanvasSnapAnchors } from "../lib/canvasLogic";
import { readCanvasNote, canvasSectionMembers } from "../lib/canvasNotes";
import type { ProjectCanvasUiNode as CanvasNode } from "../lib/creativeCanvas";
import type { CanvasNode as ProjectGraphNode } from "../lib/types";
import type { WorkflowGeometry } from "./CanvasWorkflowLayer";

const CANVAS_SNAP_ENABLED_KEY = "bowerbird.canvasSnapEnabled";

interface DragProjection {
  preview?: ReturnType<typeof canvasDragPreview>;
  apply?: () => void;
}

interface CardDrag extends DragProjection {
  nodeId: string;
  selectedIds: Set<string>;
  initialWorkflow: WorkflowGeometry[];
  toggleSelection: boolean;
  snapAnchors?: PreparedCanvasSnapAnchors;
  crossedThreshold?: boolean;
  pointerId: number;
  offsetX: number;
  offsetY: number;
  startClientX: number;
  startClientY: number;
  moved: boolean;
}

export function clearDragProjection(drag: DragProjection | null) {
  if (!drag) return;
  drag.preview?.clear();
  drag.preview = null;
  drag.apply = undefined;
}

interface CanvasMarqueePress {
  origin: CanvasPoint;
  cursor: CanvasPointerSample;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  active: boolean;
  crossedThreshold?: boolean;
  additive: boolean;
  baseSelection: Set<string>;
}

export type CanvasPointerSample = Pick<PointerEvent<HTMLElement>, "pointerId" | "clientX" | "clientY" | "currentTarget">;
export function canvasPointerSample(event: PointerEvent<HTMLElement>): CanvasPointerSample {
  return { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, currentTarget: event.currentTarget };
}

interface SelectionOptions {
  stageRef: RefObject<HTMLDivElement>;
  planeRef: RefObject<HTMLDivElement>;
  panRef: { current: CanvasPoint };
  zoomRef: { current: number };
  toBoardPoint(clientX: number, clientY: number): CanvasPoint;
  graphNodes(): ProjectGraphNode[];
  selectionAnchors(materials?: CanvasNode[], graph?: ProjectGraphNode[]): CanvasSnapAnchor[];
  translateSelection(graph: ProjectGraphNode[], materials: CanvasNode[], workflow: WorkflowGeometry[], ids: Set<string>, dx: number, dy: number): void;
}

export function useCanvasSelectionAndDrag({ stageRef, planeRef, panRef, zoomRef, toBoardPoint, graphNodes, selectionAnchors, translateSelection }: SelectionOptions) {
  const [layoutDragId, setActiveDragId] = useState<string | null>(null);
  const [guides, setGuides] = useState<CanvasSnapGuide[]>([]);
  const [snapEnabled, setSnapEnabled] = useState(() => {
    try { return localStorage.getItem(CANVAS_SNAP_ENABLED_KEY) !== "false"; }
    catch { return true; }
  });
  const snapEnabledRef = useRef(snapEnabled);
  const marqueeElement = useRef<HTMLDivElement>(null);
  const [selectedCanvasNodeIds, setSelectedCanvasNodeIds] = useState<Set<string>>(() => new Set());
  const snapSizeObserverRef = useRef<ResizeObserver | null>(null);
  const marqueePressRef = useRef<CanvasMarqueePress | null>(null);
  const selectedCanvasNodeIdsRef = useRef(selectedCanvasNodeIds);
  const nodeDragRef = useRef<(CardDrag & { initialNodes: CanvasNode[]; initialGraphNodes: ProjectGraphNode[] }) | null>(null);
  const graphNodeDragRef = useRef<(CardDrag & { initialNodes: ProjectGraphNode[]; initialMaterialNodes: CanvasNode[] }) | null>(null);
  selectedCanvasNodeIdsRef.current = selectedCanvasNodeIds;
  const activeDragId = layoutDragId ?? (nodeDragRef.current?.moved ? nodeDragRef.current.nodeId
    : graphNodeDragRef.current?.moved ? graphNodeDragRef.current.nodeId : null);
  function translateDrag(drag: CardDrag, materials: CanvasNode[], graph: ProjectGraphNode[],
    workflowGeometry: WorkflowGeometry[], dx: number, dy: number) {
    const apply = () => {
      translateSelection(graph, materials, workflowGeometry, drag.selectedIds, dx, dy);
    };
    if (drag.preview === undefined) {
      const plane = planeRef.current;
      // Folder names belong to the group ID; use the full layout for that two-identity case.
      drag.preview = plane && !materials.some(node => node.kind === "folder" && drag.selectedIds.has(node.id))
        ? canvasDragPreview(plane, drag.selectedIds, drag.nodeId, () => {
          const pending = drag.apply;
          clearDragProjection(drag);
          setActiveDragId(drag.nodeId);
          pending?.();
        }) : null;
      if (!drag.preview) setActiveDragId(drag.nodeId);
    }
    if (drag.preview) { drag.apply = apply; drag.preview.move(dx, dy); }
    else apply();
  }

  function showDragGuides(next: CanvasSnapGuide[]) {
    setGuides(old => old.length === next.length && old.every((guide, i) =>
      guide.axis === next[i].axis && guide.position === next[i].position) ? old : next);
  }

  function observeSnapSizes() {
    if (snapSizeObserverRef.current) return;
    const observer = new ResizeObserver(() => {
      // Workflow results can grow a stationary card while another card is being dragged.
      if (nodeDragRef.current) nodeDragRef.current.snapAnchors = undefined;
      if (graphNodeDragRef.current) graphNodeDragRef.current.snapAnchors = undefined;
    });
    stageRef.current?.querySelectorAll("[data-workflow-card]").forEach(card => observer.observe(card));
    snapSizeObserverRef.current = observer;
  }

  function toggleCanvasNodeSelection(nodeId: string) {
    setSelectedCanvasNodeIds((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }

  function dragTo(drag: CardDrag, rect: CanvasRect,
    origin: CanvasPoint, materials: CanvasNode[], graph: ProjectGraphNode[]) {
    if (snapEnabledRef.current) observeSnapSizes();
    const snapped = snapCanvasRectPrepared(rect,
      snapEnabledRef.current ? drag.snapAnchors ??= prepareCanvasSnapAnchors(selectionAnchors(materials, graph).filter(node => !drag.selectedIds.has(node.id))) : { ordered: [] },
      { enabled: snapEnabledRef.current, zoom: zoomRef.current });
    showDragGuides(snapped.guides);
    translateDrag(drag, materials, graph, drag.initialWorkflow, snapped.x - origin.x, snapped.y - origin.y);
  }

  function beginMarquee(event: PointerEvent<HTMLDivElement>) {
    const press: CanvasMarqueePress = {
      pointerId: event.pointerId,
      origin: toBoardPoint(event.clientX, event.clientY),
      cursor: canvasPointerSample(event),
      startClientX: event.clientX,
      startClientY: event.clientY,
      active: false,
      additive: event.shiftKey || event.ctrlKey || event.metaKey,
      baseSelection: new Set(selectedCanvasNodeIds),
    };
    marqueePressRef.current = press;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function updateMarquee(event: CanvasPointerSample) {
    const marqueePress = marqueePressRef.current;
    if (marqueePress?.pointerId === event.pointerId) {
      if (!marqueePress.active) {
        if (!marqueePress.crossedThreshold && !exceedsCanvasDragThreshold(
          { x: marqueePress.startClientX, y: marqueePress.startClientY },
          { x: event.clientX, y: event.clientY },
          4,
        )) {
          return true;
        }
        marqueePress.active = true;
      }
      const stageRect = event.currentTarget.getBoundingClientRect();
      marqueePress.cursor = event;
      const pan = panRef.current, zoom = zoomRef.current;
      const selection = canvasRectFromPoints(marqueePress.origin, {
        x: (event.clientX - stageRect.left - pan.x) / zoom,
        y: (event.clientY - stageRect.top - pan.y) / zoom,
      });
      const overlay = marqueeElement.current;
      if (overlay) {
        overlay.hidden = false;
        overlay.style.left = `${selection.x * zoom + pan.x}px`;
        overlay.style.top = `${selection.y * zoom + pan.y}px`;
        overlay.style.width = `${selection.width * zoom}px`;
        overlay.style.height = `${selection.height * zoom}px`;
      }
      const sectionIds = new Set(graphNodes().filter(node => node.kind === "note"
        && readCanvasNote(node).note_type === "section").map(node => node.id));
      const selected = canvasNodeIdsInRect(
        selection,
        selectionAnchors().filter(anchor => !sectionIds.has(anchor.id) || canvasSectionMembers(selection, [anchor]).length > 0),
      );
      const next = new Set(
        marqueePress.additive ? [...marqueePress.baseSelection, ...selected] : selected,
      );
      setSelectedCanvasNodeIds(previous => previous.size === next.size && [...next].every(id => previous.has(id)) ? previous : next);
      return true;
    }
    return false;
  }

  function stopSnapObserver() {
    snapSizeObserverRef.current?.disconnect();
    snapSizeObserverRef.current = null;
  }

  function toggleSnapping() {
    const next = !snapEnabled;
    snapEnabledRef.current = next;
    setSnapEnabled(next);
    setGuides([]);
    try { localStorage.setItem(CANVAS_SNAP_ENABLED_KEY, String(next)); } catch { /* Storage may be unavailable. */ }
  }

  return { activeDragId, setActiveDragId, guides, setGuides, snapEnabled, snapEnabledRef, toggleSnapping,
    selectedCanvasNodeIds, setSelectedCanvasNodeIds, selectedCanvasNodeIdsRef, nodeDragRef, graphNodeDragRef,
    dragTo, stopSnapObserver, toggleCanvasNodeSelection, marqueeElement, marqueePressRef, beginMarquee, updateMarquee };
}
