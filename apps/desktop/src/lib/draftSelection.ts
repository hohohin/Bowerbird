export type DraftSelectionPoint = { x: number; y: number };
export type DraftSelectionBounds = { x: number; y: number; width: number; height: number };
/** Coordinates are document pixels until draftSelectionToLayer maps them to backing pixels. */
type DraftSelectionRegion = {
  x: number; y: number; pixelWidth: number; pixelHeight: number;
  /** Sorted half-open [left,right] pairs in grid coordinates; disjoint within each row. */
  rows: readonly (readonly number[])[];
};
export type DraftSelection = DraftSelectionBounds & { points?: readonly DraftSelectionPoint[]; region?: DraftSelectionRegion };
export type DraftSelectionMode = "replace" | "add" | "subtract";
export const DRAFT_SELECTION_MAX_POINTS = 2048;
export const DRAFT_SELECTION_MAX_RUNS = 65536;
const regionOutlines = new WeakMap<DraftSelectionRegion, string>();

const finitePoint = (point: DraftSelectionPoint) => Number.isFinite(point.x) && Number.isFinite(point.y);
const samePoint = (a: DraftSelectionPoint, b: DraftSelectionPoint) => Math.hypot(a.x - b.x, a.y - b.y) < 0.000001;

function boundedPoints(points: readonly DraftSelectionPoint[]): readonly DraftSelectionPoint[] {
  if (points.length <= DRAFT_SELECTION_MAX_POINTS) return points;
  const step = (points.length - 1) / (DRAFT_SELECTION_MAX_POINTS - 1);
  return Array.from({ length: DRAFT_SELECTION_MAX_POINTS }, (_, index) => points[Math.round(index * step)]);
}

/** Sampling is transient: keep the first/current point and thin long gestures before paths grow large. */
export function appendDraftLassoPoint(points: readonly DraftSelectionPoint[], point: DraftSelectionPoint, minDistance = 1): DraftSelectionPoint[] {
  const previous = points[points.length - 1];
  if (!finitePoint(point) || (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < Math.max(0, minDistance))) return points as DraftSelectionPoint[];
  const next = points.length >= DRAFT_SELECTION_MAX_POINTS ? boundedPoints(points).filter((_, index) => index % 2 === 0) : [...points];
  if (points.length >= DRAFT_SELECTION_MAX_POINTS && previous && !samePoint(next[next.length - 1], previous)) next.push({ ...previous });
  next.push({ x: point.x, y: point.y });
  return next;
}

export function draftSelectionBounds(selection: DraftSelection): DraftSelectionBounds {
  if (!selection.points?.length) return { x: selection.x, y: selection.y, width: selection.width, height: selection.height };
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
  for (const point of boundedPoints(selection.points)) {
    x = Math.min(x, point.x); y = Math.min(y, point.y); right = Math.max(right, point.x); bottom = Math.max(bottom, point.y);
  }
  return { x, y, width: right - x, height: bottom - y };
}

/** Closure is implicit. A zero signed area is valid for self-crossing even-odd paths. */
export function createDraftLasso(input: readonly DraftSelectionPoint[]): DraftSelection | null {
  const points: DraftSelectionPoint[] = [];
  for (const point of boundedPoints(input)) {
    if (finitePoint(point) && (!points.length || !samePoint(points[points.length - 1], point))) points.push({ x: point.x, y: point.y });
  }
  if (points.length > 1 && samePoint(points[0], points[points.length - 1])) points.pop();
  if (points.length < 3) return null;
  const a = points[0], b = points[1], dx = b.x - a.x, dy = b.y - a.y;
  if (!points.some(point => Math.abs(dx * (point.y - a.y) - dy * (point.x - a.x)) > Math.hypot(dx, dy) * 0.000001)) return null;
  return { ...draftSelectionBounds({ x: 0, y: 0, width: 0, height: 0, points }), points };
}

