import type { CanvasGroupNode, CanvasPoint } from "./canvasLogic";
import type {
  Asset,
  CanvasGroup,
  CanvasNode,
  CanvasEdge,
  CanvasNodeLayoutUpdate,
  CanvasViewInput,
  CreativeViewMode,
  NewCanvasGroup,
  NewCanvasNode,
  ProjectCanvasSnapshot,
  ProjectTimelineScope,
} from "./types";

export interface CanvasAssetSnapshot {
  /** 画板节点实例 id；同一中心素材可在一个项目画板中出现多次。 */
  id: string;
  assetId: string | null;
  name: string;
  thumbPath: string | null;
  storePath: string | null;
  width: number | null;
  height: number | null;
  /** 保留 execution/tombstone 等规范化 payload，移动节点时不得丢执行身份。 */
  payloadJson?: string;
}

export const CANVAS_REMOVE_NODES_EVENT = "bowerbird:canvas-remove-nodes";
export const CANVAS_ARRANGE_NODES_EVENT = "bowerbird:canvas-arrange-nodes";

export interface CanvasArrangeNodesEventDetail {
  projectId: string;
  nodeIds: string[];
}

export interface CanvasRemoveNodesEventDetail {
  projectId: string;
  nodeIds: string[];
}

export type ProjectCanvasUiNode = CanvasGroupNode<CanvasAssetSnapshot>;

/** Legacy JPEG thumbnails discard alpha; use browser-renderable originals on the canvas. */
export function canvasAssetMediaPath(asset: Pick<CanvasAssetSnapshot, "thumbPath" | "storePath">): string | null {
  const original = asset.storePath;
  if (original && (/\.(png|webp|gif|avif|svg|ico|bmp)(?:[?#].*)?$/i.test(original)
    || /^data:image\/(png|webp|gif|avif|svg\+xml|x-icon|bmp)[;,]/i.test(original))) {
    return original;
  }
  return asset.thumbPath ?? original;
}

/** The image area excludes the two border pixels and the 30px caption. */
export function canvasAssetNodeSize(asset: Pick<CanvasAssetSnapshot, "width" | "height">, width = 190) {
  const ratio = asset.width && asset.width > 0 && asset.height && asset.height > 0 ? asset.height / asset.width : 0.78;
  return { width, height: (width - 2) * ratio + 32 };
}

/** Parent images are stored as continued/retry/branch edges, not duplicate input edges. */
export function canvasPromptReferences(promptId: string, nodes: readonly CanvasNode[], edges: readonly CanvasEdge[], assets: Map<string, Asset>): Array<Asset & { referenceNames: string[] }> {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const seen = new Set<string>();
  return edges.filter(edge => ["input", "continued", "retry", "branch"].includes(edge.kind) && edge.toNodeId === promptId)
    .sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id))
    .flatMap(edge => {
      const node = byId.get(edge.fromNodeId);
      if (node?.kind !== "asset") return [];
      const id = node.assetId ?? node.id;
      if (seen.has(id)) return [];
      seen.add(id);
      const asset = node.assetId ? assets.get(node.assetId) : undefined;
      const snapshot = parseAssetPayload(node.payloadJson)?.snapshot;
      return [{ ...asset, id, name: snapshot?.name ?? asset?.name ?? "引用图",
        referenceNames: [asset?.name, asset?.origin_path?.split(/[\\/]/).pop(), asset?.store_path?.split(/[\\/]/).pop()]
          .filter((name): name is string => !!name),
        ext: asset?.ext ?? null,
        thumb_path: canvasAssetMediaPath({ thumbPath: asset?.thumb_path ?? null, storePath: asset?.duration ? null : asset?.store_path ?? null }),
        store_path: asset?.store_path ?? null } as Asset & { referenceNames: string[] }];
    });
}

