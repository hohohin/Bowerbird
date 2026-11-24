import type { CanvasPoint } from "./canvasLogic";

export const CANVAS_DRAG_Z_LIFT = 10000;

function curvePath(from: CanvasPoint, to: CanvasPoint, bend: number) {
  return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
}
export const canvasWirePath = (from: CanvasPoint, to: CanvasPoint) => curvePath(from, to, Math.max(50, Math.abs(to.x - from.x) * .45));
export const graphWirePath = (from: CanvasPoint, to: CanvasPoint) => curvePath(from, to, Math.max(48, Math.abs(to.x - from.x) * .42));

// Endpoint ownership follows the resolved visual socket, which can differ from the saved binding.
type End = CanvasPoint & { owner?: string };
export type DragOffset = { ids: ReadonlySet<string>; dx: number; dy: number };
type Draw = (from: CanvasPoint, to: CanvasPoint, drag?: DragOffset) => string;
interface Wire { from: End; to: End; draw: Draw; obstacles: boolean }
const wires = new WeakMap<SVGPathElement, Wire>();
export function dragWire(from: End, to: End, draw: Draw = canvasWirePath, obstacles = false) {
  return { d: draw(from, to), ref: (element: SVGPathElement | null) => {
    if (element) wires.set(element, { from, to, draw, obstacles });
  } };
}

/** Project a translation onto existing cards, their labels and incident curves until release.
 * A routed edge or live topology change hands the gesture back to the full layout. */
export function canvasDragPreview(plane: HTMLElement, ids: Set<string>, primary: string, invalidate: () => void) {
  if (plane.querySelector(".workflow-loop-frame")) return null;
  const items: HTMLElement[] = [], found = new Set<string>();
  const curves = new Map<SVGPathElement, Wire & { moveFrom: boolean; moveTo: boolean; original: string; last?: string }>();
  for (const el of plane.children) {
    if (!(el instanceof HTMLElement)) continue;
    const data = el.dataset;
    const id = data.canvasNodeId || data.workflowCard || data.workflowMaterial || data.cardName || data.workflowTextKey || data.canvasSelectionFrame;
    if (data.workflowPeekAnchor) {
      if (ids.has(data.workflowPeekAnchor)) items.push(el);
    } else if (id && ids.has(id)) {
      items.push(el);
      if (data.canvasNodeId || data.workflowCard) found.add(id);
    }
  }
  if (found.size !== ids.size) return null;
  const svg = plane.querySelector(".workflow-wires"), graph = plane.querySelector(".canvas-graph-edges");
  const movesMaterial = items.some(el => el.hasAttribute("data-workflow-material"));
  for (const el of plane.querySelectorAll<SVGPathElement>(".workflow-wires > path,.canvas-graph-edges > path")) {
    const wire = wires.get(el);
    if (!wire?.from.owner || !wire.to.owner) return null;
    const moveFrom = ids.has(wire.from.owner), moveTo = ids.has(wire.to.owner);
    if (moveFrom || moveTo || movesMaterial && wire.obstacles) curves.set(el, { ...wire, moveFrom, moveTo, original: el.getAttribute("d")! });
  }
  const observer = new MutationObserver(records => {
    if (records.some(record => record.type === "childList"
      ? [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element && !node.matches(".canvas-snap-guide,.canvas-cell-drop-target,[data-workflow-peek-anchor]"))
      : curves.get(record.target as SVGPathElement)?.last !== (record.target as SVGPathElement).getAttribute("d"))) invalidate();
  });
  observer.observe(plane, { childList: true });
  for (const layer of [svg, graph]) if (layer) observer.observe(layer, { subtree: true, childList: true, attributes: true, attributeFilter: ["d"] });
  const stage = plane.closest<HTMLElement>(".canvas-stage");
  stage?.setAttribute("data-overlay-scrollbars-suspended", "");
  const lifted = items.filter(el => el.hasAttribute("data-canvas-node-id") && !el.classList.contains("is-section")
    && (!el.classList.contains("canvas-chat-node") || el.dataset.canvasNodeId === primary)).map(el => {
    const z = el.style.zIndex;
    const level = String(CANVAS_DRAG_Z_LIFT + (Number(z) || 0));
    el.style.zIndex = level;
    const moving = el.matches(".canvas-node,.canvas-prompt-node,.canvas-agent-node");
    if (moving) el.classList.add("is-moving");
    return { el, z, level, moving };
  });
  return {
    move(dx: number, dy: number) {
      for (const el of items) el.style.translate = `${dx}px ${dy}px`;
      const offset = { ids, dx, dy };
      for (const [el, curve] of curves) {
        const { from, to, moveFrom, moveTo } = curve;
        const next = curve.draw(moveFrom ? { x: from.x + dx, y: from.y + dy } : from,
          moveTo ? { x: to.x + dx, y: to.y + dy } : to, offset);
        if (next !== (curve.last ?? curve.original)) el.setAttribute("d", next);
        curve.last = next;
      }
    },
    clear() {
      observer.disconnect();
      stage?.removeAttribute("data-overlay-scrollbars-suspended");
      for (const { el, z, level, moving } of lifted) {
        if (el.style.zIndex === level) el.style.zIndex = z;
        if (moving) el.classList.remove("is-moving");
      }
      for (const el of items) el.style.removeProperty("translate");
      for (const [el, curve] of curves) if (el.getAttribute("d") === curve.last) el.setAttribute("d", curve.original);
    },
  };
}
