import { userErrorMessage } from "../lib/userError";
import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ImageOff, ShieldCheck } from "lucide-react";
import { api } from "../lib/api";
import type { Asset, ProjectDeleteImpact, ProjectDeleteScanProgress } from "../lib/types";
import type { WorkspaceProjectDeleteMode } from "../lib/workspaceRoute";
import { isVideoPath } from "../lib/videoGeneration";
import { ModalShell } from "./ModalShell";
import { OverlayScrollArea } from "./CollectionScrollArea";
import "./ProjectDeleteDialog.css";

export function ProjectDeleteDialog({ target, onClose, onConfirm }: {
  target: { id: string; name: string; mode: WorkspaceProjectDeleteMode };
  onClose: () => void;
  onConfirm: (impact: ProjectDeleteImpact | null, physical: boolean, discard: boolean) => Promise<void>;
}) {
  const provisional = target.mode === "discard-provisional";
  const [impact, setImpact] = useState<ProjectDeleteImpact | null>(null);
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [error, setError] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [physical, setPhysical] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [scanState, setScanState] = useState<"scanning" | "stopping" | "stopped" | "complete" | "failed">(provisional ? "complete" : "scanning");
  const [progress, setProgress] = useState<ProjectDeleteScanProgress | null>(null);
  const [queued, setQueued] = useState(false);
  const queuedIntent = useRef<{ discard: boolean } | null>(null);
  const cancelScan = useRef<() => void>(() => {});
  const confirmRef = useRef(onConfirm); confirmRef.current = onConfirm;
  const submitting = useRef(false);
  async function performDelete(value: ProjectDeleteImpact | null, deleteAssets: boolean, abandon: boolean) {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setQueued(false); queuedIntent.current = null;
    try { await confirmRef.current(value, deleteAssets, abandon); }
    catch (reason) {
      setError(`删除未完成：${reason instanceof Error ? reason.message : String(reason)}`);
      setImpact(null); setAssets(null); setPhysical(false); setDiscard(false);
    } finally { submitting.current = false; setBusy(false); }
  }
  async function deleteIfQueued(value: ProjectDeleteImpact) {
    const intent = queuedIntent.current;
    if (!intent) return false;
    setScanState("complete");
    await performDelete(value, false, intent.discard);
    return true;
  }
  useEffect(() => {
    if (provisional) return;
    let alive = true;
    let stopped = false, launched = false, started = false, cancelSent = false, finished = false;
    const requestId = crypto.randomUUID();
    const sendCancel = () => {
      if (!started || cancelSent || finished) return;
      cancelSent = true;
      void api.cancelProjectExclusiveScan(requestId).catch(() => {
        cancelSent = false;
        if (alive && !finished) { stopped = false; setScanState("scanning"); setPreviewError("暂时无法停止检索，请重试。"); }
      });
    };
    cancelScan.current = () => {
      stopped = true;
      queuedIntent.current = null; setQueued(false); setPhysical(false);
      setScanState(launched && !finished ? "stopping" : "stopped");
      sendCancel();
    };
    setScanState("scanning"); setProgress(null); setQueued(false); queuedIntent.current = null;
    setImpact(null); setAssets(null); setError(""); setPreviewError(""); setPhysical(false); setDiscard(false);
    void api.projectDeleteImpact(target.id, false).then(async value => {
      if (!alive) return;
      setImpact(value);
      if (stopped) return;
      try {
        launched = true;
        const physicalImpact = await api.projectExclusiveScan(target.id, requestId, next => {
          // The first progress event acknowledges native registration, including a stop-before-start race.
          started = true;
          if (stopped) sendCancel();
          if (alive && !stopped) setProgress(next);
        });
        finished = true;
        if (!alive) return;
        if (stopped || !physicalImpact) {
          setScanState("stopped"); setPhysical(false); setQueued(false); queuedIntent.current = null; return;
        }
        const complete = { ...value, physical: physicalImpact };
        setImpact(complete);
        if (await deleteIfQueued(complete)) return;
        const ids = physicalImpact.exclusive_asset_ids;
        if (!ids || ids.length !== physicalImpact.exclusive_asset_count || new Set(ids).size !== ids.length) throw new Error("preview unavailable");
        const found = ids.length ? await api.getAssetsByIds(ids) : [];
        if (!alive) return;
        if (stopped) { setScanState("stopped"); return; }
        const byId = new Map(found.map(asset => [asset.id, asset]));
        if (ids.some(id => !byId.has(id))) throw new Error("assets changed");
        setAssets(ids.map(id => byId.get(id)!));
        setScanState("complete");
        await deleteIfQueued(complete);
      } catch {
        finished = true;
        if (alive) {
          setScanState(stopped ? "stopped" : "failed");
          setPhysical(false); setQueued(false); queuedIntent.current = null;
          if (!stopped) setPreviewError("未能完成独占素材检索，待执行的删除已取消。你仍可保留素材并删除项目，或重新检索。");
        }
      }
    }).catch(() => { if (alive) { setScanState("failed"); setError("暂时无法检查项目，请重试。"); } });
    return () => { alive = false; stopped = true; queuedIntent.current = null; sendCancel(); };
  }, [target.id, provisional, attempt]);
  const pending = impact?.pending_agent_results ?? [];
  const active = Math.max(0, (impact?.running_generation_count ?? 0) + (impact?.running_agent_count ?? 0) - pending.length);
  const blocked = active > 0 || (pending.length > 0 && !discard);
  const ready = provisional || (!!impact && !error);
  const scanning = scanState === "scanning" || scanState === "stopping";
  const locked = busy || scanning || queued;
  async function remove() {
    if (submitting.current || queuedIntent.current || !ready || blocked || scanState === "stopping") return;
    if (scanning) { queuedIntent.current = { discard }; setPhysical(false); setQueued(true); return; }
    if (physical && !assets?.length) return;
    await performDelete(impact, physical, discard);
  }
  return <ModalShell title={provisional ? "丢弃未保存项目？" : "删除项目？"} width="md" className="project-delete-dialog"
    preventClose={locked} onClose={() => { if (!locked && !submitting.current) onClose(); }}
    footer={<>
      {scanning ? <button data-modal-autofocus className="app-modal-button" disabled={scanState === "stopping"} onClick={() => cancelScan.current()}>{scanState === "stopping" ? "正在停止检索…" : "停止检索"}</button>
        : <button data-modal-autofocus className="app-modal-button" disabled={busy || queued} onClick={onClose}>取消</button>}
      <button className="app-modal-button is-danger" disabled={busy || queued || scanState === "stopping" || !ready || blocked} onClick={() => void remove()}>
        {busy ? "正在删除…" : queued ? "检索完成后删除项目" : provisional ? "丢弃项目" : physical && !scanning ? "删除项目及素材" : "删除项目，保留素材"}
      </button>
    </>}>
    <OverlayScrollArea contentClassName="project-delete-content" label="删除确认滚动条">
      <div>
        <p className="break-words text-base font-semibold">{target.name}</p>
        <p className="mt-1 text-sm leading-6 text-muted">{provisional ? "未保存的画板将被丢弃，素材不受影响。" : "项目中的画板和创作记录将被删除，无法恢复。"}</p>
      </div>
      {!provisional && <>
        <p className="flex items-center gap-2 text-sm"><ShieldCheck size={17} aria-hidden="true" />{physical && !scanning ? "其他素材与电脑中的原文件会保留" : "默认保留全部素材，之后仍可在素材库中使用"}</p>
        {!impact && !error && <p role="status" className="text-sm text-muted">正在检查项目素材…</p>}
        {scanning && <ScanStatus progress={progress} stopping={scanState === "stopping"} />}
        {queued && <p role="status" className="text-sm leading-6">已记住你的选择：检索完成后自动删除项目，全部素材（含独占素材）保留。点击“停止检索”可取消这次删除。</p>}
        {impact && <section className="rounded-lg border border-edge p-3">
          <label className="flex items-start gap-3">
            <input type="checkbox" className="mt-1" checked={physical} disabled={busy || queued || scanState === "stopping" || (!scanning && !assets?.length)}
              onChange={event => setPhysical(event.target.checked)} aria-describedby="project-delete-exclusives" />
            <span><strong className="text-sm">同时永久删除独占素材</strong>
              <span id="project-delete-exclusives" className="mt-1 block text-xs leading-5 text-muted">{scanning
                ? "可先勾选。检索中提前删除项目会保留全部素材；完成后提交才会永久删除独占素材。"
                : scanState !== "complete" ? "检索完成后才能永久删除素材。" : impact.physical.exclusive_asset_count > 0
                ? `${impact.physical.exclusive_asset_count} 项仅由此项目使用。未勾选时全部保留。` : "没有可删除的独占素材，所有素材都会保留。"}</span></span>
          </label>
          <details className="mt-3" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
          <summary className="cursor-pointer text-sm">查看独占素材{scanState === "complete" ? `（${assets?.length ?? 0}）` : ""}</summary>
          {expanded && scanning && <p className="mt-3 text-sm text-muted">正在检索独占素材</p>}
          {expanded && scanState === "stopped" && <p className="mt-3 text-sm text-muted">检索已停止，素材不会被删除。</p>}
          {expanded && assets && assets.length > 0 && <ul aria-label="独占素材" className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {assets.map(asset => <li key={asset.id} data-exclusive-asset-id={asset.id} className="min-w-0">
              <AssetPreview asset={asset} />
              <p className="mt-1 truncate text-xs" title={asset.name}>{asset.name}</p>
            </li>)}
          </ul>}
          </details>
          {physical && !scanning && <p role="status" className="mt-3 text-sm leading-5 text-[var(--bb-danger)]">以上素材及文件将永久删除，不进入回收站，无法恢复。</p>}
          {previewError && <div className="mt-3 text-xs leading-5" role="alert">{previewError}</div>}
          {(scanState === "failed" || scanState === "stopped") && <button className="app-modal-button mt-3" disabled={busy} onClick={() => setAttempt(v => v + 1)}>重新检索</button>}
        </section>}
        {pending.length > 0 && <section className="rounded-lg border border-edge p-3 text-sm leading-6">
          <p>有 {pending.length} 个已完成任务的结果尚未全部保存。</p>
          <label className="mt-2 flex items-start gap-3"><input type="checkbox" className="mt-1.5" checked={discard} disabled={busy || queued} onChange={event => setDiscard(event.target.checked)} />
            <span>放弃尚未保存的结果<span className="block text-xs text-muted">删除后无法再取回这些结果，已保存的素材按上方选项处理。</span></span>
          </label>
          <details className="mt-2 text-xs text-muted"><summary className="cursor-pointer">查看任务详情</summary>
            {pending.map(result => <p key={result.run_id} className="break-all">{new Date(result.created_at * 1000).toLocaleDateString()} · {result.run_id}</p>)}
          </details>
        </section>}
        {active > 0 && <p role="status" className="text-sm leading-6">还有 {active} 个任务正在运行或等待处理，结束后才能删除项目。<button className="app-modal-button mt-2 block" disabled={scanning || busy} onClick={() => setAttempt(v => v + 1)}>重新检查</button></p>}
      </>}
      {error && <div role="alert" className="break-words text-sm leading-6">{userErrorMessage(error, "删除未完成，请重新检查后重试。")}<button className="app-modal-button mt-2 block" onClick={() => setAttempt(v => v + 1)}>重新检查</button></div>}
    </OverlayScrollArea>
  </ModalShell>;
}