export function draftSelectionToLayer(selection: DraftSelection, layer: {
  x: number; y: number; width: number; height: number; canvas: { width: number; height: number };
}): DraftSelection {
  const sx = layer.canvas.width / layer.width, sy = layer.canvas.height / layer.height;
  return { x: (selection.x - layer.x) * sx, y: (selection.y - layer.y) * sy,
    width: selection.width * sx, height: selection.height * sy,
    ...(selection.points ? { points: boundedPoints(selection.points).map(point => ({ x: (point.x - layer.x) * sx, y: (point.y - layer.y) * sy })) } : {}),
    ...(selection.region ? { region: { ...selection.region, x: (selection.region.x - layer.x) * sx,
      y: (selection.region.y - layer.y) * sy, pixelWidth: selection.region.pixelWidth * sx, pixelHeight: selection.region.pixelHeight * sy } } : {}) };
}

function traceSelection(path: Pick<Path2D, "moveTo" | "lineTo" | "closePath" | "rect">, selection: DraftSelection) {
  if (selection.region) {
    const region = selection.region;
    region.rows.forEach((row, y) => {
      for (let index = 0; index < row.length; index += 2) path.rect(region.x + row[index] * region.pixelWidth,
        region.y + y * region.pixelHeight, (row[index + 1] - row[index]) * region.pixelWidth, region.pixelHeight);
    });
  } else if (selection.points) {
    const points = boundedPoints(selection.points);
    if (points.length < 3) return;
    path.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index++) path.lineTo(points[index].x, points[index].y);
    path.closePath();
  } else path.rect(selection.x, selection.y, Math.max(0, selection.width), Math.max(0, selection.height));
}

export function draftSelectionPath(selection: DraftSelection): Path2D {
  const path = new Path2D(); traceSelection(path, selection); return path;
}

export function draftSelectionSvgPath(selection: DraftSelection): string {
  if (selection.region) return regionOutline(selection.region);
  if (selection.points) {
    const points = boundedPoints(selection.points);
    return points.length >= 3 ? `${points.map((point, index) => `${index ? "L" : "M"}${point.x} ${point.y}`).join(" ")} Z` : "";
  }
  return `M${selection.x} ${selection.y} h${Math.max(0, selection.width)} v${Math.max(0, selection.height)} h${-Math.max(0, selection.width)} Z`;
}

/** Canvas naturally intersects the path with its backing store; out-of-canvas vertices stay intact. */
export function clipDraftSelection(context: CanvasRenderingContext2D, selection: DraftSelection | null): void {
  if (!selection) return;
  context.beginPath(); traceSelection(context, selection); context.clip("evenodd");
}

/** Half-open edges match the scanline mask: include left/top, exclude right/bottom. */
export function draftSelectionContains(selection: DraftSelection, x: number, y: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (selection.region) {
    const region = selection.region, row = region.rows[Math.floor((y - region.y) / region.pixelHeight)] ?? [];
    const column = (x - region.x) / region.pixelWidth;
    return row.some((left, index) => index % 2 === 0 && column >= left && column < row[index + 1]);
  }
  if (!selection.points) return x >= selection.x && y >= selection.y && x < selection.x + selection.width && y < selection.y + selection.height;
  const points = boundedPoints(selection.points);
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const a = points[previous], b = points[index];
    if ((a.y > y) !== (b.y > y) && x < a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y)) inside = !inside;
  }
  return inside;
}

/** Binary pixel-centre mask for a bounded tile/dirty rectangle, row-major with values 0 or 255. */
export function draftSelectionMask(selection: DraftSelection, bounds: DraftSelectionBounds): Uint8Array {
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger)
    || bounds.width < 0 || bounds.height < 0 || bounds.width > 4096 || bounds.height > 4096) throw new Error("选区像素范围无效");
  const mask = new Uint8Array(bounds.width * bounds.height);
  const fill = (row: number, left: number, right: number) => {
    const start = Math.max(0, Math.ceil(left - bounds.x - 0.5));
    const end = Math.min(bounds.width, Math.ceil(right - bounds.x - 0.5));
    if (end > start) mask.fill(255, row * bounds.width + start, row * bounds.width + end);
  };
  for (let row = 0; row < bounds.height; row++) {
    const spans = selectionSpans(selection, bounds.y + row + 0.5);
    for (let index = 0; index + 1 < spans.length; index += 2) fill(row, spans[index], spans[index + 1]);
  }
  return mask;
}

