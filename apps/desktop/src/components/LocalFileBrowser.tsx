import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, ArrowUp, Folder, FolderOpen, Image, LoaderCircle, Monitor, RefreshCw, X } from "lucide-react";
import { externalFiles, type LocalDirectory, type LocalFileEntry, type ExternalReference } from "../lib/externalFiles";
import { prepareExplorerCanvasDrop } from "../lib/explorerCanvasDrop";
import { notifyError, notifySuccess } from "../lib/notify";
import { useStore } from "../store";
import { ConfirmDialog } from "./ConfirmDialog";

const LOCATION_KEY = "bowerbird.localFiles.lastDirectory";
function lastDirectory() { try { return localStorage.getItem(LOCATION_KEY) || undefined; } catch { return undefined; } }

function FilePreview({ path, revision }: { path: string; revision: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setSrc(null);
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      externalFiles.preview(path).then(value => { if (alive) setSrc(convertFileSrc(value)); }).catch(() => {});
    }, { rootMargin: "100px" });
    if (ref.current) observer.observe(ref.current);
    return () => { alive = false; observer.disconnect(); };
  }, [path, revision]);
  return <span className="local-file-preview" ref={ref}>{src ? <img src={src} alt="" draggable={false} /> : <Image size={24} aria-hidden="true" />}</span>;
}

