import type { CanvasPoint, CanvasSnapAnchor } from "./canvasLogic";

/** Arrange selected cards and their visible downstream cards in connected columns. */
export function arrangeCanvasNodes(
  nodes: readonly CanvasSnapAnchor[],
  edges: readonly { fromNodeId: string; toNodeId: string }[],
  selectedIds: Iterable<string>,
): Map<string, CanvasPoint> {
  const ordered = [...nodes].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const byId = new Map(ordered.map((node) => [node.id, node]));
  const successors = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!byId.has(edge.fromNodeId) || !byId.has(edge.toNodeId) || edge.fromNodeId === edge.toNodeId) continue;
    const next = successors.get(edge.fromNodeId) ?? new Set<string>();
    next.add(edge.toNodeId);
    successors.set(edge.fromNodeId, next);
  }
  const roots = new Set(selectedIds);
  const depth = new Map(ordered.filter((node) => roots.has(node.id)).map((node) => [node.id, 0]));
  const queue = [...depth.keys()];
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index];
    for (const next of successors.get(id) ?? []) {
      if (depth.has(next)) continue;
      depth.set(next, depth.get(id)! + 1);
      queue.push(next);
    }
  }
  if (queue.length === 0) return new Map();

  // Infer columns from connections inside the complete selection, including when
  // both a parent and its child were selected. Repeating Arrange stays stable.
  const incoming = new Map(queue.map((id) => [id, 0]));
  for (const id of queue) {
    depth.set(id, 0);
    for (const next of successors.get(id) ?? []) incoming.set(next, incoming.get(next)! + 1);
  }
  const ready = ordered.filter((node) => incoming.get(node.id) === 0).map((node) => node.id);
  for (let index = 0; index < ready.length; index++) {
    const id = ready[index];
    for (const next of successors.get(id) ?? []) {
      depth.set(next, Math.max(depth.get(next)!, depth.get(id)! + 1));
      incoming.set(next, incoming.get(next)! - 1);
      if (incoming.get(next) === 0) ready.push(next);
    }
  }

  const moving = ordered.filter((node) => depth.has(node.id));
  const originX = Math.min(...moving.map((node) => node.rect.x));
  const originY = Math.min(...moving.map((node) => node.rect.y));
  const positions = new Map<string, CanvasPoint>();
  let x = originX;
  let height = 0;
  for (let level = 0; level <= Math.max(...depth.values()); level++) {
    const column = moving.filter((node) => depth.get(node.id) === level);
    let y = originY;
    for (const node of column) {
      positions.set(node.id, { x, y });
      y += node.rect.height + 32;
    }
    height = Math.max(height, y - originY - 32);
    x += Math.max(...column.map((node) => node.rect.width)) + 64;
  }

  // Shift the complete block below intersecting stationary cards, keeping its alignment.
  const width = x - originX - 64;
  const obstacles = ordered.filter((node) => !depth.has(node.id));
  let top = originY;
  for (;;) {
    const collisions = obstacles.filter(({ rect }) => originX < rect.x + rect.width + 32
      && originX + width + 32 > rect.x && top < rect.y + rect.height + 32
      && top + height + 32 > rect.y);
    if (collisions.length === 0) break;
    top = Math.max(...collisions.map(({ rect }) => rect.y + rect.height + 32));
  }
  for (const position of positions.values()) position.y += top - originY;
  return positions;
}
