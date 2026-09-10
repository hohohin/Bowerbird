export interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasRect extends CanvasPoint {
  width: number;
  height: number;
}

/** Search the visible canvas only; never push a new card beyond the viewport. */
export function canvasPlacementForNewCard(
  card: CanvasRect, viewport: CanvasRect, pan: CanvasPoint, zoom: number, obstacles: CanvasRect[],
): CanvasPoint | null {
  const left = (viewport.x - pan.x) / zoom;
  const top = (viewport.y - pan.y) / zoom;
  const right = left + viewport.width / zoom - card.width;
  const bottom = top + viewport.height / zoom - card.height;
  if (viewport.width <= 0 || viewport.height <= 0 || right < left || bottom < top) return null;
  const gap = 16 / zoom;
  const visible = obstacles.filter((other) => other.x + other.width + gap > left
    && other.x - gap < right + card.width && other.y + other.height + gap > top
    && other.y - gap < bottom + card.height);
  const fits = (x: number, y: number) => x >= left && x <= right && y >= top && y <= bottom
    && !visible.some((other) => x < other.x + other.width + gap && x + card.width + gap > other.x
      && y < other.y + other.height + gap && y + card.height + gap > other.y);
  if (fits(card.x, card.y)) return { x: card.x, y: card.y };
  // Obstacle edges plus viewport edges cover narrow spaces that a fixed grid could miss.
  const xs = [...new Set([left, right, ...visible.flatMap((other) => [other.x + other.width + gap, other.x - card.width - gap])])]
    .filter((x) => x >= left && x <= right).sort((a, b) => a - b);
  const ys = [...new Set([top, bottom, ...visible.flatMap((other) => [other.y + other.height + gap, other.y - card.height - gap])])]
    .filter((y) => y >= top && y <= bottom).sort((a, b) => a - b);
  for (const y of ys) for (const x of xs) if (fits(x, y)) return { x, y };
  return null;
}

/** Keep a visible card still; fit and center an off-screen card without zooming in. */
export function canvasViewForNewCard(card: CanvasRect, viewport: CanvasRect, pan: CanvasPoint, zoom: number) {
  if (viewport.width <= 0 || viewport.height <= 0 || card.width <= 0 || card.height <= 0) return null;
  const left = pan.x + card.x * zoom;
  const top = pan.y + card.y * zoom;
  if (left >= viewport.x && top >= viewport.y
    && left + card.width * zoom <= viewport.x + viewport.width
    && top + card.height * zoom <= viewport.y + viewport.height) return null;
  const nextZoom = clampCanvasZoom(Math.min(zoom, viewport.width / card.width, viewport.height / card.height));
  return {
    zoom: nextZoom,
    pan: {
      x: viewport.x + viewport.width / 2 - (card.x + card.width / 2) * nextZoom,
      y: viewport.y + viewport.height / 2 - (card.y + card.height / 2) * nextZoom,
    },
  };
}

export interface CanvasSnapAnchor {
  id: string;
  order: number;
  rect: CanvasRect;
}

export interface CanvasSnapGuide {
  axis: "x" | "y";
  position: number;
}

export interface CanvasSnapResult extends CanvasPoint {
  guides: CanvasSnapGuide[];
}

export interface CanvasGroupNodeBase extends CanvasRect {
  id: string;
  order: number;
}

export type CanvasGroupNode<T extends { id: string }> =
  | (CanvasGroupNodeBase & { kind: "asset"; asset: T })
  | (CanvasGroupNodeBase & { kind: "folder"; assets: T[] });

const SNAP_THRESHOLD = 12;

function overlapsOrNearlyTouches(
  aStart: number,
  aLength: number,
  bStart: number,
  bLength: number,
  threshold: number,
) {
  return Math.min(aStart + aLength, bStart + bLength) - Math.max(aStart, bStart) >= -threshold;
}

/**
 * 把正在移动的矩形吸附到已有矩形。anchor 按进入画布的顺序排序，距离相同的情况下
 * 优先使用更早进入画布的素材；anchor 本身永远不移动。
 */