export function LocalFileBrowser({ onClose, onCreateProject, initialTab = "files" }: { onClose: () => void; onCreateProject: () => void; initialTab?: "files" | "references" }) {
  const projectId = useStore(s => s.activeProjectId);
  const routePending = useStore(s => s.projectRoutePending);
  const [directory, setDirectory] = useState<LocalDirectory | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [pathInput, setPathInput] = useState(lastDirectory() ?? "");
  const [back, setBack] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"files" | "references">(initialTab);
  const [references, setReferences] = useState<ExternalReference[]>([]);
  const [confirmUpdate, setConfirmUpdate] = useState<ExternalReference | null>(null);
  const [selected, setSelected] = useState<LocalFileEntry | null>(null);
  const dragged = useRef<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const request = useRef(0);
  const mounted = useRef(true);
  const referenceRequest = useRef(0);

  async function navigate(path?: string, offset = 0, rememberBack = true) {
    const version = ++request.current;
    setLoading(true); setError(""); setSelected(null);
    try {
      const result = await externalFiles.browse(path, offset);
      if (!mounted.current || version !== request.current) return;
      if (!offset && rememberBack && directory && directory.path !== result.path) setBack(items => [...items, directory.path]);
      setDirectory(current => offset && current?.path === result.path ? { ...result, entries: [...current.entries, ...result.entries] } : result);
      if (!offset) setPreviewRevision(value => value + 1);
      setPathInput(result.path);
      try { localStorage.setItem(LOCATION_KEY, result.path); } catch { /* Session navigation still works. */ }
    } catch (reason) {
      if (mounted.current && version === request.current) setError(`无法打开文件夹：${String(reason)}。可以选择其他文件夹。`);
    } finally { if (mounted.current && version === request.current) setLoading(false); }
  }
  async function reloadReferences() {
    const id = useStore.getState().activeProjectId;
    const version = ++referenceRequest.current;
    if (!id) { setReferences([]); return; }
    try {
      const next = await externalFiles.references(id);
      if (mounted.current && version === referenceRequest.current && id === useStore.getState().activeProjectId) setReferences(next);
    } catch (reason) { if (mounted.current && version === referenceRequest.current) setError(String(reason)); }
  }
  useEffect(() => {
    mounted.current = true;
    if (initialTab === "files") void navigate(lastDirectory());
    const focus = requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".local-file-browser input")?.focus());
    return () => { cancelAnimationFrame(focus); mounted.current = false; request.current++; referenceRequest.current++; };
  }, []);
  useEffect(() => { setReferences([]); if (tab === "references") void reloadReferences(); }, [projectId, tab]);
  useEffect(() => {
    let alive = true;
    let cleanup: (() => void) | undefined;
    listen("external-files://changed", () => { if (tab === "references") void reloadReferences(); }).then(fn => { if (alive) cleanup = fn; else fn(); });
    return () => { alive = false; cleanup?.(); };
  }, [tab]);

  async function place(path: string, target: Element, x: number, y: number) {
    if (busyRef.current) return;
    const state = useStore.getState();
    if (!state.activeProjectId || state.projectRoutePending) { notifyError(null, "请先打开项目画板"); return; }
    // Freeze the actual canvas and position before indexing or any asynchronous work.
    const put = prepareExplorerCanvasDrop(target, state.activeProjectId, x, y);
    if (!put) { notifyError(null, "画板尚未就绪，请稍后重试"); return; }
    busyRef.current = true; setBusy(true); setError("");
    try {
      const asset = await externalFiles.index(path);
      await put(asset);
      notifySuccess("已引用原图片，未复制到素材库");
    } catch (reason) { notifyError(reason, "添加外部引用失败"); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  function addSelected() {
    const stage = document.querySelector<HTMLElement>(".canvas-stage:not(.is-view-hidden)");
    if (!selected || !stage) return;
    const bounds = stage.getBoundingClientRect();
    void place(selected.path, stage, bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
  }
  useEffect(() => {
    function over(event: DragEvent) {
      if (!dragged.current) return;
      const stage = event.target instanceof Element ? event.target.closest(".canvas-stage:not(.is-view-hidden)") : null;
      setDragOver(!!stage);
      if (!stage) return;
      event.preventDefault(); event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }
    function drop(event: DragEvent) {
      const path = dragged.current;
      dragged.current = null; setDragOver(false);
      if (!path || !(event.target instanceof Element)) return;
      const stage = event.target.closest(".canvas-stage:not(.is-view-hidden)");
      event.preventDefault(); event.stopPropagation();
      if (stage) void place(path, stage, event.clientX, event.clientY);
    }
    const end = () => { dragged.current = null; setDragOver(false); };
    window.addEventListener("dragover", over, true);
    window.addEventListener("drop", drop, true);
    window.addEventListener("dragend", end);
    window.addEventListener("blur", end);
    return () => { window.removeEventListener("dragover", over, true); window.removeEventListener("drop", drop, true); window.removeEventListener("dragend", end); window.removeEventListener("blur", end); };
  }, []);
  async function chooseDirectory() {
    try { const path = await open({ directory: true, multiple: false, defaultPath: directory?.path || lastDirectory() }); if (typeof path === "string") void navigate(path); }
    catch (reason) { setError(String(reason)); }
  }
  async function changeReference(reference: ExternalReference, action: "relink" | "update" | "copy") {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      if (action === "copy") await externalFiles.copy(reference.asset.id);
      else {
        const path = action === "relink" ? await open({ multiple: false, filters: [{ name: "图片或视频", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "mp4", "mov", "m4v", "webm", "mkv", "avi"] }] }) : reference.asset.store_path;
        if (typeof path !== "string") return;
        await externalFiles.update(reference.asset.id, path, action === "update");
      }
      await reloadReferences();
      notifySuccess(action === "copy" ? "已复制到素材库，原文件保留" : "外部引用已更新");
    } catch (reason) { setError(String(reason)); }
    finally { busyRef.current = false; if (mounted.current) { setBusy(false); setConfirmUpdate(null); } }
  }

  return <aside className="local-file-browser" style={initialTab === "references" ? {width:"100%",minHeight:240,maxHeight:"65vh",borderRight:0} : undefined} aria-label="本机文件资源管理器" aria-busy={busy}
    onKeyDown={event => { if (event.key === "Escape" && !confirmUpdate && !busy) { event.stopPropagation(); onClose(); } }}>
    <header><Monitor size={17} aria-hidden="true" /><strong>本机文件</strong><button type="button" title="关闭本机文件资源管理器" aria-label="关闭本机文件资源管理器" onClick={onClose}><X size={16} /></button></header>
    {initialTab === "files" && <div className="local-file-tabs" role="tablist" aria-label="本机文件视图">
      <button role="tab" aria-selected={tab === "files"} onClick={() => setTab("files")}>浏览文件</button>
      <button role="tab" aria-selected={tab === "references"} onClick={() => setTab("references")}>外部引用</button>
    </div>}
    {tab === "files" && <>
      <div className="local-file-navigation">
        <button title="返回上次目录" aria-label="返回上次目录" disabled={!back.length || loading} onClick={() => { const path = back[back.length - 1]; setBack(items => items.slice(0, -1)); void navigate(path, 0, false); }}><ArrowLeft size={16} /></button>
        <button title="上一级" aria-label="上一级" disabled={!directory?.parent || loading} onClick={() => void navigate(directory?.parent ?? undefined)}><ArrowUp size={16} /></button>
        <button title="选择文件夹" aria-label="选择文件夹" onClick={() => void chooseDirectory()}><FolderOpen size={16} /></button>
        <button title="刷新文件夹" aria-label="刷新文件夹" disabled={loading} onClick={() => void navigate(directory?.path || lastDirectory())}><RefreshCw size={15} /></button>
      </div>
      <form onSubmit={event => { event.preventDefault(); void navigate(pathInput); }}><input aria-label="文件夹路径" value={pathInput} onChange={event => setPathInput(event.target.value)} placeholder="输入文件夹路径，按回车打开" /></form>
    </>}
    {error && <div role="alert" className="local-file-error">{error}</div>}
    <div className="local-file-content">
      {tab === "files" ? <>
        <div className="local-file-grid">
          {directory?.entries.map(entry => <button type="button" key={entry.path} title={entry.name} aria-label={entry.directory ? `打开文件夹 ${entry.name}` : entry.name} aria-pressed={!entry.directory ? selected?.path === entry.path : undefined}
            className={`local-file-entry${selected?.path === entry.path ? " is-selected" : ""}`} draggable={!entry.directory && !busy}
            onClick={() => entry.directory ? void navigate(entry.path) : setSelected(entry)}
            onDragStart={event => { dragged.current = entry.path; setSelected(entry); event.dataTransfer.setData("text/plain", "bowerbird-external-image"); event.dataTransfer.effectAllowed = "copy"; }}>
            {entry.directory ? <span className="local-file-preview"><Folder size={32} aria-hidden="true" /></span> : <FilePreview path={entry.path} revision={previewRevision} />}
            <span>{entry.name}</span>
          </button>)}
        </div>
        {loading && <p role="status"><LoaderCircle size={15} className="animate-spin" /> 正在读取文件夹…</p>}
        {!loading && directory?.total === 0 && <p>此文件夹没有支持的图片或子文件夹。</p>}
        {directory && directory.entries.length < directory.total && <button className="app-button-secondary" disabled={loading} onClick={() => void navigate(directory.path, directory.entries.length)}>加载更多（{directory.entries.length}/{directory.total}）</button>}
      </> : <>
        <button className="app-button-secondary" disabled={busy || !projectId} onClick={() => void reloadReferences()}><RefreshCw size={13} /> 检查引用</button>
        {!references.length && <p>{projectId ? "当前项目还没有外部引用。" : "打开项目后可管理其外部图片引用。"}</p>}
        {references.map(reference => <article className="local-file-reference" key={reference.asset.id}>
          <strong>{reference.asset.name}</strong><span>{reference.status === "available" ? "原文件可用" : reference.status === "missing" ? "原文件失联" : "原文件已变化"}</span>
          <p title={reference.asset.store_path ?? ""}>{reference.asset.store_path}</p>
          <div><button disabled={busy} onClick={() => void changeReference(reference, "relink")}>重新定位</button>
            {reference.status === "changed" && <button disabled={busy} onClick={() => setConfirmUpdate(reference)}>更新引用</button>}
            <button disabled={busy || reference.status !== "available"} onClick={() => void changeReference(reference, "copy")}>复制到素材库</button></div>
        </article>)}
      </>}
    </div>
    <footer><p>{dragOver ? "松开即可引用到画板" : "浏览不入库 · 拖到画板引用原图片"}</p>
      {projectId ? <button className="app-button-primary" disabled={!selected || busy || routePending || tab !== "files"} onClick={addSelected}>{busy ? "正在处理…" : "添加到画板"}</button> : <button className="app-button-primary" onClick={onCreateProject}>新建画板</button>}
    </footer>
    {confirmUpdate && <ConfirmDialog open title="更新外部图片引用" message="将使用原文件的当前内容，并清除旧的反推结果。历史操作不会保留修改前的原图片。" confirmLabel="更新引用" confirmDisabled={busy} onConfirm={() => void changeReference(confirmUpdate, "update")} onCancel={() => { if (!busy) setConfirmUpdate(null); }} />}
  </aside>;
}
