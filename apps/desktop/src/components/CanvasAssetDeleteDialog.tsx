import { userErrorMessage } from "../lib/userError";
import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../lib/api";
import { assetOriginals, type AssetOriginal } from "../lib/assetOriginals";
import { notifySuccess } from "../lib/notify";
import { isVideoPath } from "../lib/videoGeneration";
import type { Asset } from "../lib/types";
import { useStore } from "../store";
import { ModalShell } from "./ModalShell";
import { VideoPoster } from "./VideoPoster";
import { isAudioAsset } from "../lib/audioMedia";
import { isTextAsset } from "../lib/textMedia";
import { stopAudioPreview } from "../lib/audioPreview";
import { FileText, Music2 } from "lucide-react";

type Target = { original: AssetOriginal; asset: Asset };

/** Every view confirms the same registered originals; records and canvas instances survive. */
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
  const readIds = useRef(target.assetIds);
  const completed = useRef({ recycled: 0, cleaned: 0 });
  const [progress, setProgress] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => { readIds.current = target.assetIds; completed.current = { recycled: 0, cleaned: 0 }; }, [target]);
  useEffect(() => {
    let alive = true;
    setItems(null); setError(null);
    const ids = [...new Set(readIds.current)];
    Promise.all([api.getAssetsByIds(ids), assetOriginals.preview(ids)]).then(([assets, originals]) => {
      if (!alive) return;
      const byId = new Map(assets.map(asset => [asset.id, asset]));
      const previews = new Map(originals.map(original => [original.asset_id, original]));
      if (!ids.length || ids.some(id => !byId.has(id) || !previews.has(id))) {
        setError("部分素材已不存在，请关闭弹窗后重新选择。"); return;
      }
      const paths = new Set<string>();
      setItems(ids.flatMap(id => {
        const original = previews.get(id)!;
        if (paths.has(original.path)) return [];
        paths.add(original.path);
        return [{ original, asset: byId.get(id)! }];
      }));
    }).catch(reason => { if (alive) setError(userErrorMessage(reason, "原文件暂时无法读取，请重试。")); });
    return () => { alive = false; };
  }, [target, attempt]);

  async function remove() {
    if (busyRef.current || !items?.length) return;
    busyRef.current = true; setBusy(true); setError(null); setProgress(0);
    const remaining: Target[] = [], failures: string[] = [];
    for (const [index, item] of items.entries()) {
      try {
        stopAudioPreview(item.original.asset_id);
        await assetOriginals.trash(item.original);
        if (item.original.missing) completed.current.cleaned++;
        else completed.current.recycled++;
      } catch (reason) {
        remaining.push(item);
        console.error("Original recycling failed", reason);
        failures.push(`${item.original.name}：${userErrorMessage(reason, item.original.missing ? "清理未完成，请稍后重试。" : "删除未完成，请稍后重试。")}`);
      }
      setProgress(index + 1);
    }
    void useStore.getState().reloadProjects().catch(console.error);
    busyRef.current = false; setBusy(false);
    if (remaining.length) {
      readIds.current = remaining.map(item => item.original.asset_id);
      setItems(remaining); setFailed(true);
      setError(`已完成 ${items.length - remaining.length} 项，${remaining.length} 项失败，以下仅列出未完成项。\n${failures.join("\n")}`);
      return;
    }
    notifySuccess([
      completed.current.recycled ? `已将 ${completed.current.recycled} 个原文件放入回收站` : null,
      completed.current.cleaned ? `已清理 ${completed.current.cleaned} 个失效条目` : null,
    ].filter(Boolean).join("，"));
    try { onComplete?.(); } catch (reason) { console.error("Refresh after recycling failed", reason); }
    onClose();
  }

  const missingCount = items?.filter(item => item.original.missing).length ?? 0;
  const onlyMissing = missingCount > 0 && missingCount === items?.length;
  const actionLabel = onlyMissing ? "清理失效条目" : missingCount ? "确认删除" : "删除原文件";
  return <ModalShell title={actionLabel} width="md" preventClose={busy} onClose={() => { if (!busyRef.current) onClose(); }} footer={<>
    <button data-modal-autofocus className="app-modal-button" disabled={busy} onClick={onClose}>取消</button>
    <button className="app-modal-button is-danger" disabled={busy || !items?.length} onClick={() => void remove()}>{busy ? `处理中 ${progress}/${items?.length}` : failed ? "重试失败项" : actionLabel}</button>
  </>}>
    <div className="space-y-3">
      <p className="text-sm">{onlyMissing ? "原件已不在登记位置，仅从素材库移除失效条目。标签、分析及画布资料保留。"
        : missingCount ? "现存原文件将放入系统回收站，失效条目仅从素材库移除。标签、分析及画布资料保留。"
          : "以下原文件将放入系统回收站，其他集合的分身和画布引用将无法访问原件。标签、分析及画布资料保留。"}</p>
      {!items && !error && <p role="status" className="text-sm text-muted">正在读取原文件…</p>}
      {error && <div role="alert" className="whitespace-pre-wrap break-words text-xs text-red-400">{error}
        <button className="app-modal-button mt-2 block" disabled={busy} onClick={() => { setFailed(false); setAttempt(value => value + 1); }}>重新读取</button>
      </div>}
      {items && <ul aria-label="待删除素材" className="grid grid-cols-2 gap-3 sm:grid-cols-3">{items.map(({ original, asset }) => <li key={original.asset_id} data-delete-asset-id={original.asset_id} className="min-w-0 rounded-lg border border-edge bg-panel2 p-2">
        <div className="flex aspect-square items-center justify-center overflow-hidden rounded bg-panel">
          {original.missing && !asset.thumb_path ? <FileText size={28} aria-label="原件缺失"/>
            : isTextAsset(asset) ? <FileText size={28} aria-label="文本"/> : isAudioAsset(asset) ? <Music2 size={28} aria-label="音频"/> : isVideoPath(original.path)
            ? <VideoPoster path={original.missing ? undefined : original.path} poster={asset.thumb_path} alt={original.name} className="h-full w-full object-contain"/>
            : <img src={convertFileSrc(asset.thumb_path || original.path)} alt={original.name} loading="lazy" className="h-full w-full object-contain"/>}
        </div>
        <p className="mt-2 truncate text-xs" title={original.name}>{original.name}</p>
        {original.missing && <p className="mt-1 text-xs text-muted">原件缺失 · 仅移出素材库</p>}
        <p className="mt-1 break-all text-xs text-muted">{original.path}</p>
      </li>)}</ul>}
    </div>
  </ModalShell>;
}
