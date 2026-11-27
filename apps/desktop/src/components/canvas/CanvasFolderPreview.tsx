import { Layers } from "lucide-react";
import type { MouseEvent, PointerEvent } from "react";
import { CanvasImage } from "../CanvasImage";
import { VideoPoster } from "../VideoPoster";
import type { CanvasMaterialFilterState } from "../../lib/canvasMaterialFilter";
import { canvasAssetMediaPath, type CanvasAssetSnapshot } from "../../lib/creativeCanvas";
import { isVideoPath } from "../../lib/videoGeneration";
import { useStore } from "../../store";
import type { CanvasFolderNode } from "./canvasWorkspaceHelpers";

export function FolderPreview({
  node,
  onAssetContextMenu,
  onAssetPointerDown,
  filterState,
}: {
  node: CanvasFolderNode;
  filterState: (asset: CanvasAssetSnapshot) => CanvasMaterialFilterState;
  onAssetContextMenu: (event: MouseEvent<HTMLElement>, asset: CanvasAssetSnapshot) => void;
  onAssetPointerDown: (event: PointerEvent<HTMLElement>, asset: CanvasAssetSnapshot) => void;
}) {
  const layerWorkspaceIds = useStore((state) => state.layerWorkspaceIds);
  return (
    <div className="canvas-folder-grid" aria-hidden="true">
      {node.assets.slice(0, 4).map((asset) => {
        const path = canvasAssetMediaPath(asset);
        return isVideoPath(asset.storePath) ? <VideoPoster key={asset.id} data-frequent-asset-id={asset.assetId ?? undefined} data-canvas-filter={filterState(asset)} path={asset.storePath} poster={asset.thumbPath} alt={asset.name} draggable={false} onPointerDown={event => onAssetPointerDown(event, asset)} onContextMenu={event => onAssetContextMenu(event, asset)} /> : path ? (
          <div key={asset.id} data-frequent-asset-id={asset.assetId ?? undefined} data-canvas-filter={filterState(asset)} className="relative min-h-0" onPointerDown={event => onAssetPointerDown(event, asset)} onContextMenu={(event) => onAssetContextMenu(event, asset)}>
            <CanvasImage
              path={asset.storePath} thumbPath={asset.thumbPath} sourceWidth={asset.width} sourceHeight={asset.height}
              alt=""
              draggable={false}
              loading="lazy"
            />
            {asset.assetId && layerWorkspaceIds.has(asset.assetId) && <span className="pointer-events-none absolute left-1 top-1 z-10 rounded-full bg-black/70 px-1.5 py-1 text-white backdrop-blur" title="有分层工程" aria-label="有分层工程"><Layers size={12} /></span>}
          </div>
        ) : (
          <span key={asset.id} data-frequent-asset-id={asset.assetId ?? undefined} data-canvas-filter={filterState(asset)} onPointerDown={event => onAssetPointerDown(event, asset)} onContextMenu={(event) => onAssetContextMenu(event, asset)}>
            {asset.name.slice(0, 1)}
          </span>
        );
      })}
      {node.assets.length > 4 && <b>+{node.assets.length - 4}</b>}
    </div>
  );
}