export function snapCanvasRect(
  moving: CanvasRect,
  anchors: CanvasSnapAnchor[],
  threshold = SNAP_THRESHOLD,
): CanvasSnapResult {
  const ordered = [...anchors].sort((a, b) => a.order - b.order);
  let bestX: { distance: number; value: number; guide: number; order: number } | null = null;
  let bestY: { distance: number; value: number; guide: number; order: number } | null = null;

  function takeX(value: number, guide: number, order: number) {
    const distance = Math.abs(moving.x - value);
    if (distance > threshold) return;
    if (!bestX || distance < bestX.distance || (distance === bestX.distance && order < bestX.order)) {
      bestX = { distance, value, guide, order };
    }
  }

  function takeY(value: number, guide: number, order: number) {
    const distance = Math.abs(moving.y - value);
    if (distance > threshold) return;
    if (!bestY || distance < bestY.distance || (distance === bestY.distance && order < bestY.order)) {
      bestY = { distance, value, guide, order };
    }
  }

  for (const anchor of ordered) {
    const rect = anchor.rect;
    if (overlapsOrNearlyTouches(moving.y, moving.height, rect.y, rect.height, threshold)) {
      takeX(rect.x + rect.width, rect.x + rect.width, anchor.order);
      takeX(rect.x - moving.width, rect.x, anchor.order);
      takeX(rect.x, rect.x, anchor.order);
      takeX(rect.x + rect.width - moving.width, rect.x + rect.width, anchor.order);
    }
    if (overlapsOrNearlyTouches(moving.x, moving.width, rect.x, rect.width, threshold)) {
      takeY(rect.y + rect.height, rect.y + rect.height, anchor.order);
      takeY(rect.y - moving.height, rect.y, anchor.order);
      takeY(rect.y, rect.y, anchor.order);
      takeY(rect.y + rect.height - moving.height, rect.y + rect.height, anchor.order);
    }
  }

  const xSnap = bestX as { value: number; guide: number } | null;
  const ySnap = bestY as { value: number; guide: number } | null;
  const guides: CanvasSnapGuide[] = [];
  if (xSnap) guides.push({ axis: "x", position: xSnap.guide });
  if (ySnap) guides.push({ axis: "y", position: ySnap.guide });
  return {
    x: xSnap?.value ?? moving.x,
    y: ySnap?.value ?? moving.y,
    guides,
  };
}

/** 命中给定坐标下最上层的静止节点；同层时后进入画布的节点在上。 */
export function findCanvasHoverTarget<T extends CanvasSnapAnchor>(
  point: CanvasPoint,
  nodes: T[],
  excludedId?: string,
): T | null {
  const ordered = [...nodes].sort((a, b) => b.order - a.order);
  return ordered.find((node) => {
    if (node.id === excludedId) return false;
    const { x, y, width, height } = node.rect;
    return point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height;
  }) ?? null;
}

export function clampCanvasZoom(value: number) {
  return Math.min(2.4, Math.max(0.35, value));
}

/** 画板平移只接受中键，或按住空格时的左键。 */
export function isCanvasPanGesture(button: number, spacePressed: boolean) {
  return button === 1 || (button === 0 && spacePressed);
}

export function canvasPrimaryMaterialAction(
  creationModeOpen: boolean,
  generationEditorOpen: boolean,
): "compose" | "preview" {
  return creationModeOpen || generationEditorOpen ? "compose" : "preview";
}

export function canStartCanvasMarquee(
  button: number,
  creationModeOpen: boolean,
  generationEditorOpen: boolean,
  targetIsCanvasNode: boolean,
): boolean {
  return button === 0
    && canvasPrimaryMaterialAction(creationModeOpen, generationEditorOpen) === "preview"
    && !targetIsCanvasNode;
}

/** 给单击选择留出手部抖动容差，超过阈值后才进入节点拖动。 */
export function exceedsCanvasDragThreshold(
  start: CanvasPoint,
  current: CanvasPoint,
  threshold = 4,
) {
  return Math.hypot(current.x - start.x, current.y - start.y) >= threshold;
}

