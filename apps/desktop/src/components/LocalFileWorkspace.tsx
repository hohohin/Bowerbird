import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, ArrowUp, Check, ChevronRight, Copy, Folder, FolderOpen, Image, MoreHorizontal, Play, Plus, RefreshCw, X } from "lucide-react";
import { externalFiles, type LocalDirectory, type LocalFileEntry } from "../lib/externalFiles";
import { createFilePreviewQueue } from "../lib/filePreviewQueue";
import { fileWorkspace, prepareFileWorkspace, type FileWorkspaceStatus } from "../lib/fileWorkspace";
import { folderClassification, type FolderClassification } from "../lib/folderClassification";
import { globalClassification, localClassification, type ClassificationLabel, type GlobalClassificationView } from "../lib/localClassification";
import { FILE_COLORS, useFileColors } from "../lib/useFileColors";
import { useLocalFileMode } from "../lib/localFileMode";
import { useMasonryLayout } from "../lib/useMasonryLayout";
import { useThumbnailPinch } from "../lib/useThumbnailPinch";
import { isVideoPath } from "../lib/videoGeneration";
import { prepareExplorerCanvasDrop } from "../lib/explorerCanvasDrop";
import { useStore } from "../store";
import { notifyError, notifySuccess } from "../lib/notify";
import { Lightbox } from "./Lightbox";
import { LocalClassificationDialog } from "./LocalClassificationDialog";
import { LocalFileBrowser } from "./LocalFileBrowser";
import { ModalShell } from "./ModalShell";
import { ThumbnailSizeSlider } from "./ThumbnailSizeSlider";
import { OverlayScrollArea } from "./CollectionScrollArea";
import { TagIndex } from "./TagIndex";
import { LibraryTagFilter } from "./LibraryTagFilter";
import { FileRecordsDialog } from "./FileRecordsDialog";
import { FileWorkspaceMoveDialog } from "./FileWorkspaceMoveDialog";
import "./LocalFileWorkspace.css";

const KEY = "bowerbird.localFiles.lastDirectory";
const previews = createFilePreviewQueue(externalFiles.preview);
function lastPath() { try { return localStorage.getItem(KEY) || ""; } catch { return ""; } }
function normalize(path: string) { return path.replace(/^\\\\\?\\UNC\\/i, "//").replace(/^\\\\\?\\/, "").replace(/\\/g, "/").replace(/\/$/, ""); }
function relative(root: string, path: string) {
  const base = normalize(root); const file = normalize(path);
  return file.startsWith(base + "/") ? file.slice(base.length + 1) : null;
}

function breadcrumbs(path: string) {
  const value = normalize(path) || (path === "/" ? "/" : "");
  const root = value.match(/^(\/\/[^/]+\/[^/]+|[A-Za-z]:|\/)/)?.[0] ?? "";
  let current = root;
  return [ ...(root ? [{ name: root === "/" ? "根目录" : root, path: root.endsWith(":") ? root + "/" : root }] : []),
    ...value.slice(root.length).split("/").filter(Boolean).map(name => {
      current = current.replace(/\/$/, "") + "/" + name;
      return { name, path: current };
    }) ];
}