/** Keep Agent launch prompts as history, with their group as the canvas card. */
export function agentPromptGroupMap(nodes: readonly CanvasNode[], edges: readonly CanvasEdge[]): Map<string, CanvasNode> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const groups = new Map<string, CanvasNode>();
  for (const edge of edges) {
    const prompt = byId.get(edge.fromNodeId);
    const group = byId.get(edge.toNodeId);
    if (edge.kind === "input" && prompt?.kind === "prompt" && group?.kind === "agent_group"
      && prompt.projectId === group.projectId && prompt.threadId === group.threadId) {
      groups.set(prompt.id, group);
    }
  }
  return groups;
}

export const DEFAULT_CANVAS_SOURCE_THUMBNAIL_SCALE = 2;

export function clampCanvasSourceThumbnailScale(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CANVAS_SOURCE_THUMBNAIL_SCALE;
  return Math.min(3, Math.max(1, Math.round(value)));
}

/** A larger thumbnail scale intentionally means fewer masonry columns. */
export function canvasSourceColumnCount(thumbnailScale: number): number {
  return 4 - clampCanvasSourceThumbnailScale(thumbnailScale);
}

export interface HydratedProjectCanvas {
  nodes: ProjectCanvasUiNode[];
  pan: CanvasPoint;
  zoom: number;
  sourceWidth: number | null;
  viewMode: CreativeViewMode;
}

interface AssetPayload {
  schema_version: 1;
  snapshot: {
    name: string;
    width?: number;
    height?: number;
  };
  execution?: unknown;
}

function parseAssetPayload(payloadJson: string): AssetPayload | null {
  try {
    const value = JSON.parse(payloadJson) as Partial<AssetPayload>;
    if (value.schema_version !== 1 || !value.snapshot || typeof value.snapshot.name !== "string") {
      return null;
    }
    return value as AssetPayload;
  } catch {
    return null;
  }
}

export function createCanvasAssetSnapshot(asset: Asset, nodeId: string): CanvasAssetSnapshot {
  return {
    id: nodeId,
    assetId: asset.id,
    name: asset.name,
    thumbPath: asset.thumb_path ?? null,
    storePath: asset.store_path ?? null,
    width: asset.width ?? null,
    height: asset.height ?? null,
  };
}

function rehydrateAssetSnapshot(
  snapshot: CanvasAssetSnapshot,
  assetById: Map<string, Asset>,
): CanvasAssetSnapshot {
  const asset = snapshot.assetId ? assetById.get(snapshot.assetId) : null;
  if (!asset) return snapshot;
  const next = {
    ...snapshot,
    name: asset.name,
    thumbPath: asset.thumb_path ?? null,
    storePath: asset.store_path ?? null,
    width: asset.width ?? snapshot.width,
    height: asset.height ?? snapshot.height,
  };
  return next.name === snapshot.name
    && next.thumbPath === snapshot.thumbPath
    && next.storePath === snapshot.storePath
    && next.width === snapshot.width
    && next.height === snapshot.height
    ? snapshot
    : next;
}

/** Asset queries and graph snapshots load independently. Refresh only the
 * material metadata when the authoritative asset scope arrives, preserving
 * optimistic layout and grouping that may be newer than the snapshot. */
export function rehydrateProjectCanvasAssets(
  nodes: ProjectCanvasUiNode[],
  assetById: Map<string, Asset>,
): ProjectCanvasUiNode[] {
  let changed = false;
  const next = nodes.map((node) => {
    if (node.kind === "asset") {
      const asset = rehydrateAssetSnapshot(node.asset, assetById);
      const size = asset.width && asset.height ? canvasAssetNodeSize(asset, node.width) : { width: node.width, height: node.height };
      if (asset === node.asset && size.height === node.height) return node;
      changed = true;
      return { ...node, asset, ...size };
    }
    let groupChanged = false;
    const assets = node.assets.map((snapshot) => {
      const asset = rehydrateAssetSnapshot(snapshot, assetById);
      if (asset !== snapshot) groupChanged = true;
      return asset;
    });
    if (!groupChanged) return node;
    changed = true;
    return { ...node, assets };
  });
  return changed ? next : nodes;
}

/**
 * The normalized execution graph and the interactive material layout are
 * loaded independently. Project graph edges must follow the optimistic UI
 * layout while a material (or its containing group) is being moved, rather
 * than waiting for the persisted graph snapshot to be read again.
 */