export function canvasRectFromPoints(start: CanvasPoint, end: CanvasPoint): CanvasRect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

/** Select every material card touched by a marquee in board coordinates. */
export function canvasNodeIdsInRect(
  selection: CanvasRect,
  nodes: readonly CanvasSnapAnchor[],
): string[] {
  const right = selection.x + selection.width;
  const bottom = selection.y + selection.height;
  return nodes.flatMap((node) => {
    const nodeRight = node.rect.x + node.rect.width;
    const nodeBottom = node.rect.y + node.rect.height;
    return node.rect.x <= right
      && nodeRight >= selection.x
      && node.rect.y <= bottom
      && nodeBottom >= selection.y
      ? [node.id]
      : [];
  });
}

/** Translate one selected set by a shared delta so its internal layout stays rigid. */
export function translateCanvasSelection<T extends CanvasPoint & { id: string }>(
  nodes: readonly T[],
  selectedIds: ReadonlySet<string>,
  dx: number,
  dy: number,
): T[] {
  if (selectedIds.size === 0 || (dx === 0 && dy === 0)) return [...nodes];
  return nodes.map((node) => selectedIds.has(node.id)
    ? { ...node, x: node.x + dx, y: node.y + dy }
    : node);
}

function uniqueAssets<T extends { id: string }>(assets: T[]) {
  const seen = new Set<string>();
  return assets.filter((asset) => {
    if (seen.has(asset.id)) return false;
    seen.add(asset.id);
    return true;
  });
}

/** 将画布内的移动素材并入静止目标；目标的位置保持不变。 */
export function mergeCanvasNodesIntoFolder<T extends { id: string }>(
  nodes: CanvasGroupNode<T>[],
  movingId: string,
  targetId: string,
  folderId: string,
  folderSize: { width: number; height: number },
): CanvasGroupNode<T>[] {
  const moving = nodes.find((node) => node.id === movingId);
  const target = nodes.find((node) => node.id === targetId);
  if (!moving || moving.kind !== "asset" || !target || moving.id === target.id) return nodes;
  if (target.kind === "folder") {
    return nodes
      .filter((node) => node.id !== moving.id)
      .map((node) => node.id === target.id
        ? { ...target, assets: uniqueAssets([...target.assets, moving.asset]) }
        : node);
  }
  return [
    ...nodes.filter((node) => node.id !== target.id && node.id !== moving.id),
    {
      kind: "folder",
      id: folderId,
      x: target.x,
      y: target.y,
      width: folderSize.width,
      height: folderSize.height,
      order: Math.min(target.order, moving.order),
      assets: uniqueAssets([target.asset, moving.asset]),
    },
  ];
}

/** 将瀑布流拖入的节点实例并入画布目标；同一拖拽实例不会重复加入。 */
export function mergeCanvasAssetsIntoTarget<T extends { id: string }>(
  nodes: CanvasGroupNode<T>[],
  targetId: string,
  incoming: T[],
  folderId: string,
  folderSize: { width: number; height: number },
): CanvasGroupNode<T>[] {
  const target = nodes.find((node) => node.id === targetId);
  if (!target) return nodes;
  const present = new Set(
    nodes.flatMap((node) => node.kind === "asset" ? [node.asset.id] : node.assets.map((asset) => asset.id)),
  );
  const additions = uniqueAssets(incoming).filter((asset) => !present.has(asset.id));
  if (additions.length === 0) return nodes;
  if (target.kind === "folder") {
    return nodes.map((node) => node.id === target.id
      ? { ...target, assets: uniqueAssets([...target.assets, ...additions]) }
      : node);
  }
  return [
    ...nodes.filter((node) => node.id !== target.id),
    {
      kind: "folder",
      id: folderId,
      x: target.x,
      y: target.y,
      width: folderSize.width,
      height: folderSize.height,
      order: target.order,
      assets: uniqueAssets([target.asset, ...additions]),
    },
  ];
}