function FileCard({ entry, selected, revision, labels, onSelect, onOpen }: {
  entry: LocalFileEntry; selected: boolean; revision: number; labels: string[];
  onSelect: (additive: boolean, range: boolean) => void; onOpen: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const previewKey = `${entry.path}:${entry.version ?? revision}`;
  const [preview, setPreview] = useState<string | null>(() => entry.preview ?? previews.peek(previewKey) ?? null);
  const [failedPreview, setFailedPreview] = useState<string | null>(null);
  useEffect(() => {
    if (entry.directory) return;
    const cached = (entry.preview !== failedPreview ? entry.preview : null) ?? previews.peek(previewKey);
    if (cached) { previews.remember(previewKey, cached); setPreview(cached); return; }
    let alive = true; let priority = 1;
    let request: ReturnType<typeof previews.request> | undefined;
    setPreview(null);
    const visible = new IntersectionObserver(entries => {
      priority = entries.some(e => e.isIntersecting) ? 0 : 1;
      request?.priority(priority);
    });
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(e => e.isIntersecting)) { request?.cancel(); request = undefined; return; }
      if (request) return;
      const ready = previews.peek(previewKey);
      if (ready) { setPreview(ready); return; }
      request = previews.request(previewKey, entry.path, priority, path => { if (alive) setPreview(path); });
    }, { rootMargin: "400px" });
    if (ref.current) { visible.observe(ref.current); observer.observe(ref.current); }
    return () => { alive = false; request?.cancel(); visible.disconnect(); observer.disconnect(); };
  }, [entry.path, entry.directory, entry.preview, previewKey, failedPreview]);
  return <button ref={ref} type="button" className={`folder-media-card${selected ? " is-selected" : ""}`} aria-pressed={selected}
    aria-label={entry.directory ? `文件夹 ${entry.name}` : entry.name} title={[entry.path, labels.map(name => `#${name}`).join(" · ")].filter(Boolean).join("\n")}
    onClick={e => onSelect(e.ctrlKey || e.metaKey, e.shiftKey)} onDoubleClick={onOpen}
    onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); onOpen(); } }}>
    <span className={`folder-media-preview${entry.directory ? " is-folder" : ""}`}>
      {entry.directory ? <Folder size={52} strokeWidth={1.3} /> : preview ? <img src={convertFileSrc(preview)} alt="" draggable={false} loading="lazy" decoding="async" onError={() => { previews.forget(previewKey); setFailedPreview(preview); setPreview(null); }} /> : isVideoPath(entry.path) ? <Play size={32} /> : <Image size={32} />}
      {!entry.directory && isVideoPath(entry.path) && <span className="folder-media-kind"><Play size={11} />视频</span>}
    </span>
    {entry.directory && <span className="folder-media-name">{entry.name}</span>}
  </button>;
}

