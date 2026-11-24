import { Copy, Frame, Palette, PenTool, Scan, Trash2, Ungroup } from "lucide-react";
import { SECTION_COLORS } from "../lib/canvasNotes";
import type { CanvasPoint } from "../lib/canvasLogic";
import type { CanvasMenuAction, CanvasMenuSection, buildCanvasContextMenu } from "../lib/canvasContextMenu";
import type { CanvasNode as ProjectGraphNode } from "../lib/types";
import { AssetTransferMenuItems, type useAssetTransferDialogs } from "./AssetTransferMenuItems";
import { CanvasSelectionMenuItems } from "./CanvasSelectionMenuItems";
import { ContextMenu, ContextSubmenu } from "./ContextMenu";
import { ContextMenuItems } from "./ContextMenuItems";
import { GenerationGroupMenuItem, MergeGenerationGroupMenuItem } from "./GenerationGroupMenuItem";

export type CanvasMenuImage = { assetId: string; canvasNodeId: string };
export type CanvasContextMenuState = {
  x: number;
  y: number;
  point: CanvasPoint | null;
  node: ProjectGraphNode | null;
  nodeIds: string[];
  folderId?: string;
  section?: CanvasMenuSection & { id: string; color: string };
  projectId: string;
  sourceProjectId: string | null;
  assetIds: string[];
  images: CanvasMenuImage[];
  canAdjustLayer: boolean;
  dissolveTarget?: { assetId?: string; groupKey?: string };
  model: ReturnType<typeof buildCanvasContextMenu>;
};

const CANVAS_MENU_ICONS = {
  pen: <PenTool size={14} aria-hidden="true" />,
  scan: <Scan size={14} aria-hidden="true" />,
  copy: <Copy size={14} aria-hidden="true" />,
  frame: <Frame size={14} aria-hidden="true" />,
  trash: <Trash2 size={14} className="shrink-0" aria-hidden="true" />,
  ungroup: <Ungroup size={14} aria-hidden="true" />,
  "delete-menu": <Trash2 size={13} aria-hidden="true" />,
};

export function CanvasContextMenu({ menu, transfer, onClose, onSelect, onAddImages, onSectionColor }: {
  menu: CanvasContextMenuState;
  transfer: ReturnType<typeof useAssetTransferDialogs>;
  onClose: () => void;
  onSelect: (action: CanvasMenuAction) => void;
  onAddImages: (images: readonly CanvasMenuImage[]) => void;
  onSectionColor: (sectionId: string, color: string) => void;
}) {
  const { section } = menu;
  const slots = {
    "asset-transfers": <AssetTransferMenuItems assetIds={menu.assetIds} sourceProjectId={menu.sourceProjectId} onClose={onClose} dialogs={transfer} />,
    "selection-actions": <CanvasSelectionMenuItems projectId={menu.projectId} nodeIds={menu.nodeIds} canAdjustLayer={menu.canAdjustLayer}
      className="app-context-item px-2 py-1.5" images={{ count: menu.images.length, run: () => onAddImages(menu.images) }} onClose={onClose} />,
    "merge-group": <MergeGenerationGroupMenuItem assetIds={menu.assetIds} nodeIds={menu.nodeIds} projectId={menu.projectId} onComplete={onClose} />,
    "dissolve-group": <GenerationGroupMenuItem target={menu.dissolveTarget} onComplete={onClose} />,
    "section-colors": section && <ContextSubmenu label="分区颜色" icon={<Palette size={14} aria-hidden="true" />}>
      {SECTION_COLORS.map(([label, color]) => <button type="button" key={color} role="menuitemradio"
        aria-checked={section.color === color} className="app-context-item px-2 py-1.5"
        onClick={() => { onSectionColor(section.id, color); onClose(); }}>
        <span className="canvas-section-swatch" style={{ backgroundColor: color }} />{label}
      </button>)}
    </ContextSubmenu>,
  };
  return <ContextMenu x={menu.x} y={menu.y} label={menu.model.label} onClose={onClose}>
    <ContextMenuItems items={menu.model.items} icons={CANVAS_MENU_ICONS} slots={slots} onSelect={onSelect} />
  </ContextMenu>;
}