/** Intersections at one scanline, in selection coordinates. */
function selectionSpans(selection: DraftSelection, y: number): readonly number[] {
  if (selection.region) {
    const region = selection.region, row = region.rows[Math.floor((y - region.y) / region.pixelHeight)] ?? [];
    return row.map(x => region.x + x * region.pixelWidth);
  }
  if (!selection.points) return y >= selection.y && y < selection.y + selection.height
    ? [selection.x, selection.x + Math.max(0, selection.width)] : [];
  const points = boundedPoints(selection.points), intersections: number[] = [];
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const a = points[previous], b = points[index];
    if ((a.y > y) !== (b.y > y)) intersections.push(a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y));
  }
  return intersections.sort((a, b) => a - b);
}

function combineSpans(a: readonly number[], b: readonly number[], mode: "add" | "subtract"): number[] {
  const result: number[] = [];
  if (mode === "add") {
    let ai = 0, bi = 0;
    while (ai < a.length || bi < b.length) {
      const takeA = bi >= b.length || (ai < a.length && a[ai] <= b[bi]);
      const line = takeA ? a : b, index = takeA ? ai : bi;
      const left = line[index], right = line[index + 1];
      if (result.length && left <= result[result.length - 1]) result[result.length - 1] = Math.max(right, result[result.length - 1]);
      else result.push(left, right);
      if (takeA) ai += 2; else bi += 2;
    }
  } else {
    let bi = 0;
    for (let ai = 0; ai < a.length; ai += 2) {
      let left = a[ai]; const right = a[ai + 1];
      while (bi < b.length && b[bi + 1] <= left) bi += 2;
      for (let index = bi; index < b.length && b[index] < right; index += 2) {
        if (b[index] > left) result.push(left, Math.min(right, b[index]));
        left = Math.max(left, b[index + 1]);
        if (left >= right) break;
      }
      if (left < right) result.push(left, right);
    }
  }
  return result;
}

/** Pixel-centre grid is introduced only for boolean operations; primitives retain vector edges. */
export function combineDraftSelection(current: DraftSelection | null, incoming: DraftSelection | null,
  mode: DraftSelectionMode, bounds?: DraftSelectionBounds): DraftSelection | null {
  if (mode === "replace") return incoming;
  if (!incoming) return current;
  if (!current && mode === "add") return incoming;
  const empty: DraftSelection = { x: 0, y: 0, width: 0, height: 0, region: { x: 0, y: 0, pixelWidth: 1, pixelHeight: 1, rows: [] } };
  if (!current) return empty;
  const x = Math.floor(bounds?.x ?? Math.min(current.x, incoming.x));
  const y = Math.floor(bounds?.y ?? Math.min(current.y, incoming.y));
  const right = Math.ceil(bounds ? bounds.x + bounds.width : Math.max(current.x + current.width, incoming.x + incoming.width));
  const bottom = Math.ceil(bounds ? bounds.y + bounds.height : Math.max(current.y + current.height, incoming.y + incoming.height));
  const width = right - x, height = bottom - y;
  if (![x, y, width, height].every(Number.isSafeInteger) || width < 0 || height < 0 || width > 4096 || height > 4096)
    throw new Error("选区像素范围无效");
  const quantize = (selection: DraftSelection, scanY: number) => {
    const spans = selectionSpans(selection, scanY), result: number[] = [];
    for (let index = 0; index + 1 < spans.length; index += 2) {
      const left = Math.max(0, Math.ceil(spans[index] - x - 0.5));
      const end = Math.min(width, Math.ceil(spans[index + 1] - x - 0.5));
      if (left >= end) continue;
      if (result.length && left <= result[result.length - 1]) result[result.length - 1] = Math.max(end, result[result.length - 1]);
      else result.push(left, end);
    }
    return result;
  };
  const rows: number[][] = [];
  let minX = width, minY = height, maxX = 0, maxY = 0, runs = 0;
  for (let row = 0; row < height; row++) {
    const line = combineSpans(quantize(current, y + row + .5), quantize(incoming, y + row + .5), mode);
    runs += line.length / 2;
    if (runs > DRAFT_SELECTION_MAX_RUNS) throw new Error("选区轮廓过于复杂，请缩小范围后重试");
    rows.push(line);
    if (line.length) { minX = Math.min(minX, line[0]); maxX = Math.max(maxX, line[line.length - 1]); minY = Math.min(minY, row); maxY = row + 1; }
  }
  if (!maxY) return empty;
  return { x: x + minX, y: y + minY, width: maxX - minX, height: maxY - minY,
    region: { x, y: y + minY, pixelWidth: 1, pixelHeight: 1, rows: rows.slice(minY, maxY) } };
}

