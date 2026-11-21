import type { CanvasPoint } from "./canvasLogic";

type WireBounds = Pick<DOMRect, "x" | "y" | "width" | "height">;

// Our absolute wire paths use M/C for curves and H/V for obstacle routing.
// The control points bound a Bézier curve without forcing SVG layout.
function wireBounds(path: SVGPathElement): WireBounds | undefined {
  const segments = path.getAttribute("d")?.trim().split(/(?=[MCHV])/);
  if (!segments?.[0]?.startsWith("M")) return;
  let x = 0, y = 0;
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (const segment of segments) {
    const command = segment[0];
    const values = segment.slice(1).trim().split(/[ ,]+/).map(Number);
    const size = command === "C" ? 6 : command === "M" ? 2 : 1;
    if (values.length !== size || values.some(value => !Number.isFinite(value))) return;
    if (command === "H") x = values[0];
    if (command === "V") y = values[0];
    for (let i = 0; i < values.length; i += 2) {
      if (size !== 1) { x = values[i]; y = values[i + 1]; }
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

// Keep DOM geometry, focus order, media and wire endpoints intact. Only skip
// painting cards well outside the stage; the real editor is always used in view.
export function canvasPaintWindow(plane: HTMLElement, stage: HTMLElement) {
  type Card = { parts: Set<HTMLElement>; x: number; y: number; w: number; h: number; clipped: boolean };
  const cards = new Map<string, Card>(), owners = new Map<HTMLElement, Card>();
  const wires = new Map<SVGPathElement, WireBounds>(), changedWires = new Set<SVGPathElement>();
  let width = stage.clientWidth, height = stage.clientHeight;
  let pan: CanvasPoint = { x: 0, y: 0 }, zoom = 1, pending = 0;
  const flag = "data-canvas-offscreen";
  function paint(nextPan = pan, nextZoom = zoom) {
    if (pending) cancelAnimationFrame(pending);
    pending = 0; pan = nextPan; zoom = nextZoom;
    // Include protruding labels/ports and enough runway for quick camera moves.
    const pad = 120 + 80 * zoom, left = (-pan.x - pad) / zoom, top = (-pan.y - pad) / zoom;
    const right = (width - pan.x + pad) / zoom, bottom = (height - pan.y + pad) / zoom;
    // The curve may enter the viewport with both endpoints offscreen. Its
    // board-space bounds change on a new path, never on a camera move.
    const fallback: SVGPathElement[] = [];
    for (const path of changedWires) {
      if (!path.isConnected) continue;
      const box = wireBounds(path);
      if (box) wires.set(path, box);
      else { path.removeAttribute(flag); fallback.push(path); }
    }
    // WebView2 returns a zero box for a hidden path.
    for (const path of fallback) wires.set(path, path.getBBox());
    changedWires.clear();
    for (const [path, box] of wires) {
      const outside = box.x + box.width < left || box.x > right || box.y + box.height < top || box.y > bottom;
      if (path.hasAttribute(flag) !== outside) path.toggleAttribute(flag, outside);
    }
    for (const card of cards.values()) {
      const clipped = card.w > 0 && card.h > 0 && (card.x + card.w < left || card.x > right || card.y + card.h < top || card.y > bottom);
      if (card.clipped === clipped) continue;
      card.clipped = clipped;
      for (const part of card.parts) part.toggleAttribute(flag, clipped);
    }
  }
  const schedule = () => { if (!pending) pending = requestAnimationFrame(() => paint()); };
  function locate(el: HTMLElement, card: Card) {
    // Materials and graph nodes use translate3d; workflow cards and plain
    // sections use left/top. The live multi-drag adds an individual translation.
    const base = el.style.transform ? new DOMMatrixReadOnly(el.style.transform) : null;
    const [dx, dy] = el.style.translate.split(" ");
    card.x = (parseFloat(el.style.left) || 0) + (base?.e ?? 0) + (parseFloat(dx) || 0);
    card.y = (parseFloat(el.style.top) || 0) + (base?.f ?? 0) + (parseFloat(dy) || 0);
  }
  const sizes = new ResizeObserver(entries => {
    for (const entry of entries) {
      const el = entry.target as HTMLElement, box = entry.borderBoxSize[0];
      if (el === stage) { width = stage.clientWidth; height = stage.clientHeight; }
      else {
        const card = owners.get(el);
        if (card && box) { card.w = box.inlineSize; card.h = box.blockSize; }
      }
    }
    schedule();
  });
  const positions = new MutationObserver(records => {
    for (const { target } of records) {
      if (target instanceof SVGPathElement) {
        if (wires.has(target)) { changedWires.add(target); schedule(); }
        continue;
      }
      const el = target as HTMLElement, card = owners.get(el);
      if (card) { locate(el, card); schedule(); }
    }
  });
  const idOf = ({ dataset:d }: HTMLElement) => d.canvasNodeId || d.workflowCard || d.workflowMaterial || d.cardName || d.workflowTextKey;
  function register(el: HTMLElement) {
    const id = idOf(el);
    if (!id) return;
    let card = cards.get(id);
    if (!card) { card = { parts: new Set(), x: NaN, y: NaN, w: 0, h: 0, clipped: false }; cards.set(id, card); }
    card.parts.add(el); el.toggleAttribute(flag, card.clipped);
    if (el.hasAttribute("data-canvas-node")) {
      owners.set(el, card); locate(el, card); sizes.observe(el);
    }
  }
  // React can replace a card or its detached title/hotspot during a gesture.
  const wireLayer = (node: Node): node is SVGSVGElement =>
    node instanceof SVGSVGElement && node.matches(".workflow-wires,.canvas-graph-edges");
  function watchWires(layer: SVGSVGElement) {
    for (const path of layer.children) if (path instanceof SVGPathElement) changedWires.add(path);
    topology.observe(layer, { childList:true });
    schedule();
  }
  const topology = new MutationObserver(records => {
    for (const record of records) {
      if (wireLayer(record.target)) {
        for (const path of record.removedNodes) if (path instanceof SVGPathElement) { wires.delete(path); changedWires.delete(path); path.removeAttribute(flag); }
        for (const path of record.addedNodes) if (path instanceof SVGPathElement) changedWires.add(path);
        schedule();
        continue;
      }
      for (const layer of record.removedNodes) if (wireLayer(layer)) {
        for (const path of layer.children) if (path instanceof SVGPathElement) { wires.delete(path); changedWires.delete(path); path.removeAttribute(flag); }
      }
      for (const layer of record.addedNodes) if (wireLayer(layer)) watchWires(layer);
      for (const el of record.removedNodes) if (el instanceof HTMLElement) {
        const id = idOf(el), card = id && cards.get(id);
        if (!card) continue;
        if (owners.delete(el)) { sizes.unobserve(el); card.w = card.h = 0; }
        card.parts.delete(el); el.removeAttribute(flag);
        if (!card.parts.size) cards.delete(id);
        schedule();
      }
      for (const el of record.addedNodes) if (el instanceof HTMLElement) register(el);
    }
  });
  sizes.observe(stage);
  for (const el of plane.children) {
    if (el instanceof HTMLElement) register(el);
    else if (wireLayer(el)) watchWires(el);
  }
  topology.observe(plane, { childList:true });
  positions.observe(plane, { attributes:true, attributeFilter:["style","d"], subtree:true });
  return { paint, dispose() {
    topology.disconnect(); sizes.disconnect(); positions.disconnect(); cancelAnimationFrame(pending);
    for (const card of cards.values()) for (const el of card.parts) el.removeAttribute(flag);
    for (const path of wires.keys()) path.removeAttribute(flag);
  } };
}