function ScanStatus({ progress, stopping }: { progress: ProjectDeleteScanProgress | null; stopping: boolean }) {
  const stages = { waiting: "等待素材库就绪", candidates: "查找项目素材", paths: "检查文件是否共用", assets: "检查素材使用情况", fingerprint: "确认待删除文件" };
  const total = progress?.total ?? 0;
  const completed = Math.min(progress?.completed ?? 0, total);
  const seconds = progress?.remaining_ms == null ? null : Math.max(1, Math.ceil(progress.remaining_ms / 1000));
  const duration = seconds == null ? "正在估算所需时间" : seconds < 60 ? `当前步骤预计还需约 ${seconds} 秒` : `当前步骤预计还需约 ${Math.ceil(seconds / 60)} 分钟`;
  return <div className="project-delete-scan rounded-lg bg-panel2 p-3 text-xs leading-5">
    <p role="status" className="text-sm">{stopping ? "正在停止检索…" : "正在检索独占素材"}</p>
    {!stopping && <>
      <p className="mt-1 text-muted">{progress ? stages[progress.phase] : "准备检索"}{total > 0 ? ` · ${completed} / ${total}` : ""}</p>
      <progress className="mt-2 w-full" aria-label="当前步骤检索进度" max={total || 1} value={total > 0 ? completed : undefined} />
      <p className="text-muted">{total > 0 && completed === total ? "当前步骤已完成，正在准备结果" : duration}。素材较多时会更久。</p>
    </>}
    <p className="mt-1 text-muted">{stopping ? "停止后即可关闭面板，项目和素材均会保留。" : "检索期间请不要关闭面板。如需退出，请先点击“停止检索”。"}</p>
  </div>;
}

function AssetPreview({ asset }: { asset: Asset }) {
  const [failed, setFailed] = useState(false);
  // Never start video decoding for a delete confirmation; use its saved poster.
  const path = asset.thumb_path || (!isVideoPath(asset.store_path) ? asset.store_path : null);
  return <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-md bg-panel2">
    {path && !failed ? <img src={convertFileSrc(path)} alt={asset.name} loading="lazy" className="h-full w-full object-contain" onError={() => setFailed(true)} />
      : <span className="flex flex-col items-center gap-1 text-xs text-muted"><ImageOff size={20} aria-hidden="true" />暂无预览</span>}
  </div>;
}