/** Inversion is always bounded by the document; an empty result stays an explicit selection. */
export function invertDraftSelection(current: DraftSelection | null, bounds: DraftSelectionBounds): DraftSelection {
  return combineDraftSelection(bounds, current ?? { x: 0, y: 0, width: 0, height: 0 }, "subtract", bounds)!;
}

/** Trace directed boundaries with selected pixels on the right, including holes and islands. */
function regionOutline(region: DraftSelectionRegion): string {
  const cached = regionOutlines.get(region);
  if (cached !== undefined) return cached;
  type Edge = { end: number; direction: number };
  // Region coordinates are integer grid indices, even after document-to-layer scaling.
  const stride = 4097, outgoing = new Map<number, Edge[]>();
  const addEdge = (x: number, y: number, endX: number, endY: number, direction: number) => {
    const start = y * stride + x, edges = outgoing.get(start) ?? [];
    edges.push({ end: endY * stride + endX, direction }); outgoing.set(start, edges);
  };
  let previous: readonly number[] = [];
  for (let y = 0; y <= region.rows.length; y++) {
    const row = region.rows[y] ?? [];
    const top = combineSpans(row, previous, "subtract"), bottom = combineSpans(previous, row, "subtract");
    for (let index = 0; index < top.length; index += 2) addEdge(top[index], y, top[index + 1], y, 0);
    for (let index = 0; index < bottom.length; index += 2) addEdge(bottom[index + 1], y, bottom[index], y, 2);
    for (let index = 0; index < row.length; index += 2) {
      addEdge(row[index], y + 1, row[index], y, 3);
      addEdge(row[index + 1], y, row[index + 1], y + 1, 1);
    }
    previous = row;
  }
  const takeEdge = (start: number, incoming: number): Edge => {
    const edges = outgoing.get(start)!;
    // Right turns keep diagonally touching selected pixels on separate closed contours.
    const priority = [1, 0, 3, 2];
    const index = edges.length === 1 ? 0 : priority.map(turn => edges.findIndex(edge => (edge.direction - incoming + 4) % 4 === turn)).find(index => index >= 0)!;
    const [edge] = edges.splice(index, 1);
    if (!edges.length) outgoing.delete(start);
    return edge;
  };
  const x = (vertex: number) => region.x + vertex % stride * region.pixelWidth;
  const y = (vertex: number) => region.y + Math.floor(vertex / stride) * region.pixelHeight;
  const commands: string[] = [];
  // Keep one iterator as edges are consumed; restarting it per island rescans deleted entries.
  for (const start of outgoing.keys()) {
    while (outgoing.has(start)) {
      commands.push(`M${x(start)} ${y(start)}`);
      let edge = takeEdge(start, 0);
      while (edge.end !== start) {
        const next = takeEdge(edge.end, edge.direction);
        // Merge collinear steps without breaking the subpath or resetting its dash phase.
        if (next.direction !== edge.direction) commands.push(edge.direction % 2 ? `V${y(edge.end)}` : `H${x(edge.end)}`);
        edge = next;
      }
      commands.push("Z");
    }
  }
  const path = commands.join(" "); regionOutlines.set(region, path); return path;
}
