import type { CatalogGraphAsset } from "./materialCatalog";

export interface GraphPoint { x: number; y: number }
export interface GraphCamera extends GraphPoint { scale: number }
export interface GraphNode extends GraphPoint { id: string; name: string; tagId?: string; count?: number; asset?: CatalogGraphAsset }
export interface GraphEdge { source: number; target: number }
export const GRAPH_MIN_ZOOM = .005;
export const GRAPH_UNTAGGED = "__catalog_untagged__";

export function graphPoint(index: number, spacing: number): GraphPoint {
  const angle = index * Math.PI * (3 - Math.sqrt(5));
  const radius = spacing * Math.sqrt(index + 1);
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

/** One asset node per identity; each saved membership contributes one edge.
 * Single-tag images surround their label; shared images bridge their labels.
 * Deterministic layout avoids an unbounded all-pairs physics loop on large libraries. */
export function buildMaterialGraph(assets: CatalogGraphAsset[], sections: { id: string; name: string; count: number }[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = sections.map((section, i) => ({ id: `tag:${section.id}`, tagId: section.id, name: section.name, count: section.count,
    ...(sections.length === 1 ? { x: 0, y: 0 } : graphPoint(i, 420)) }));
  const tags = new Map(nodes.map((node, i) => [node.tagId!, i]));
  const groups = new Map<string, number>();
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const asset of assets) {
    if (seen.has(asset.id)) continue;
    seen.add(asset.id);
    const ids = [...new Set(asset.tag_ids.length ? asset.tag_ids : [GRAPH_UNTAGGED])].sort();
    const parents = ids.flatMap(id => tags.has(id) ? [tags.get(id)!] : []);
    const group = JSON.stringify(ids), ordinal = groups.get(group) ?? 0;
    groups.set(group, ordinal + 1);
    const center = parents.reduce((point, index) => ({ x: point.x + nodes[index].x / parents.length, y: point.y + nodes[index].y / parents.length }), { x: 0, y: 0 });
    const angle = ordinal * Math.PI * (3 - Math.sqrt(5));
    const radius = (parents.length === 1 ? 100 : 20) + 32 * Math.sqrt(ordinal + 1);
    const index = nodes.length;
    nodes.push({ id: `asset:${asset.id}`, name: asset.name, asset, x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius });
    for (const parent of parents) edges.push({ source: parent, target: index });
  }
  return { nodes, edges };
}

export function fitGraph(points: GraphPoint[], width: number, height: number): GraphCamera {
  let minX = -100, maxX = 100, minY = -100, maxY = 100;
  for (const p of points) { minX = Math.min(minX, p.x - 95); maxX = Math.max(maxX, p.x + 95); minY = Math.min(minY, p.y - 65); maxY = Math.max(maxY, p.y + 65); }
  const scale = Math.max(GRAPH_MIN_ZOOM, Math.min(1.5, Math.max(80, width - 60) / (maxX - minX), Math.max(80, height - 200) / (maxY - minY)));
  return { x: width / 2 - (minX + maxX) / 2 * scale, y: height / 2 - (minY + maxY) / 2 * scale, scale };
}

export function zoomGraph(camera: GraphCamera, point: GraphPoint, factor: number): GraphCamera {
  const scale = Math.max(GRAPH_MIN_ZOOM, Math.min(3, camera.scale * factor));
  const ratio = scale / camera.scale;
  return { scale, x: point.x - (point.x - camera.x) * ratio, y: point.y - (point.y - camera.y) * ratio };
}
