import { AlignHorizontalJustifyStart, Images, LayoutDashboard } from "lucide-react";
import { CANVAS_ALIGN_NODES_EVENT, type CanvasAlignMode, type CanvasAlignNodesEventDetail } from "../lib/canvasAlignment";
import { CANVAS_ARRANGE_NODES_EVENT, type CanvasArrangeNodesEventDetail } from "../lib/creativeCanvas";
import { CanvasLayerMenuItem } from "./CanvasLayerMenuItem";
import { ContextSubmenu } from "./ContextMenu";

const alignmentItems: readonly (readonly [CanvasAlignMode, string])[] = [
  ["left", "左对齐"], ["center-x", "水平居中"], ["right", "右对齐"],
  ["top", "顶对齐"], ["center-y", "垂直居中"], ["bottom", "底对齐"],
  ["distribute-x", "水平等距分布"], ["distribute-y", "垂直等距分布"],
];

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
    {nodeIds.length >= 2 && <ContextSubmenu label="对齐与分布" icon={<AlignHorizontalJustifyStart size={13} aria-hidden="true" />} disabled={disabled}>
      {alignmentItems.map(([mode, label]) => <button key={mode} type="button" role="menuitem" className={className}
        disabled={nodeIds.length < 3 && (mode === "distribute-x" || mode === "distribute-y")} onClick={() => {
          window.dispatchEvent(new CustomEvent<CanvasAlignNodesEventDetail>(CANVAS_ALIGN_NODES_EVENT, { detail: { projectId, nodeIds, mode } }));
          onClose();
        }}>{label}</button>)}
    </ContextSubmenu>}
    {images && images.count > 0 && <button role="menuitem" className={className} disabled={disabled} onClick={() => {
      onClose();
      images.run();
    }}><Images size={13} />{images.count > 1 ? `添加所选 ${images.count} 张图片到对话框` : "添加到对话框"}</button>}
  </>;
}
