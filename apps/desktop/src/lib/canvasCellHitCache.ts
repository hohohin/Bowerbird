import type { CanvasPoint, CanvasRect } from "./canvasLogic";

export interface CanvasCellHitEntry {
  element: HTMLElement;
  targetId: string;
  cellId: string;
  rect: CanvasRect;
}

/** Geometry only: callers apply current graph visibility, locks and z-order at hit time. */
export function createCanvasCellHitCache(
  stage: HTMLElement,
  toBoardPoint: (clientX: number, clientY: number) => CanvasPoint,
  getZoom: () => number,
) {
  const cellSelector = "[data-canvas-cell]", cardSelector = "[data-canvas-node-id]";
  let dirty = true, disposed = false;
  let entries: CanvasCellHitEntry[] = [];
  let observed = new Set<Element>();
  const invalidate = () => { dirty = true; };
  const containsCell = (node: Node) => node instanceof Element
    && (node.matches(cellSelector) || !!node.querySelector(cellSelector));
  const changed = (records: MutationRecord[]) => {
    if (records.some(record => {
      const element = record.target instanceof Element ? record.target : record.target.parentElement;
      const card = element?.closest(cardSelector);
      // A camera transform is outside every card and must not invalidate board-space geometry.
      if (element && (observed.has(element) || (card && containsCell(card)))) return true;
      return record.type === "childList" && [...record.addedNodes, ...record.removedNodes].some(containsCell);
    })) invalidate();
  };
  const sizes = new ResizeObserver(invalidate);
  const mutations = new MutationObserver(changed);
  mutations.observe(stage, { subtree: true, childList: true, attributes: true,
    attributeFilter: ["style", "class", "data-canvas-cell", "data-canvas-node-id"] });
  stage.addEventListener("scroll", invalidate, true);

  return {
    get(fresh = false): readonly CanvasCellHitEntry[] {
      if (disposed) return [];
      changed(mutations.takeRecords());
      if (!fresh && !dirty) return entries;
      const nextObserved = new Set<Element>();
      const zoom = getZoom();
      entries = Array.from(stage.querySelectorAll<HTMLElement>(cellSelector)).flatMap(element => {
        const card = element.closest<HTMLElement>(cardSelector);
        const targetId = card?.dataset.canvasNodeId, cellId = element.dataset.canvasCell;
        if (!card || targetId === undefined || cellId === undefined) return [];
        nextObserved.add(card); nextObserved.add(element);
        const bounds = element.getBoundingClientRect();
        return [{ element, targetId, cellId, rect: { ...toBoardPoint(bounds.left, bounds.top),
          width: bounds.width / zoom, height: bounds.height / zoom } }];
      });
      for (const element of observed) if (!nextObserved.has(element)) sizes.unobserve(element);
      for (const element of nextObserved) if (!observed.has(element)) sizes.observe(element);
      observed = nextObserved;
      dirty = false;
      return entries;
    },
    invalidate,
    dispose() {
      disposed = true;
      mutations.disconnect(); sizes.disconnect();
      stage.removeEventListener("scroll", invalidate, true);
      observed.clear(); entries = [];
    },
  };
}
