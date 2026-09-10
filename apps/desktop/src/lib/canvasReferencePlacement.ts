import type { CanvasRect } from "./canvasLogic";
import type { CanvasEdge, CanvasNode } from "./types";

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
