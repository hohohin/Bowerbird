import { useMemo } from "react";
import { dragWire, graphWirePath } from "../lib/canvasDragPreview";
import type { CanvasRect } from "../lib/canvasLogic";
import type { ProjectCanvasUiNode } from "../lib/creativeCanvas";
import type { CanvasEdge, CanvasNode } from "../lib/types";

export function CanvasGraphEdges({ edges, materialNodes, selectedIds, cardMounted, nodeRect }: {
  edges: { edge: CanvasEdge; from: CanvasNode; to: CanvasNode }[];
  materialNodes: ProjectCanvasUiNode[];
  selectedIds: ReadonlySet<string>;
  cardMounted: (id: string) => boolean;
  nodeRect: (node: CanvasNode | ProjectCanvasUiNode) => CanvasRect;
}) {
  const materialOwner = useMemo(() => {
    const byId = new Map<string, ProjectCanvasUiNode>();
    for (const node of materialNodes) {
      if (!byId.has(node.id)) byId.set(node.id, node);
      if (node.kind === "folder") for (const asset of node.assets) {
        if (!byId.has(asset.id)) byId.set(asset.id, node);
      }
    }
    return byId;
  }, [materialNodes]);

  return <svg className="canvas-graph-edges" aria-hidden="true">
    {edges.map(({ edge, from, to }) => {
      const fromMaterial = materialOwner.get(from.id), toMaterial = materialOwner.get(to.id);
      const fromOwner = fromMaterial?.id ?? from.id, toOwner = toMaterial?.id ?? to.id;
      if (!cardMounted(fromOwner) || !cardMounted(toOwner)) return null;
      const source = nodeRect(fromMaterial ?? from), target = nodeRect(toMaterial ?? to);
      return <path
        key={edge.id}
        className={`is-${edge.kind}${selectedIds.has(fromOwner) || selectedIds.has(toOwner) ? " is-selected" : ""}`}
        {...dragWire({ x: from.x + (fromMaterial ? source.width : from.width), y: from.y + source.height / 2, owner: fromOwner },
          { x: to.x, y: to.y + target.height / 2, owner: toOwner }, graphWirePath)}
      />;
    })}
  </svg>;
}
