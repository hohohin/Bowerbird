import type { CanvasPoint, CanvasRect } from "./canvasLogic";

interface CanvasCellHitEntry {
  cellId: string;
  rect: CanvasRect;
}
const cellSelector = "[data-canvas-cell]";
const maxCachedCards = 12;

/** Measure only candidate content cards. Callers apply graph visibility, locks and z-order. */
export function createCanvasCellHitCache(
  toBoardPoint: (clientX: number, clientY: number) => CanvasPoint,
  getZoom: () => number,
) {
  type CardCache = ReturnType<typeof observeCard>;
  const cards = new Map<HTMLElement, CardCache>();
  let disposed = false;

  function observeCard(card: HTMLElement) {
    let dirty = true;
    let cells = new Set<HTMLElement>();
    let entries: CanvasCellHitEntry[] = [];
    const invalidate = () => { dirty = true; };
    const sizes = new ResizeObserver(invalidate);
    sizes.observe(card);
    const position = new MutationObserver(invalidate);
    position.observe(card, { attributes: true, attributeFilter: ["style", "class"] });
    const topology = new MutationObserver(records => { if (cellTopologyChanged(records)) invalidate(); });
    topology.observe(card, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-canvas-cell"] });
    card.addEventListener("scroll", invalidate, true);

    return {
      get(fresh: boolean) {
        if (!fresh && !dirty && !position.takeRecords().length && !cellTopologyChanged(topology.takeRecords())) return entries;
        const zoom = getZoom();
        if (!Number.isFinite(zoom) || zoom <= 0) { dirty = true; return []; }
        const origin = toBoardPoint(0, 0);
        const nextCells = new Set(card.querySelectorAll<HTMLElement>(cellSelector));
        entries = [...nextCells].flatMap(element => {
          const cellId = element.dataset.canvasCell;
          if (!cellId) return [];
          const { left, top, width, height } = element.getBoundingClientRect();
          return [{ cellId, rect: { x: origin.x + left / zoom, y: origin.y + top / zoom, width: width / zoom, height: height / zoom } }];
        });
        for (const element of cells) if (!nextCells.has(element)) sizes.unobserve(element);
        for (const element of nextCells) if (!cells.has(element)) sizes.observe(element);
        cells = nextCells;
        dirty = false;
        position.takeRecords();
        topology.takeRecords();
        return entries;
      },
      dispose() {
        sizes.disconnect();
        position.disconnect();
        topology.disconnect();
        card.removeEventListener("scroll", invalidate, true);
      },
    };
  }

  return {
    get(card: HTMLElement, fresh = false): readonly CanvasCellHitEntry[] {
      if (disposed || !card.isConnected) return [];
      const cache = cards.get(card) ?? observeCard(card);
      cards.delete(card);
      cards.set(card, cache);
      if (cards.size > maxCachedCards) {
        const oldest = cards.keys().next().value!;
        cards.get(oldest)?.dispose();
        cards.delete(oldest);
      }
      return cache.get(fresh);
    },
    dispose() {
      disposed = true;
      for (const cache of cards.values()) cache.dispose();
      cards.clear();
    },
  };
}

function cellTopologyChanged(records: MutationRecord[]) {
  return records.some(record => record.type === "attributes" || [...record.addedNodes, ...record.removedNodes].some(
    node => node instanceof Element && (node.matches(cellSelector) || node.querySelector(cellSelector)),
  ));
}