export function LocalFileWorkspace({ onClose, onCreateProject, navigation, closeAction, onLegacy }: { onClose: () => void; onCreateProject?: () => Promise<unknown>; navigation?: ReactNode; closeAction?: ReactNode; onLegacy?: () => void }) {
  const [locations, setLocations] = useState<FileWorkspaceStatus | null>(null);
  const mode = useLocalFileMode(s => s.mode);
  const [allLocations, setAllLocations] = useState(() => useLocalFileMode.getState().mode === "global");
  const globalRequest = useLocalFileMode(s => s.globalRequest);
  const [directory, setDirectory] = useState<LocalDirectory | null>(null);
  const [pathInput, setPathInput] = useState(lastPath);
  const [editingPath, setEditingPath] = useState(false);
  const [panel, setPanel] = useState<"locations" | "actions" | "colors" | null>(null);
  const header = useRef<HTMLDivElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const addressButton = useRef<HTMLDivElement>(null);
  const colorsButton = useRef<HTMLButtonElement>(null);
  const navigationHost = useLocalFileMode(s => s.navigationHost);
  const [color, setColor] = useState<string | null>(null);
  const [media, setMedia] = useState<"image" | "video" | null>(null);
  const locationsButton = useRef<HTMLButtonElement>(null);
  const actionsButton = useRef<HTMLButtonElement>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [classification, setClassification] = useState<FolderClassification | null>(null);
  const [globalView, setGlobalView] = useState<GlobalClassificationView | null>(null);
  const [globalLabels, setGlobalLabels] = useState<ClassificationLabel[]>([]);
  const [globalLabelsError, setGlobalLabelsError] = useState(false);
  const [tag, setTag] = useState<string | null>(null);
  const [taggedEntries, setTaggedEntries] = useState<LocalFileEntry[]>([]);
  const [tagLoading, setTagLoading] = useState(false);
  const [tagError, setTagError] = useState("");
  const [classifyOpen, setClassifyOpen] = useState(false);
  const [classificationView, setClassificationView] = useState<"classification" | "labels">("classification");
  const manageButton = useRef<HTMLButtonElement>(null);
  const [referencesOpen, setReferencesOpen] = useState(false);
  const [recordsRoot, setRecordsRoot] = useState<string | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const busyRef = useRef(false);
  const sequence = useRef(0);
  const previewSequence = useRef(0);
  const alive = useRef(true);
  const [grid, setGrid] = useState<HTMLDivElement | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const query = useLocalFileMode(s => s.query);
  const width = useStore(s => s.libraryThumbnailWidth);
  const project = useStore(s => s.activeProjectId);
  const pinchRef = useThumbnailPinch("library");
  const pictures = useMemo(() => new Map(classification?.record.pictures.map(p => [p.path, p]) ?? []), [classification]);
  const globalPictures = useMemo(() => new Map(globalView?.pictures.map(p => [p.path, p]) ?? []), [globalView]);
  const labels = allLocations ? globalLabels : classification?.record.labels ?? [];
  const labelNames = new Map(labels.map(l => [l.id,l.name]));
  const scopeEntries = useMemo(() => (tag && !allLocations ? taggedEntries : directory?.entries ?? []).filter(entry =>
    (!allLocations || !tag || globalPictures.get(entry.path)?.tags.includes(tag)) &&
    (!query || entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  ), [directory, query, tag, taggedEntries, allLocations, globalPictures]);
  const palette = useFileColors(scopeEntries, panel === "colors" || !!color, revision);
  const entries = useMemo(() => scopeEntries.filter(entry =>
    (!media || (!entry.directory && (media === "video" ? isVideoPath(entry.path) : !isVideoPath(entry.path))))
    && (!color || (!entry.directory && palette.colors.get(entry.path)?.includes(color)))
  ), [scopeEntries, media, color, palette.colors]);
  const busy = loading || (!!tag && tagLoading);
  const [showLoading, setShowLoading] = useState(false);
  useEffect(() => {
    if (!busy) { setShowLoading(false); return; }
    const timer = window.setTimeout(() => setShowLoading(true), 250);
    return () => window.clearTimeout(timer);
  }, [busy]);
  // Polling the catalog should not repeat filesystem checks unless matches change.
  const tagRevision = JSON.stringify(tag && classification ? [classification.root, classification.record.recursive,
    classification.record.pictures.filter(p => p.tags.some(([id]) => id === tag)).map(p => [p.path, p.fingerprint])] : null);
  useEffect(() => {
    setTaggedEntries([]); setTagError(""); setTagLoading(false);
    if (!tag || !directory || allLocations) return;
    let current = true;
    setTagLoading(true);
    void folderClassification.images(directory.path, tag).then(value => {
      if (current) setTaggedEntries(value);
    }).catch(e => { if (current) setTagError(`无法读取标签图片：${String(e)}`); })
      .finally(() => { if (current) setTagLoading(false); });
    return () => { current = false; };
  }, [directory?.path, tag, tagRevision, revision, allLocations]);
  useEffect(() => {
    setSelected(new Set()); anchor.current = null;
    if (scroll.current) scroll.current.scrollTop = 0;
  }, [tag, query, color, media]);
  useMasonryLayout(grid, width, entries, project ? 8 : 4);

  function editPath() {
    if (editingPath) { addressInput.current?.focus(); addressInput.current?.select(); return; }
    setPanel(null); setPathInput(directory?.path ?? ""); setEditingPath(true);
  }
  function closePanel() {
    (panel === "locations" ? locationsButton : panel === "colors" ? colorsButton : actionsButton).current?.focus({ preventScroll: true });
    setPanel(null);
  }
  function menuAction(action: () => void) { closePanel(); action(); }
  useEffect(() => {
    function focusAddress(event: KeyboardEvent) {
      if (mode !== "files" || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "l"
        || document.querySelector('[role="dialog"], [role="menu"]')
        || !header.current || header.current.closest('[inert]') || getComputedStyle(header.current).visibility === "hidden") return;
      event.preventDefault(); event.stopPropagation(); editPath();
    }
    window.addEventListener("keydown", focusAddress, true);
    return () => window.removeEventListener("keydown", focusAddress, true);
  }, [directory?.path, editingPath, mode]);
  useEffect(() => {
    if (editingPath) { addressInput.current?.focus(); addressInput.current?.select(); }
  }, [editingPath]);
  useEffect(() => {
    if (!panel) return;
    header.current?.querySelector<HTMLButtonElement>('.folder-popover button:not(:disabled)')?.focus({ preventScroll: true });
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!header.current?.querySelector('.folder-popover')?.contains(target)
        && !locationsButton.current?.contains(target) && !actionsButton.current?.contains(target) && !colorsButton.current?.contains(target)) setPanel(null);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [panel]);

  async function changePlace(path: string, added: boolean) {
    try {
      const config = await fileWorkspace.place(path, added);
      if (alive.current) setLocations(previous => previous ? { ...previous, config } : null);
      if (alive.current && allLocations) await showAll();
    } catch (error) { notifyError(error, "保存常用位置失败"); }
  }
  async function openDefault() {
    try {
      const path = await prepareFileWorkspace();
      if (!alive.current) return;
      setLocations(await fileWorkspace.status());
      await navigate(path);
    } catch (error) { notifyError(error, "打开资料目录失败"); }
  }
  async function showAll() {
    const version = ++sequence.current; ++previewSequence.current;
    setLoading(true); setError(""); setPreview(null); setSelected(new Set()); anchor.current = null;
    setTag(null); setClassification(null); setGlobalView(null);
    try {
      const result = await fileWorkspace.all();
      if (!alive.current || version !== sequence.current) return;
      setAllLocations(true); setEditingPath(false);
      useLocalFileMode.getState().setMode("global");
      setHistory([]);
      setDirectory({ path: "", parent: null, entries: result.entries, total: result.entries.length });
      setPathInput(""); setRevision(value => value + 1);
      if (scroll.current) scroll.current.scrollTop = 0;
      if (result.unavailable.length) setError(`部分位置不可用，已保留其登记：${result.unavailable.join("；")}`);
    } catch (error) { if (alive.current && version === sequence.current) { setError(String(error)); if (directory) useLocalFileMode.getState().setMode(allLocations ? "global" : "files"); } }
    finally { if (alive.current && version === sequence.current) setLoading(false); }
  }
  async function navigate(path?: string, back = false) {
    const version = ++sequence.current; ++previewSequence.current;
    setLoading(true); setError(""); setPreview(null); setSelected(new Set()); anchor.current = null;
    try {
      // One enumeration includes the whole current level; previews remain lazy.
      const result = await externalFiles.browseAll(path);
      if (!alive.current || version !== sequence.current) return;
      if (back) setHistory(h => h.slice(0,-1));
      else if (directory?.path && directory.path !== result.path) setHistory(h => [...h,directory.path]);
      setAllLocations(false); setDirectory(result); setPathInput(result.path); setEditingPath(false); setTag(null); setClassification(null); setRevision(r => r+1);
      useLocalFileMode.getState().setMode("files");
      setLoading(false);
      if (scroll.current) scroll.current.scrollTop = 0;
      try { localStorage.setItem(KEY,result.path); } catch { /* Session browsing remains available. */ }
      try {
        const next = await folderClassification.view(result.path);
        if (alive.current && version === sequence.current) setClassification(next);
      } catch (e) { if (alive.current && version === sequence.current) setError(String(e)); }
    } catch (e) { if (alive.current && version === sequence.current) { setError(`无法打开文件夹：${String(e)}`); if (directory) useLocalFileMode.getState().setMode(allLocations ? "global" : "files"); } }
    finally { if (alive.current && version === sequence.current) setLoading(false); }
  }
  useEffect(() => {
    alive.current = true;
    setPanel(null); setColor(null); setMedia(null); setTag(null); setEditingPath(false);
    const version = sequence.current;
    void fileWorkspace.status().then(value => {
      if (!alive.current) return;
      setLocations(value);
      if (version === sequence.current) {
        if (useLocalFileMode.getState().mode === "files") void navigate(lastPath() || value.config.root || undefined);
        else void showAll();
      }
    }).catch(e => { if (alive.current && version === sequence.current) setError(String(e)); });
    return () => { alive.current = false; sequence.current++; previewSequence.current++; };
  }, [globalRequest]);
  useEffect(() => {
    if (!directory || allLocations || classifyOpen) return;
    let current = true;
    const reload = () => folderClassification.view(directory.path).then(value => {
      if (current) { setClassification(value); setTag(id => value.record.labels.some(l => l.id === id) ? id : null); }
    }).catch(() => {});
    void reload(); const timer = window.setInterval(() => void reload(), 3000);
    return () => { current = false; window.clearInterval(timer); };
  }, [directory?.path, classifyOpen, allLocations]);
  useEffect(() => {
    if (mode !== "global") return;
    let current = true; let fetching = false;
    const reload = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const labels = await localClassification.labels();
        if (current) {
          setGlobalLabels(previous => JSON.stringify(previous) === JSON.stringify(labels) ? previous : labels);
          setGlobalLabelsError(false);
        }
      } catch { if (current) setGlobalLabelsError(true); }
      finally { fetching = false; }
    };
    void reload(); const timer = window.setInterval(() => void reload(), 3000);
    return () => { current = false; window.clearInterval(timer); };
  }, [mode, classifyOpen, revision]);
  useEffect(() => {
    if (!directory || !allLocations) return;
    let current = true; let fetching = false;
    const reload = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const value = await globalClassification.view(directory.entries.map(entry => entry.path));
        if (current) {
          setGlobalView(previous => JSON.stringify(previous) === JSON.stringify(value) ? previous : value);
          setTagError(""); setTag(id => value.labels.some(l => l.id === id) ? id : null);
        }
      } catch (e) { if (current) setTagError(`无法读取全局分类：${String(e)}`); }
      finally { fetching = false; }
    };
    void reload(); const timer = window.setInterval(() => void reload(), 3000);
    return () => { current = false; window.clearInterval(timer); };
  }, [directory, allLocations, classifyOpen]);
  async function choose() {
    try { const path = await open({ directory: true, multiple: false, title: "选择文件夹", defaultPath: directory?.path || lastPath() || undefined }); if (typeof path === "string") void navigate(path); }
    catch (e) { setError(String(e)); }
  }
  async function openEntry(entry: LocalFileEntry) {
    if (entry.directory) { void navigate(entry.path); return; }
    const version = ++previewSequence.current;
    try { const path = await externalFiles.media(entry.path); if (alive.current && version === previewSequence.current) setPreview(path); }
    catch (e) { if (alive.current && version === previewSequence.current) setError(String(e)); }
  }
  async function useSelected(copy: boolean) {
    if (busyRef.current) return;
    const files = entries.filter(e => !e.directory && selected.has(e.path));
    if (!files.length) return;
    const destinationProject = useStore.getState().activeProjectId;
    busyRef.current = true; setWorking(true); setError("");
    try {
      const assets = [];
      if (copy) await prepareFileWorkspace();
      for (const file of files) { const asset = await externalFiles.index(file.path); assets.push(copy ? await externalFiles.copy(asset.id) : asset); }
      if (!copy) {
        if (useStore.getState().activeProjectId !== destinationProject) throw new Error("项目已切换，请重新选择目标画板");
        if (!destinationProject) await onCreateProject?.();
        const id = useStore.getState().activeProjectId;
        if (!id) throw new Error("请先打开项目画板");
        onClose();
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const stage = document.querySelector<HTMLElement>(".canvas-stage:not(.is-view-hidden)");
        if (!stage) throw new Error("画板尚未就绪，请重试");
        const rect = stage.getBoundingClientRect();
        for (let i=0;i<assets.length;i++) {
          const put = prepareExplorerCanvasDrop(stage,id,rect.left+rect.width/2+i*24,rect.top+rect.height/2+i*24);
          if (!put) throw new Error("画板已切换，请重试");
          await put(assets[i]);
        }
      }
      notifySuccess(copy ? "已复制到收集箱，原文件保留" : "已添加到画板，引用原文件");
    } catch (e) { notifyError(e,"处理所选文件失败"); }
    finally { busyRef.current = false; if (alive.current) setWorking(false); }
  }
  useLayoutEffect(() => {
    // Move focus off the source tab that is now inside a hidden preserved workspace.
    if (navigation) document.querySelector<HTMLButtonElement>('.local-file-workspace [role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
  }, []);
  const selectedFiles = useMemo(() => new Set([...selected].flatMap(path => {
    if (allLocations) { const picture = globalPictures.get(path); return picture ? [picture.id] : []; }
    const key = classification && relative(classification.root,path); const picture = key && pictures.get(key); return picture ? [picture.id] : [];
  })), [selected, classification, pictures, allLocations, globalPictures]);
  const mediaSelected = entries.filter(e => !e.directory && selected.has(e.path)).length;
  const addressNavigation = <div className="folder-navigation">
      <div className="folder-history">
      <button aria-label="返回上次目录" title="返回" disabled={!history.length || loading} onClick={() => void navigate(history[history.length-1],true)}><ArrowLeft size={17}/></button>
      <button aria-label="上一级" title="上一级" disabled={!directory?.parent || loading} onClick={() => void navigate(directory?.parent ?? undefined)}><ArrowUp size={17}/></button>
      </div>
      <div ref={addressButton} className="folder-address" tabIndex={0} role="group" aria-label="文件夹地址栏"
        title="点击空白处编辑路径 · Ctrl / ⌘ + L" onClick={e => { if (!(e.target as Element).closest("button, input")) editPath(); }}
        onKeyDown={e => { if (e.target === e.currentTarget && ["Enter", " "].includes(e.key)) { e.preventDefault(); editPath(); } }}>
        <form data-folder-path-editor hidden={!editingPath} onSubmit={e => { e.preventDefault(); if (pathInput.trim()) void navigate(pathInput.trim()); }}>
          <input ref={addressInput} aria-label="文件夹路径" placeholder="输入或粘贴文件夹路径" spellCheck={false} value={pathInput}
            onChange={e => setPathInput(e.target.value)} onBlur={() => { setEditingPath(false); setPathInput(directory?.path ?? ""); }}
            onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setEditingPath(false); setPathInput(directory?.path ?? ""); addressButton.current?.focus(); } }} />
        </form>
        {!editingPath && <>
          <nav className="folder-breadcrumbs" aria-label="当前文件夹" title={directory?.path}>
            <button type="button" aria-label="选择浏览文件夹" title="选择文件夹" disabled={loading} onClick={() => void choose()}><FolderOpen size={16} aria-hidden="true" /></button>
            {breadcrumbs(directory?.path || lastPath()).map((part, index, parts) => <span className="folder-crumb" key={part.path}>
              {index > 0 && <ChevronRight size={12} aria-hidden="true" />}
              <button title={part.path} aria-current={index === parts.length - 1 ? "location" : undefined} onClick={() => void navigate(part.path)}>{part.name}</button>
            </span>)}
          </nav>
        </>}
      <button className={loading ? "is-loading" : ""} aria-label="刷新文件夹" title="刷新" disabled={loading} onClick={() => void (allLocations ? showAll() : navigate(directory?.path))}><RefreshCw size={16}/></button>
      </div>
    </div>;
  return <section className="local-file-workspace" aria-label="本机文件" ref={pinchRef} aria-busy={busy}
    onKeyDown={e => {
      if (e.target instanceof Element && e.target.closest('input,textarea,[contenteditable="true"],[role="dialog"]')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { e.preventDefault(); e.stopPropagation(); setSelected(new Set(entries.map(entry => entry.path))); }
      if (e.altKey && e.key === "ArrowUp" && directory?.parent) { e.preventDefault(); void navigate(directory.parent); }
    }}>
    {mode === "files" && (navigationHost ? createPortal(addressNavigation, navigationHost) : addressNavigation)}
    <div className="file-view-heading">
      {navigation}
      <div className="folder-floating-controls" ref={header}>
      {tag && labelNames.has(tag) && <LibraryTagFilter name={labelNames.get(tag)!} onClear={() => setTag(null)} />}
      <button ref={locationsButton} className="library-filter-trigger" title="文件位置" aria-label="文件位置" aria-expanded={panel === "locations"} aria-haspopup="dialog" onClick={() => setPanel(panel === "locations" ? null : "locations")}><FolderOpen size={14}/></button>
      <button ref={colorsButton} className="library-filter-trigger" aria-label="颜色筛选" title="颜色筛选" data-active={!!color || undefined} aria-expanded={panel === "colors"} aria-haspopup="dialog" onClick={() => setPanel(panel === "colors" ? null : "colors")}>
        <span className="library-rgb-orb" aria-hidden="true"/>{color && <span className="library-filter-dot"/>}
      </button>
      <button ref={actionsButton} className="library-filter-trigger" data-active={!!media || undefined} aria-label="更多文件操作" title="更多" aria-expanded={panel === "actions"} aria-haspopup="dialog" onClick={() => setPanel(panel === "actions" ? null : "actions")}><MoreHorizontal size={16}/></button>
      {!navigation && <button className="folder-return" onClick={onClose}><X size={15}/>{project ? "返回画板" : "返回素材库"}</button>}
      {panel && <div className="folder-popover" role="dialog" aria-label={panel === "locations" ? "文件位置" : panel === "colors" ? "颜色筛选" : "更多文件操作"}
        onBlur={e => { if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node) && !header.current?.contains(e.relatedTarget as Node)) setPanel(null); }}
        onKeyDown={e => {
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePanel(); }
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
            e.preventDefault(); e.stopPropagation();
            const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            buttons[e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
          }
        }}>
        {panel === "colors" ? <>
          <div className="folder-menu-label">颜色筛选</div>
          <div className="file-color-swatches">{FILE_COLORS.map(([key, label, hex]) => <button key={key} aria-label={label} aria-pressed={color === key} title={label} style={{ background: hex }} onClick={() => setColor(color === key ? null : key)}>{color === key && <Check size={12}/>}</button>)}</div>
          {palette.pending && <p className="folder-menu-label" role="status">正在读取颜色…</p>}
          {!!palette.failed && <button onClick={palette.retry}>{palette.failed} 项读取失败 · 重试</button>}
          {color && <button onClick={() => setColor(null)}>清除颜色筛选</button>}
        </> : panel === "locations" ? <>
          <button disabled={loading} aria-pressed={allLocations} onClick={() => menuAction(() => void showAll())}>全局素材</button>
          <button disabled={loading} onClick={() => menuAction(() => void openDefault())}>资料文件夹</button>
          <button onClick={() => menuAction(() => void choose())}><FolderOpen size={15}/>选择文件夹…</button>
          {!!locations?.config.places.length && <div className="folder-menu-label">常用位置</div>}
          {locations?.config.places.map(path => <div className="file-location" key={path}>
            <button title={path} aria-pressed={!allLocations && directory?.path === path} onClick={() => menuAction(() => void navigate(path))}>{path.split(/[\\/]/).filter(Boolean).slice(-1)[0]}</button>
            <button aria-label={`移除常用位置 ${path}`} title="移除常用位置" onClick={() => void changePlace(path, false)}><X size={13}/></button>
          </div>)}
          <div className="folder-menu-divider"/>
          <button disabled={!directory?.path || loading || locations?.config.places.includes(directory.path)} onClick={() => void changePlace(directory!.path, true)}><Plus size={15}/>添加当前目录</button>
        </> : <>
          {allLocations && <button disabled={loading} onClick={() => menuAction(() => void showAll())}><RefreshCw size={15}/>刷新素材</button>}
          <div className="folder-menu-label">素材类型</div>
          <div className="file-media-options" role="group" aria-label="素材类型筛选">
            <button aria-pressed={media === null} onClick={() => setMedia(null)}>全部</button>
            <button aria-label="只看图片" aria-pressed={media === "image"} onClick={() => setMedia(media === "image" ? null : "image")}>图片</button>
            <button aria-label="只看视频" aria-pressed={media === "video"} onClick={() => setMedia(media === "video" ? null : "video")}>视频</button>
          </div>
          <div className="folder-menu-divider"/>
          <button disabled={(!allLocations && !classification) || loading} onClick={() => menuAction(() => { setClassificationView("classification"); setClassifyOpen(true); })}>{allLocations ? "自动分类全局素材" : "自动分类此文件夹"}</button>
          <button disabled={(!allLocations && !classification) || loading} onClick={() => menuAction(() => { setClassificationView("labels"); setClassifyOpen(true); })}>管理分类数据</button>
          <div className="folder-menu-divider"/>
          <button disabled={!directory || allLocations || loading} onClick={() => menuAction(() => directory && setRecordsRoot(directory.path))}>随图资料</button>
          <button onClick={() => menuAction(() => setReferencesOpen(true))}>外部引用</button>
          <button onClick={() => menuAction(() => setMoveOpen(true))}>迁移资料目录</button>
          {onLegacy && <button onClick={() => menuAction(onLegacy)}>历史素材</button>}
        </>}
      </div>}
      </div>
    </div>
    {closeAction && <div className="canvas-source-close">{closeAction}</div>}
    {error && <p role="alert" className="folder-error">{error}</p>}
    {locations?.migration?.state === "failed" && <p role="alert" className="folder-error">资料目录迁移未完成：{locations.migration.error}</p>}
    {(allLocations || tag) && tagError && <p role="alert" className="folder-error">{tagError}</p>}
    <div className="library-browser-grid folder-browser-grid">
    <TagIndex key={directory?.path} tags={labels} active={tag} onSelect={setTag}
      failed={allLocations && globalLabelsError} onRetry={() => setRevision(value => value + 1)}
      disabled={(!allLocations && !classification) || loading} manageButtonRef={manageButton}
      onManage={() => { setClassificationView("labels"); setClassifyOpen(true); }} />
    <OverlayScrollArea scrollRef={scroll} className="folder-scroll-area" viewportClassName="folder-scroller library-scroller" label="文件夹素材滚动条">
      {color && palette.pending && <p className="folder-empty" role="status">正在筛选颜色…</p>}
      {busy && showLoading && <p className="folder-loading" role="status">{tag ? "正在读取标签图片…" : mode === "global" ? "正在读取全局素材…" : "正在读取文件夹…"}</p>}
      {!busy && !palette.pending && !tagError && !entries.length && <p className="folder-empty">{color || media ? "没有符合筛选条件的素材，可更换或清除筛选。" : tag ? "没有匹配的图片，可切换标签或清除筛选。" : query ? "没有匹配的媒体。" : allLocations ? "暂无全局素材。切换到文件浏览器，并在文件位置菜单中添加目录。" : "此文件夹没有支持的图片、视频或子文件夹。"}</p>}
      <div ref={setGrid} className="folder-masonry" aria-label={tag ? "标签图片" : "目录内容"}>
        {mode === (allLocations ? "global" : "files") && entries.map(entry => <FileCard key={entry.path} entry={entry} selected={selected.has(entry.path)} revision={revision}
          labels={(allLocations ? globalPictures.get(entry.path)?.tags ?? [] : pictures.get(relative(classification?.root ?? "",entry.path) ?? "")?.tags.map(([id]) => id) ?? []).map(id => labelNames.get(id) ?? "").filter(Boolean)}
          onSelect={(additive, range) => {
            const start = entries.findIndex(item => item.path === anchor.current);
            if (range && start >= 0) { const end = entries.indexOf(entry); setSelected(new Set(entries.slice(Math.min(start,end),Math.max(start,end)+1).map(item => item.path))); }
            else { anchor.current = entry.path; setSelected(previous => { const next = new Set(additive ? previous : []); if (additive && next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; }); }
          }}
          onOpen={() => { if (!busy) void openEntry(entry); }} />)}
      </div>
    </OverlayScrollArea>
    {mediaSelected > 0 && <div className="folder-selection-bar" role="group" aria-label="所选文件操作">
      <button aria-label="取消文件选择" title="取消选择" disabled={working} onClick={() => setSelected(new Set())}><X size={14}/></button>
      <span>已选 {mediaSelected} 项</span>
      <button disabled={working || busy} onClick={() => void useSelected(true)}><Copy size={14}/><span>复制到收集箱</span></button>
      <button className="folder-selection-primary" disabled={working || busy} onClick={() => void useSelected(false)}><Plus size={14}/><span>{project ? "添加到画板" : "新建画板并引用"}</span></button>
    </div>}
    <ThumbnailSizeSlider scope="library"/>
    </div>
    {preview && <Lightbox images={[preview]} index={0} onIndexChange={() => {}} onClose={() => { ++previewSequence.current; setPreview(null); }}/>}
    {classifyOpen && (allLocations || classification) && <LocalClassificationDialog initialView={classificationView} globalScope={allLocations} globalPaths={allLocations ? directory?.entries.map(entry => entry.path) : undefined} folder={!allLocations && classification ? { root: classification.root, recursive: classification.record.recursive } : undefined} selectedFiles={selectedFiles}
      onFilter={setTag} onClose={() => { setClassifyOpen(false); manageButton.current?.focus({ preventScroll: true }); }}/>}
    {referencesOpen && <ModalShell title="外部引用" width="lg" onClose={() => setReferencesOpen(false)}><LocalFileBrowser initialTab="references" onClose={() => setReferencesOpen(false)} onCreateProject={() => void onCreateProject?.()}/></ModalShell>}
    {recordsRoot && <FileRecordsDialog root={recordsRoot} onClose={() => setRecordsRoot(null)} onRestored={() => setRevision(value => value + 1)} />}
    {moveOpen && <FileWorkspaceMoveDialog onClose={() => setMoveOpen(false)} />}
  </section>;
}
