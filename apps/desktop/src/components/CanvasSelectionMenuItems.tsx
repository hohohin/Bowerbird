import { Images, LayoutDashboard } from "lucide-react";
import { CANVAS_ARRANGE_NODES_EVENT, type CanvasArrangeNodesEventDetail } from "../lib/creativeCanvas";
import { CanvasLayerMenuItem } from "./CanvasLayerMenuItem";

export function CanvasSelectionMenuItems({
  projectId, nodeIds, canAdjustLayer = true, images, onClose, disabled, className,
}: CanvasArrangeNodesEventDetail & {
  canAdjustLayer?: boolean;
  images?: { count: number; run: () => void };
  onClose: () => void;
  disabled?: boolean;
  className: string;
}) {
  return <>
    {canAdjustLayer && nodeIds.length > 0 && <CanvasLayerMenuItem projectId={projectId} nodeIds={nodeIds} disabled={disabled} className={className} onClose={onClose} />}
    {nodeIds.length > 0 && <button role="menuitem" className={className} disabled={disabled} onClick={() => {
      window.dispatchEvent(new CustomEvent<CanvasArrangeNodesEventDetail>(CANVAS_ARRANGE_NODES_EVENT, { detail: { projectId, nodeIds } }));
      onClose();
    }}><LayoutDashboard size={13} />整理</button>}
    {images && images.count > 0 && <button role="menuitem" className={className} disabled={disabled} onClick={() => {
      onClose();
      images.run();
    }}><Images size={13} />{images.count > 1 ? `添加所选 ${images.count} 张图片到对话框` : "添加到对话框"}</button>}
  </>;
}