export function projectGraphNodesWithLiveLayout(
  graphNodes: readonly CanvasNode[],
  uiNodes: readonly ProjectCanvasUiNode[],
): CanvasNode[] {
  const layoutByNodeId = new Map<string, Pick<CanvasNode, "x" | "y" | "width" | "height" | "zIndex">>();

  for (const uiNode of uiNodes) {
    const layout = {
      x: uiNode.x,
      y: uiNode.y,
      width: uiNode.width,
      height: uiNode.height,
      zIndex: uiNode.order,
    };
    if (uiNode.kind === "asset") {
      layoutByNodeId.set(uiNode.id, layout);
      continue;
    }
    for (const asset of uiNode.assets) layoutByNodeId.set(asset.id, layout);
  }

  return graphNodes.map((node) => {
    const layout = layoutByNodeId.get(node.id);
    if (!layout
      || (node.x === layout.x
        && node.y === layout.y
        && node.width === layout.width
        && node.height === layout.height
        && node.zIndex === layout.zIndex)) {
      return node;
    }
    return { ...node, ...layout };
  });
}

export function assetPayloadJson(asset: CanvasAssetSnapshot) {
  const previous = asset.payloadJson ? parseAssetPayload(asset.payloadJson) : null;
  return JSON.stringify({
    ...(previous ?? {}),
    schema_version: 1,
    snapshot: {
      name: asset.name,
      ...(asset.width == null ? {} : { width: asset.width }),
      ...(asset.height == null ? {} : { height: asset.height }),
    },
  });
}

export function newProjectCanvasAssetNode(
  projectId: string,
  node: Extract<ProjectCanvasUiNode, { kind: "asset" }>,
): NewCanvasNode {
  return {
    id: node.id,
    projectId,
    threadId: null,
    kind: "asset",
    assetId: node.asset.assetId,
    role: "reference",
    payloadJson: assetPayloadJson(node.asset),
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    zIndex: node.order,
    positionLocked: false,
  };
}

export function projectCanvasNodeLayoutUpdate(
  node: Extract<ProjectCanvasUiNode, { kind: "asset" }>,
): CanvasNodeLayoutUpdate {
  return {
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    zIndex: node.order,
    positionLocked: false,
  };
}

export function newProjectCanvasGroup(
  projectId: string,
  group: Extract<ProjectCanvasUiNode, { kind: "folder" }>,
): NewCanvasGroup {
  return {
    id: group.id,
    projectId,
    name: "素材组",
    role: null,
    x: group.x,
    y: group.y,
    width: group.width,
    height: group.height,
    zIndex: group.order,
  };
}

export function projectCanvasGroupUpdate(
  persisted: CanvasGroup,
  group: Extract<ProjectCanvasUiNode, { kind: "folder" }>,
): CanvasGroup {
  return {
    ...persisted,
    x: group.x,
    y: group.y,
    width: group.width,
    height: group.height,
    zIndex: group.order,
  };
}

export function projectCanvasViewInput(
  projectId: string,
  pan: CanvasPoint,
  zoom: number,
  sourceWidth: number,
  workspaceWidth?: number,
  viewMode: CreativeViewMode = "canvas",
  focusedThreadId: string | null = null,
  timelineScope: ProjectTimelineScope = "focused",
  activeNodeId: string | null = null,
): CanvasViewInput {
  return {
    projectId,
    panX: pan.x,
    panY: pan.y,
    zoom,
    sourcePanelWidth: sourceWidth,
    workspaceWidth: workspaceWidth ?? null,
    activeNodeId,
    focusedThreadId,
    viewMode,
    timelineScope,
  };
}

/** Canvas groups have their own table and cannot be stored in
 * canvas_views.active_node_id, whose owner is a normalized canvas node. */
export function persistedProjectActiveNodeId(
  selectedId: string | null,
  graphNodes: readonly Pick<CanvasNode, "id">[],
): string | null {
  return selectedId && graphNodes.some((node) => node.id === selectedId)
    ? selectedId
    : null;
}

