import type { CanvasPoint } from "./canvasLogic";

export function canvasWirePath(from: CanvasPoint, to: CanvasPoint) {
  const bend = Math.max(50, Math.abs(to.x - from.x) * .45);
  return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
}

// Endpoint ownership follows the resolved visual socket, which can differ from the saved binding.
type End = CanvasPoint & { owner?: string };
const wires = new WeakMap<SVGPathElement, { from: End; to: End }>();
export const rememberDragWire = (from: End, to: End) => (element: SVGPathElement | null) => {
  if (element) wires.set(element, { from, to });
};

/** Project a translation onto existing cards, their labels and incident curves until release.
 * A routed edge or live topology change hands the gesture back to the full layout. */
export function canvasDragPreview(plane: HTMLElement, ids: Set<string>, invalidate: () => void) {
  if (plane.querySelector(".workflow-loop-frame,.canvas-graph-edges path")) return null;
  const items: HTMLElement[] = [], found = new Set<string>();
  const curves: { el: SVGPathElement; from: End; to: End; moveFrom: boolean; moveTo: boolean; original: string; last?: string }[] = [];
  for (const el of plane.children) {
    if (!(el instanceof HTMLElement)) continue;
    const data = el.dataset;
    const id = data.canvasNodeId || data.workflowCard || data.workflowMaterial || data.cardName || data.workflowTextKey;
    if (id && ids.has(id)) {
      items.push(el);
      if (data.canvasNodeId || data.workflowCard) found.add(id);
    }
  }
  if (found.size !== ids.size) return null;
  const svg = plane.querySelector(".workflow-wires"), graph = plane.querySelector(".canvas-graph-edges");
  for (const el of svg?.querySelectorAll("path") ?? []) {
    const wire = wires.get(el);
    if (!wire?.from.owner || !wire.to.owner) return null;
    const moveFrom = ids.has(wire.from.owner), moveTo = ids.has(wire.to.owner);
    if (moveFrom || moveTo) curves.push({ el, ...wire, moveFrom, moveTo, original: el.getAttribute("d")! });
  }
  const observer = new MutationObserver(records => {
    if (records.some(record => record.type === "childList"
      ? [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element && !node.matches(".canvas-snap-guide,.canvas-cell-drop-target"))
      : !curves.some(curve => curve.el === record.target && curve.last === curve.el.getAttribute("d")))) invalidate();
  });
  observer.observe(plane, { childList: true });
  for (const layer of [svg, graph]) if (layer) observer.observe(layer, { subtree: true, childList: true, attributes: true, attributeFilter: ["d"] });
  return {
    move(dx: number, dy: number) {
      for (const el of items) el.style.translate = `${dx}px ${dy}px`;
      for (const curve of curves) {
        const { el, from, to, moveFrom, moveTo } = curve;
        curve.last = canvasWirePath(moveFrom ? { x: from.x + dx, y: from.y + dy } : from,
          moveTo ? { x: to.x + dx, y: to.y + dy } : to);
        el.setAttribute("d", curve.last);
      }
    },
    clear() {
      observer.disconnect();
      for (const el of items) el.style.removeProperty("translate");
      for (const curve of curves) if (curve.el.getAttribute("d") === curve.last) curve.el.setAttribute("d", curve.original);
    },
  };
}
