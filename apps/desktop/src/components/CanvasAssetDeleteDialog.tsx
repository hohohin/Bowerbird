import { userErrorMessage } from "../lib/userError";
import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../lib/api";
import { assetOriginals, type AssetOriginal } from "../lib/assetOriginals";
import { startFileTask } from "../lib/fileTasks";
import { isVideoPath } from "../lib/videoGeneration";
import type { Asset } from "../lib/types";
import { ModalShell } from "./ModalShell";
import { VideoPoster } from "./VideoPoster";
import { isAudioAsset } from "../lib/audioMedia";
import { isTextAsset } from "../lib/textMedia";
import { stopAudioPreview } from "../lib/audioPreview";
import { FileText, Music2 } from "lucide-react";

type Target = { original: AssetOriginal; asset: Asset };

/** Every view confirms the same originals; history survives while invalid canvas instances hide. */
export function CanvasAssetDeleteDialog({ target, onClose, onComplete }: {
  target: { assetIds: string[]; projectId: string | null; localPaths?: Record<string, string> };
  onClose: () => void;
  onComplete?: () => void;
}) {
  const [items, setItems] = useState<Target[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  useEffect(() => {
    let alive = true;
    setItems(null); setError(null);
    const ids = [...new Set(target.assetIds)];
    Promise.all([api.getAssetsByIds(ids), assetOriginals.preview(ids)]).then(([assets, originals]) => {
      if (!alive) return;
      const byId = new Map(assets.map(asset => [asset.id, asset]));
      const previews = new Map(originals.map(original => [original.asset_id, original]));
      const paths = new Set<string>();
      const problems: string[] = [];
      setItems(ids.flatMap(id => {
        const original = previews.get(id);
        const asset = byId.get(id);
        if (!asset || !original || "error" in original) {
          const message = original && "error" in original ? userErrorMessage(original.error, "无法读取原文件") : "素材记录已不存在";
          problems.push(`${asset?.name ?? id}：${message}`);
          return [];
        }
        if (paths.has(original.path)) return [];
        paths.add(original.path);
        return [{ original, asset }];
      }));
      if (problems.length) setError(`以下 ${problems.length} 项将跳过：\n${problems.join("\n")}`);
    }).catch(reason => { if (alive) setError(userErrorMessage(reason, "原文件暂时无法读取，请重试。")); });
    return () => { alive = false; };
  }, [target, attempt]);

  async function remove() {
    if (busyRef.current || !items?.length) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const originals = items.map(item => item.original);
      originals.forEach(original => stopAudioPreview(original.asset_id));
      await startFileTask({ kind: "delete", originals }, actionLabel);
    } catch (reason) {
      setError(userErrorMessage(reason, "文件任务未能启动，请重试。"));
      return;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
    try { onComplete?.(); } finally { onClose(); }
  }

  const missingCount = items?.filter(item => item.original.missing).length ?? 0;
  const onlyMissing = missingCount > 0 && missingCount === items?.length;
  const actionLabel = onlyMissing ? "清理失效条目" : missingCount ? "确认删除" : "删除原文件";
  return <ModalShell title={actionLabel} width="md" preventClose={busy} onClose={() => { if (!busyRef.current) onClose(); }} footer={<>
    <button data-modal-autofocus className="app-modal-button" disabled={busy} onClick={onClose}>取消</button>
    <button className="app-modal-button is-danger" disabled={busy || !items?.length} onClick={() => void remove()}>{busy ? "正在提交…" : actionLabel}</button>
  </>}>
    <div className="space-y-3">
      <p className="text-sm">{onlyMissing ? "原件已不在登记位置，将清理失效条目和画板中的对应素材卡片。标签、分析及生成历史保留。"
        : missingCount ? "现存原文件将放入系统回收站，失效条目和画板中的对应素材卡片一并清理。标签、分析及生成历史保留。"
          : "以下原文件将放入系统回收站，并移除画板中的对应素材卡片。其他文件夹的分身将失联；标签、分析及生成历史保留。"}</p>
      {!items && !error && <p role="status" className="text-sm text-muted">正在读取原文件…</p>}
      {error && <div role="alert" className="whitespace-pre-wrap break-words text-xs text-red-400">{error}
        <button className="app-modal-button mt-2 block" disabled={busy} onClick={() => { setAttempt(value => value + 1); }}>重新读取</button>
      </div>}
      {items && <ul aria-label="待删除素材" className="grid grid-cols-2 gap-3 sm:grid-cols-3">{items.map(({ original, asset }) => <li key={original.asset_id} data-delete-asset-id={original.asset_id} className="min-w-0 rounded-lg border border-edge bg-panel2 p-2">
        <div className="flex aspect-square items-center justify-center overflow-hidden rounded bg-panel">
          {original.missing && !asset.thumb_path ? <FileText size={28} aria-label="原件缺失"/>
            : isTextAsset(asset) ? <FileText size={28} aria-label="文本"/> : isAudioAsset(asset) ? <Music2 size={28} aria-label="音频"/> : isVideoPath(original.path)
            ? <VideoPoster path={original.missing ? undefined : original.path} poster={asset.thumb_path} alt={original.name} className="h-full w-full object-contain"/>
            : <img src={convertFileSrc(asset.thumb_path || original.path)} alt={original.name} loading="lazy" className="h-full w-full object-contain"/>}
        </div>
        <p className="mt-2 truncate text-xs" title={original.name}>{original.name}</p>
        {original.missing && <p className="mt-1 text-xs text-muted">原件缺失 · 仅清理引用</p>}
        <p className="mt-1 break-all text-xs text-muted">{original.path}</p>
      </li>)}</ul>}
    </div>
  </ModalShell>;
}