/** Exact asset identities needed to render a normalized project snapshot.
 * Browsing projections are intentionally not used because they paginate and
 * collapse generation sessions. */
export function projectCanvasAssetIds(
  nodes: readonly Pick<CanvasNode, "kind" | "assetId">[],
): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const node of nodes) {
    if (node.kind !== "asset" || !node.assetId || seen.has(node.assetId)) continue;
    seen.add(node.assetId);
    ids.push(node.assetId);
  }
  return ids;
}

export function isCanvasAssetHydrationCurrent(
  requestedEpoch: number,
  currentEpoch: number,
  requestedAssetIds: readonly string[],
  currentAssetIds: readonly string[],
): boolean {
  return requestedEpoch === currentEpoch
    && requestedAssetIds.length === currentAssetIds.length
    && requestedAssetIds.every((assetId, index) => assetId === currentAssetIds[index]);
}

function snapshotForNode(node: CanvasNode, assetById: Map<string, Asset>): CanvasAssetSnapshot | null {
  // Legacy deletions leave an unhidden tombstone; retain it in history, not on the canvas.
  if (node.kind !== "asset" || node.hiddenAt != null || node.assetId == null) return null;
  const payload = parseAssetPayload(node.payloadJson);
  if (!payload) return null;
  const asset = node.assetId ? assetById.get(node.assetId) : null;
  return {
    id: node.id,
    assetId: node.assetId,
    name: asset?.name ?? payload.snapshot.name,
    thumbPath: asset?.thumb_path ?? null,
    storePath: asset?.store_path ?? null,
    width: asset?.width ?? payload.snapshot.width ?? null,
    height: asset?.height ?? payload.snapshot.height ?? null,
    payloadJson: node.payloadJson,
  };
}

/** 把一个项目的规范化 SQLite 图（包含全部线程）投影成当前画板 UI 模型。 */
export function hydrateProjectCanvas(
  snapshot: ProjectCanvasSnapshot,
  assetById: Map<string, Asset>,
): HydratedProjectCanvas {
  const assetNodes = new Map<string, { node: CanvasNode; asset: CanvasAssetSnapshot }>();
  for (const node of snapshot.nodes) {
    const asset = snapshotForNode(node, assetById);
    if (asset) assetNodes.set(node.id, { node, asset });
  }
  const itemsByGroup = new Map<string, typeof snapshot.groupItems>();
  for (const item of snapshot.groupItems) {
    const items = itemsByGroup.get(item.groupId) ?? [];
    items.push(item);
    itemsByGroup.set(item.groupId, items);
  }
  const memberIds = new Set(snapshot.groupItems.map((item) => item.nodeId));
  const nodes: ProjectCanvasUiNode[] = [];
  for (const { node, asset } of assetNodes.values()) {
    if (!memberIds.has(node.id)) {
      const size = asset.width && asset.height ? canvasAssetNodeSize(asset, node.width) : { width: node.width, height: node.height };
      nodes.push({ kind: "asset", id: node.id, asset, x: node.x, y: node.y, ...size, order: node.zIndex });
    }
  }
  for (const group of snapshot.groups) {
    const assets = (itemsByGroup.get(group.id) ?? [])
      .sort((left, right) => left.ordinal - right.ordinal)
      .flatMap((item) => {
        const member = assetNodes.get(item.nodeId);
        return member ? [member.asset] : [];
      });
    if (assets.length === 0) continue;
    nodes.push({ kind: "folder", id: group.id, assets, x: group.x, y: group.y, width: group.width, height: group.height, order: group.zIndex });
  }
  nodes.sort((left, right) => left.order - right.order);
  return {
    nodes,
    pan: { x: snapshot.view?.panX ?? 0, y: snapshot.view?.panY ?? 0 },
    zoom: snapshot.view?.zoom ?? 1,
    sourceWidth: snapshot.view?.sourcePanelWidth ?? null,
    viewMode: snapshot.view?.viewMode ?? "canvas",
  };
}
