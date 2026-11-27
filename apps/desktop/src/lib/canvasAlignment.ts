export type CanvasAlignMode = "left" | "center-x" | "right" | "top" | "center-y" | "bottom" | "distribute-x" | "distribute-y";

export const CANVAS_ALIGN_NODES_EVENT = "bowerbird:canvas-align-nodes";

export interface CanvasAlignNodesEventDetail {
  projectId: string;
  nodeIds: string[];
  mode: CanvasAlignMode;
}

export interface CanvasAlignItem {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function computeCanvasAlignment(items: readonly CanvasAlignItem[], mode: CanvasAlignMode): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const distribute = mode === "distribute-x" || mode === "distribute-y";
  if (items.length < (distribute ? 3 : 2)) return positions;

  const horizontal = mode === "left" || mode === "center-x" || mode === "right" || mode === "distribute-x";
  const axis = horizontal ? "x" : "y";
  const size = horizontal ? "width" : "height";
  function setPosition(item: CanvasAlignItem, value: number) {
    const rounded = Math.round(value);
    if (rounded !== item[axis]) positions.set(item.id, { x: item.x, y: item.y, [axis]: rounded });
  }

  if (distribute) {
    const sorted = [...items].sort((a, b) => a[axis] - b[axis] || (a.id < b.id ? -1 : Number(a.id > b.id)));
    const first = sorted[0], last = sorted[sorted.length - 1];
    const totalSpan = last[axis] + last[size] - first[axis];
    const totalItemSize = sorted.reduce((sum, item) => sum + item[size], 0);
    const gap = (totalSpan - totalItemSize) / (sorted.length - 1);
    let position = first[axis] + first[size] + gap;
    for (const item of sorted.slice(1, -1)) {
      setPosition(item, position);
      position += item[size] + gap;
    }
    return positions;
  }

  let min = Infinity, max = -Infinity;
  for (const item of items) {
    min = Math.min(min, item[axis]);
    max = Math.max(max, item[axis] + item[size]);
  }
  for (const item of items) {
    switch (mode) {
      case "left": case "top": setPosition(item, min); break;
      case "center-x": case "center-y": setPosition(item, (min + max - item[size]) / 2); break;
      case "right": case "bottom": setPosition(item, max - item[size]); break;
    }
  }
  return positions;
}
