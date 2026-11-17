import { useState } from "react";
import { Archive, Download, FolderInput, FolderTree } from "lucide-react";
import { exportAssetArchive, exportAssetsToDirectory } from "../lib/assetArchive";
import { CollectionMoveDialog } from "./CollectionDialogs";
import { ContextSubmenu } from "./ContextMenu";
import { MoveAssetsToProjectDialog } from "./MoveAssetsToProjectDialog";

type MoveTarget = {
  kind: "project" | "folder";
  assetIds: string[];
  sourceProjectId: string | null;
  onSaved?: () => void;
};

/** Keep the target alive after the host dismisses its context menu. */
export function useAssetTransferDialogs() {
  const [target, open] = useState<MoveTarget | null>(null);
  const close = () => open(null);
  const dialogs = target?.kind === "project"
    ? <MoveAssetsToProjectDialog assetIds={target.assetIds} sourceProjectId={target.sourceProjectId} onSaved={target.onSaved} onClose={close} />
    : target && <CollectionMoveDialog selection={{ assetIds: target.assetIds }} onSaved={target.onSaved} onClose={close} />;
  return { open, dialogs };
}

export function AssetTransferMenuItems({ assetIds, sourceProjectId, dialogs, onClose, onMoveFolder, onComplete, disabled = false }: {
  assetIds: readonly string[];
  sourceProjectId: string | null;
  dialogs: ReturnType<typeof useAssetTransferDialogs>;
  onClose: () => void;
  onMoveFolder?: () => void;
  onComplete?: () => void;
  disabled?: boolean;
}) {
  const ids = [...new Set(assetIds)];
  if (!ids.length && !onMoveFolder) return null;
  const unavailable = disabled || !ids.length;
  const itemClass = "app-context-item px-2 py-1.5";
  function move(kind: MoveTarget["kind"]) {
    if (kind === "folder" && onMoveFolder) onMoveFolder();
    else dialogs.open({ kind, assetIds: ids, sourceProjectId, onSaved: onComplete });
    onClose();
  }
  return <>
    <button type="button" role="menuitem" className={itemClass} disabled={unavailable} onClick={() => move("project")}><FolderTree size={13} />移动到项目</button>
    <button type="button" role="menuitem" className={itemClass} disabled={disabled} onClick={() => move("folder")}><FolderInput size={13} />移动到文件夹</button>
    <ContextSubmenu label="导出" icon={<Download size={13} />} disabled={unavailable}>
      <p className="px-2 py-1.5 text-xs text-muted">您也可以长按素材，看到界面变化后，直接将素材拖动到其他应用中</p>
      <button type="button" role="menuitem" className={itemClass} onClick={() => { onClose(); void exportAssetsToDirectory(ids); }}><FolderInput size={13} />将所选内容导出到..</button>
      <button type="button" role="menuitem" className={itemClass} onClick={() => { onClose(); void exportAssetArchive(ids); }}><Archive size={13} />将所选内容打包为压缩包</button>
    </ContextSubmenu>
  </>;
}
