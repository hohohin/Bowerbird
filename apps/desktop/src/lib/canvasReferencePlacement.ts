import type { CanvasRect } from "./canvasLogic";
import type { CanvasEdge, CanvasNode } from "./types";

/** Resolve execution inputs through their visible card/group, not hidden output coordinates. */
export function canvasCardSourceRects(
  card: CanvasNode, edges: readonly CanvasEdge[], anchors: ReadonlyMap<string, CanvasRect>,
  aliases: ReadonlyMap<string, string>, newReferenceIds: ReadonlySet<string>,
): CanvasRect[] {
  const promptId = card.kind === "agent_group"
    ? edges.find(edge => edge.toNodeId === card.id && edge.kind === "input"
      && edge.projectId === card.projectId && edge.threadId === card.threadId)?.fromNodeId
    : card.id;
  const ids = new Set(edges.filter(edge => edge.toNodeId === promptId
    && edge.projectId === card.projectId && edge.threadId === card.threadId
    && !newReferenceIds.has(edge.fromNodeId))
    .sort((a, b) => a.ordinal - b.ordinal || a.fromNodeId.localeCompare(b.fromNodeId))
    .map(edge => aliases.get(edge.fromNodeId) ?? edge.fromNodeId));
  return [...ids].flatMap(id => id !== card.id && anchors.has(id) ? [anchors.get(id)!] : []);
}

/** Incremental placement in canvas units. The camera never determines collision resolution. */
export function placeCanvasCardNearSource(card: CanvasRect, obstacles: readonly CanvasRect[]) {
  const gap = 32;
  const fits = ({ x, y }: { x: number; y: number }) => !obstacles.some(other =>
    x < other.x + other.width + gap && x + card.width + gap > other.x
    && y < other.y + other.height + gap && y + card.height + gap > other.y);
  const origin = { x: card.x, y: card.y };
  if (fits(origin)) return origin;
  // Edge candidates also find narrow gaps; a distant unrelated node cannot set the origin.
  const candidates = obstacles.flatMap(other => {
    const left = other.x - card.width - gap, right = other.x + other.width + gap;
    const top = other.y - card.height - gap, bottom = other.y + other.height + gap;
    return [{ x: right, y: card.y }, { x: card.x, y: bottom }, { x: card.x, y: top }, { x: left, y: card.y },
      { x: right, y: bottom }, { x: right, y: top }, { x: left, y: bottom }, { x: left, y: top }];
  });
  const distance = (point: { x: number; y: number }) => (point.x - card.x) ** 2 + (point.y - card.y) ** 2;
  candidates.sort((a, b) => distance(a) - distance(b) || b.x - a.x || b.y - a.y);
  return candidates.find(fits)!; // The outermost obstacle edge always offers a free position.
}

/** Only automatic execution references first observed during this mount may follow
 * the initial card placement. Existing/dragged/locked/grouped references stay put. */
export function trackNewCanvasReferences(
  pending: Map<string, CanvasNode>,
  previous: readonly CanvasNode[],
  next: readonly CanvasNode[],
  groupedIds: ReadonlySet<string>,
): Map<string, CanvasNode> {
  const previousIds = new Set(previous.map((node) => node.id));
  return new Map(next.flatMap((node) => {
    if (node.kind !== "asset" || node.role !== "reference" || node.hiddenAt != null
      || node.positionLocked || groupedIds.has(node.id)
      || (!node.id.startsWith("gen-reference:") && !node.id.startsWith("agent-reference:"))) return [];
    const saved = pending.get(node.id);
    if (!saved && previousIds.has(node.id)) return [];
    if (saved && (saved.projectId !== node.projectId || saved.threadId !== node.threadId
      || saved.x !== node.x || saved.y !== node.y || saved.width !== node.width || saved.height !== node.height)) return [];
    return [[node.id, node] as const];
  }));
}

export function newReferencesForCanvasCard(
  card: CanvasNode,
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
  pending: ReadonlyMap<string, CanvasNode>,
): CanvasNode[] {
  const promptId = card.kind === "agent_group"
    ? edges.find((edge) => edge.toNodeId === card.id && edge.kind === "input"
      && edge.projectId === card.projectId && edge.threadId === card.threadId)?.fromNodeId
    : card.id;
  return edges.filter((edge) => edge.toNodeId === promptId && edge.kind === "input"
    && edge.projectId === card.projectId && edge.threadId === card.threadId)
    .sort((a, b) => a.ordinal - b.ordinal)
    .flatMap((edge) => {
      const node = nodes.find((candidate) => candidate.id === edge.fromNodeId);
      const saved = pending.get(edge.fromNodeId);
      return node && saved && node.projectId === card.projectId && node.threadId === card.threadId
        && node.hiddenAt == null && !node.positionLocked && node.x === saved.x && node.y === saved.y
        ? [node] : [];
    });
}

/** Match the repository's compact rows, using the final measured card position. */
export function placeNewCanvasReferences(
  card: CanvasRect,
  references: readonly CanvasNode[],
  obstacles: readonly CanvasRect[],
): CanvasNode[] {
  const occupied = [...obstacles, card];
  let column = 0;
  let y = card.y + card.height + 40;
  let rowHeight = 0;
  const advance = (height: number) => {
    rowHeight = Math.max(rowHeight, height);
    column += 1;
    if (column === 3) {
      column = 0;
      y += rowHeight + 40;
      rowHeight = 0;
    }
  };
  return references.map((node) => {
    let x = card.x + column * 230;
    while (occupied.some((other) => x < other.x + other.width + 32 && x + node.width + 32 > other.x
      && y < other.y + other.height + 32 && y + node.height + 32 > other.y)) {
      advance(node.height);
      x = card.x + column * 230;
    }
    const placed = { ...node, x, y };
    occupied.push(placed);
    advance(node.height);
    return placed;
  });
}
