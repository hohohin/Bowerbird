import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Check, ChevronDown, ChevronRight, Pin, Plus, RefreshCw, X } from "lucide-react";
import { api, type CanvasFrequentAssetsResult } from "../lib/api";
import type { Asset } from "../lib/types";
import { setDragAssets } from "../lib/dragPayload";
import { externalFiles } from "../lib/externalFiles";
import { notifyError, notifySuccess } from "../lib/notify";
import { userErrorMessage } from "../lib/userError";
import { useStore } from "../store";
import { FileMediaCard } from "./FileMediaCard";
import { Lightbox } from "./Lightbox";
import "./CanvasFrequentAssets.css";

export function useCanvasFrequentAssets(active: boolean, projectId: string | null) {
  const [items, setItems] = useState<CanvasFrequentAssetsResult>({ frequent: [], pinned: [], threshold: 10 });
  const [scope, setScope] = useState<"project" | "global">("global");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const scopeId = scope === "project" ? projectId : null;
  const scopeRef = useRef(scopeId);
  scopeRef.current = scopeId;
  const alive = useRef(true), version = useRef(0), pending = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pendingIds = useRef(new Set<string>());
  const read = useCallback(async () => {
    if (pending.current) return;
    const request = ++version.current, requestedScope = scopeRef.current;
    try {
      const result = await api.canvasFrequentAssets(requestedScope);
      if (alive.current && request === version.current && requestedScope === scopeRef.current) { setItems(result); setError(""); }
    } catch (reason) {
      if (alive.current && request === version.current && requestedScope === scopeRef.current) setError(String(reason));
    } finally {
      if (alive.current && request === version.current && requestedScope === scopeRef.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; version.current++; };
  }, []);
  useEffect(() => {
    version.current++;
    setItems(previous => ({ ...previous, frequent: [], pinned: [] })); setLoading(true);
  }, [scopeId]);
  useEffect(() => {
    if (!active) return;
    void read();
    let timer: number | undefined;
    const refresh = () => { window.clearTimeout(timer); timer = window.setTimeout(() => void read(), 120); };
    const listeners = [listen("library://assets-changed", refresh), listen("library://frequent-assets-changed", refresh)];
    return () => { window.clearTimeout(timer); for (const listener of listeners) void listener.then(stop => stop()); };
  }, [active, scopeId, read]);

  function update(action: (projectId: string | null) => Promise<CanvasFrequentAssetsResult>) {
    const requestedScope = scopeRef.current;
    pending.current++; version.current++; setBusy(true);
    // Serialize clicks so rapid additions cannot overwrite each other or get dropped.
    const task = queue.current.then(async () => {
      const result = await action(requestedScope);
      if (alive.current && requestedScope === scopeRef.current) { setItems(result); setError(""); setLoading(false); }
    }).finally(() => {
      pending.current--;
      if (alive.current && !pending.current) {
        setBusy(false);
        void read();
      }
    });
    queue.current = task.catch(() => {});
    return task;
  }
  async function pinAsset(assetId: string) {
    if (pendingIds.current.has(assetId)) return;
    pendingIds.current.add(assetId);
    try { await update(id => api.pinCanvasFrequentAssets([assetId], id)); }
    catch (reason) { notifyError(reason, "添加常用素材失败，请重试。"); }
    finally { pendingIds.current.delete(assetId); }
  }
  async function remove(asset: Asset, row: "frequent" | "pinned") {
    try { await update(id => api.removeCanvasFrequentAsset(asset.id, row, id)); }
    catch (reason) { notifyError(reason, "移除展示失败，请重试。"); }
  }
  async function retrieve(threshold: number) {
    try {
      await update(async id => {
        if (threshold !== items.threshold) await api.setCanvasFrequentAssetsThreshold(threshold, id);
        return api.refreshCanvasFrequentAssets(id);
      });
      notifySuccess("已重新检索常用素材"); return true;
    } catch (reason) { notifyError(reason, "检索常用素材失败，请重试。"); return false; }
  }
  async function changeThreshold(threshold: number) {
    try { await update(id => api.setCanvasFrequentAssetsThreshold(threshold, id)); return true; }
    catch (reason) { notifyError(reason, "保存引用次数阈值失败，请重试。"); return false; }
  }
  return { items, scope, setScope, loading, busy, error, read, pinAsset, remove, retrieve, changeThreshold };
}

export function CanvasFrequentAssets({ library, projectId, picking, onPickingChange }: {
  library: ReturnType<typeof useCanvasFrequentAssets>; projectId: string | null;
  picking: boolean; onPickingChange: (value: boolean) => void;
}) {
  const { items, scope, setScope, loading, busy, error, read, remove, retrieve, changeThreshold } = library;
  const [thresholdDraft, setThresholdDraft] = useState(String(items.threshold));
  const thresholdEditing = useRef(false), thresholdCancelled = useRef(false);
  useEffect(() => { if (!thresholdEditing.current) setThresholdDraft(String(items.threshold)); }, [items.threshold]);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem("canvas-frequent-assets-collapsed") === "true"; } catch { return false; }
  });
  const [preview, setPreview] = useState<string | null>(null);
  const alive = useRef(true), previewVersion = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; previewVersion.current++; }; }, []);
  useEffect(() => { previewVersion.current++; setPreview(null); }, [picking, projectId]);
  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    if (next) onPickingChange(false);
    try { localStorage.setItem("canvas-frequent-assets-collapsed", String(next)); } catch { /* Keep the in-memory preference. */ }
  }
  async function activate(asset: Asset) {
    if (picking) return;
    const state = useStore.getState();
    if (state.activeProjectId !== projectId || !state.canvasLibraryOpen) return;
    if (state.boardOpen || state.genEditing) {
      window.dispatchEvent(new CustomEvent("bowerbird://board-asset-picked", { detail: asset.id }));
      return;
    }
    const request = ++previewVersion.current;
    try {
      if (!asset.store_path) throw new Error("素材原文件不可用");
      const path = await externalFiles.media(asset.store_path);
      if (alive.current && request === previewVersion.current) setPreview(path);
    } catch (reason) { if (alive.current && request === previewVersion.current) notifyError(reason, "无法预览素材"); }
  }
  function openDetail(asset: Asset) {
    previewVersion.current++; setPreview(null); useStore.getState().openDetail(asset.id);
  }
  async function saveThreshold(value: string, retrieveAfter = false) {
    thresholdEditing.current = false;
    if (thresholdCancelled.current) {
      thresholdCancelled.current = false; setThresholdDraft(String(items.threshold)); return false;
    }
    const threshold = Number(value);
    if (!value.trim() || !Number.isSafeInteger(threshold) || threshold < 0) {
      setThresholdDraft(String(items.threshold));
      notifyError("请输入有效的非负整数。", "请输入有效的非负整数。");
      return false;
    }
    if (threshold === items.threshold && !retrieveAfter) { setThresholdDraft(String(items.threshold)); return true; }
    const saved = await (retrieveAfter ? retrieve(threshold) : changeThreshold(threshold));
    if (!saved && alive.current) setThresholdDraft(String(items.threshold));
    return saved;
  }
  return <section className={`canvas-frequent-assets${picking ? " is-picking" : ""}`} aria-label="常用素材" aria-busy={busy || loading}>
    <header className="canvas-frequent-heading">
      <button type="button" className="canvas-frequent-toggle" aria-label={collapsed ? "展开常用素材" : "收起常用素材"}
        aria-expanded={!collapsed} onClick={toggleCollapsed}>
        {collapsed ? <ChevronRight size={13} aria-hidden="true"/> : <ChevronDown size={13} aria-hidden="true"/>}
        <Pin size={13} aria-hidden="true"/><strong>常用素材</strong>
      </button>
      <div className="canvas-frequent-scope" role="group" aria-label="常用素材范围">
        <button type="button" aria-pressed={scope === "project"} disabled={!projectId} onClick={() => setScope("project")}>本项目</button>
        <button type="button" aria-pressed={scope === "global"} onClick={() => setScope("global")}>全局</button>
      </div>
      <button type="button" className="canvas-frequent-retrieve" disabled={busy || loading}
        onPointerDown={event => { if (event.button === 0) event.preventDefault(); }}
        onClick={() => void saveThreshold(thresholdDraft, true)}
        title={`重新检索当前范围内引用大于 ${items.threshold} 次的素材，并恢复之前移除的常用素材`}>
        <RefreshCw size={12} aria-hidden="true"/>检索常用素材
      </button>
    </header>
    {!collapsed && <>
      {error && <p className="canvas-frequent-error" role="alert">{userErrorMessage(error, "常用素材暂时无法读取，请重试。")}<button type="button" onClick={() => void read()}>重试</button></p>}
      {(["frequent", "pinned"] as const).map(row => <div className={`canvas-frequent-row${!items[row].length ? " is-empty" : ""}`} data-row={row} key={row}>
        <div className="canvas-frequent-label">
          <span>{row === "frequent" ? "高频引用" : "手动固定"}</span>
          {row === "frequent" ? <label className="canvas-frequent-threshold">引用 &gt;
            <input type="number" min={0} max={Number.MAX_SAFE_INTEGER} step={1} data-frequent-threshold
              aria-label="高频引用次数阈值" title="引用次数大于此值时展示；输入非负整数，回车或失焦保存" disabled={busy || loading}
              value={thresholdDraft} onFocus={() => { thresholdEditing.current = true; thresholdCancelled.current = false; }}
              onChange={event => { thresholdEditing.current = true; setThresholdDraft(event.target.value); }} onBlur={event => { if (thresholdEditing.current) void saveThreshold(event.currentTarget.value); }}
              onKeyDown={event => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter" || event.key === "Escape") {
                  event.preventDefault(); event.stopPropagation();
                  thresholdCancelled.current = event.key === "Escape";
                  event.currentTarget.blur();
                }
              }}/>
            次</label> : <button type="button" aria-pressed={picking} onClick={() => onPickingChange(!picking)}>
            {picking ? <Check size={12} aria-hidden="true"/> : <Plus size={12} aria-hidden="true"/>}{picking ? "完成添加" : "添加素材"}
          </button>}
        </div>
        <div className="canvas-frequent-scroll" role="region" aria-label={row === "frequent" ? "高频引用素材，横向滚动" : "手动固定素材，横向滚动"} tabIndex={0}
          onWheel={event => {
            if (event.ctrlKey || event.metaKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
            const target = event.currentTarget;
            if (target.scrollWidth <= target.clientWidth) return;
            target.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? target.clientWidth : 1);
            event.stopPropagation();
          }}>
          {items[row].map(asset => <div className="canvas-frequent-card" key={asset.id} title={asset.name}>
            <FileMediaCard entry={{ path: asset.store_path ?? "", name: asset.name, directory: false, preview: asset.thumb_path, version: `${asset.id}:${asset.file_mtime ?? 0}:${asset.thumb_path}` }}
              selected={false} revision={0} labels={[]} assetId={asset.id} aspectRatio={1}
              onSelect={() => void activate(asset)} onActivate={() => void activate(asset)} onOpen={() => openDetail(asset)}
              onContextMenu={(x,y) => useStore.getState().openContextMenu(x,y,asset.id,{ asset, singleAsset: true })}
              onDragStart={event => { setDragAssets([asset.id], asset.name, event.currentTarget.querySelector("img")?.src); event.dataTransfer.effectAllowed = "copy"; event.dataTransfer.setData("text/plain", asset.id); }}
              onDragEnd={() => setDragAssets(null)}/>
            <button type="button" className="canvas-frequent-remove" disabled={busy}
              aria-label={`${row === "frequent" ? "移除常用素材" : "移除固定素材"} ${asset.name}`}
              title={row === "frequent" ? "移出此行，检索常用素材时才会恢复" : "取消固定"}
              onClick={() => void remove(asset, row)}><X size={12} aria-hidden="true"/></button>
            {row === "frequent" && <span className="canvas-frequent-count" title={`累计引用 ${asset.reference_count} 次`}>{asset.reference_count} 次</span>}
          </div>)}
          {!items[row].length && <p className="canvas-frequent-empty">{loading ? "正在读取…" : error ? "读取失败，请重试" : row === "frequent" ? `暂无引用大于 ${items.threshold} 次的素材` : picking ? "点击素材库或画板中的素材，可连续添加" : "点击添加素材，再从素材库或画板点选"}</p>}
        </div>
      </div>)}
    </>}
    {preview && <Lightbox images={[preview]} index={0} onIndexChange={() => {}} onClose={() => { previewVersion.current++; setPreview(null); }}/>}
  </section>;
}
