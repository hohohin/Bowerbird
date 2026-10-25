import { userErrorMessage } from "../lib/userError";
import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../lib/api";
import { notifySuccess } from "../lib/notify";
import { isVideoPath } from "../lib/videoGeneration";
import type { Asset } from "../lib/types";
import { useStore } from "../store";
import { ModalShell } from "./ModalShell";
import { VideoPoster } from "./VideoPoster";
import { externalFiles } from "../lib/externalFiles";

/** Freeze the canvas selection before loading previews; deletion never reads the library selection. */
export function CanvasAssetDeleteDialog({ target, onClose, onComplete }: {
  target: { assetIds: string[]; projectId: string | null; localPaths?: Record<string, string> };
  onClose: () => void;
  onComplete?: () => void;
}) {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [progress, setProgress] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setAssets(null);
    setError(null);
    api.getAssetsByIds(target.assetIds).then(found => {
      if (!alive) return;
      const byId = new Map(found.map(asset => [asset.id, asset]));
      if (!target.assetIds.length || target.assetIds.some(id => !byId.has(id))) {
        setError("部分素材已不存在，请关闭弹窗后重新选择。");
        return;
      }
      setAssets(target.assetIds.map(id => byId.get(id)!));
    }).catch(error => {
      if (alive) setError(userErrorMessage(error, "待删除素材暂时无法读取，请重新打开后重试。"));
    });
    return () => { alive = false; };
  }, [target, attempt]);

  const localFiles = !!target.localPaths;
  const externalOnly = !localFiles && !!assets?.length && assets.every(asset => asset.source === "external");
  const hasExternal = !localFiles && assets?.some(asset => asset.source === "external");
  async function remove() {
    if (busyRef.current || !assets?.length) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setProgress(0);
    const remaining: Asset[] = [];
    const failures: string[] = [];
    for (const [index, asset] of assets.entries()) {
      try {
        if (target.localPaths) await externalFiles.delete(asset.id, target.localPaths[asset.id]);
        else await api.deleteAssetWithMode(asset.id, "delete", target.projectId);
      } catch (error) {
        remaining.push(asset);
        console.error("Asset deletion failed", error);
        failures.push(`${asset.name}：${userErrorMessage(error, "删除未完成，请稍后重试。")}`);
      }
      setProgress(index + 1);
    }
    // Deletion emits the existing library notifications; a sidebar refresh failure must not retry deletion.
    void useStore.getState().reloadProjects().catch(console.error);
    busyRef.current = false;
    setBusy(false);
    if (remaining.length) {
      setAssets(remaining);
      setFailed(true);
      setError(`已完成 ${assets.length - remaining.length} 项，${remaining.length} 项失败，以下仅列出未删除素材。\n${failures.join("\n")}`);
    } else {
      onComplete?.();
      notifySuccess(localFiles ? `已删除 ${assets.length} 个本机文件` : externalOnly ? `已移除 ${assets.length} 项外部引用，原文件保留` : `已删除所选 ${assets.length} 项素材${hasExternal ? "，外部引用的原文件保留" : ""}`);
      onClose();
    }
  }

  return <ModalShell title={localFiles ? `删除 ${assets?.length ?? target.assetIds.length} 个本机文件` : externalOnly ? `移除 ${assets?.length} 项外部引用` : `物理删除 ${assets?.length ?? target.assetIds.length} 项素材`}
    width="md" preventClose={busy} onClose={() => { if (!busyRef.current) onClose(); }}
    footer={<>
      <button data-modal-autofocus className="app-modal-button" disabled={busy} onClick={onClose}>取消</button>
      <button className="app-modal-button is-danger" disabled={busy || !assets?.length} onClick={() => void remove()}>
        {busy ? `删除中 ${progress}/${assets?.length}` : failed ? "重试失败项" : localFiles ? "删除本机文件" : externalOnly ? "移除引用" : "物理删除"}
      </button>
    </>}>
    <div className="space-y-3">
      <p className="text-sm">{externalOnly ? "是否移除以下素材的引用记录？" : "是否要删除以下素材？"}</p>
      <p className="text-xs leading-5 text-muted">{localFiles ? "将直接删除以下磁盘文件，不经过回收站，无法撤销；对应的素材记录及各项目画板引用也会移除。请确认文件名和路径。" : externalOnly ? "仅移除园丁鸟中的引用记录，电脑中的原文件保留。"
        : <>素材将从素材库和所有项目中物理删除，<strong>不可恢复</strong>。同一素材的多个画板实例一并移除。{hasExternal && "外部引用仅移除记录，电脑中的原文件保留。"}</>}</p>
      {!assets && !error && <p role="status" className="text-sm text-muted">正在读取待删除素材…</p>}
      {error && <div role="alert" className="whitespace-pre-wrap break-words text-xs text-red-400">{error}
        {!assets && <button className="app-modal-button mt-2 block" onClick={() => setAttempt(value => value + 1)}>重新读取</button>}
      </div>}
      {assets && <ul aria-label="待删除素材" className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {assets.map(asset => <li key={asset.id} data-delete-asset-id={asset.id} className="min-w-0 rounded-lg border border-edge bg-panel2 p-2">
          <div className="flex aspect-square items-center justify-center overflow-hidden rounded bg-panel">
            {isVideoPath(asset.store_path)
              ? <VideoPoster path={asset.store_path} poster={asset.thumb_path} alt={asset.name} className="h-full w-full object-contain" />
              : asset.thumb_path || asset.store_path
                ? <img src={convertFileSrc((asset.thumb_path || asset.store_path)!)} alt={asset.name} loading="lazy" className="h-full w-full object-contain" />
                : <span className="text-xs text-muted">暂无预览</span>}
          </div>
          <p className="mt-2 truncate text-xs" title={asset.name}>{target.localPaths?.[asset.id]?.split(/[\\/]/).pop() ?? asset.name}</p>
          {localFiles && <p className="mt-1 break-all text-xs text-muted">{target.localPaths?.[asset.id]}</p>}
          {!localFiles && asset.source === "external" && <p className="mt-1 text-xs text-muted">仅移除引用 · 保留原文件</p>}
        </li>)}
      </ul>}
    </div>
  </ModalShell>;
}
