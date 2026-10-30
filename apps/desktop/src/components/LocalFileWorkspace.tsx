import { useLibraryModeStore, useLibraryPane, useLibraryThumbnail, useActiveLibraryPane } from "../lib/libraryPane";
import { userErrorMessage } from "../lib/userError";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ContextMenu } from "./ContextMenu";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, ArrowUp, ChevronRight, Copy, FolderOpen, MoreHorizontal, Plus, RefreshCw, X } from "lucide-react";
import { externalFiles, type LocalDirectory, type LocalFileEntry } from "../lib/externalFiles";
import { FileMediaCard } from "./FileMediaCard";
import { FileColorFilter } from "./FileColorFilter";
import { LibraryFloatingControls } from "./LibraryFloatingControls";
import { useLibraryGlass } from "./useLibraryGlass";
import { LibraryMotion } from "./LibraryMotion";
import { LibraryTacticalBackdrop } from "./LibraryTacticalBackdrop";
import { fileWorkspace, prepareFileWorkspace, type FileWorkspaceStatus } from "../lib/fileWorkspace";
import { folderClassification, type FolderClassification } from "../lib/folderClassification";
import { globalClassification, localClassification, type ClassificationLabel, type GlobalClassificationView } from "../lib/localClassification";
import { useFileColors } from "../lib/useFileColors";
import { useMasonryLayout } from "../lib/useMasonryLayout";
import { useThumbnailPinch } from "../lib/useThumbnailPinch";
import { isVideoPath } from "../lib/videoGeneration";
import { addMaterialAssets } from "../lib/materialActions";
import { useStore } from "../store";
import { notifyError, notifySuccess } from "../lib/notify";
import { Lightbox } from "./Lightbox";
import { LocalClassificationDialog } from "./LocalClassificationDialog";
import { LocalFileBrowser } from "./LocalFileBrowser";
import { ModalShell } from "./ModalShell";
import { ThumbnailSizeSlider } from "./ThumbnailSizeSlider";
import { OverlayScrollArea } from "./CollectionScrollArea";
import { LibraryBrowserButton } from "./LibraryBrowserButton";
import { LibraryTagFilter } from "./LibraryTagFilter";
import { FileRecordsDialog } from "./FileRecordsDialog";
import { FileWorkspaceMoveDialog } from "./FileWorkspaceMoveDialog";
import "./LocalFileWorkspace.css";

const KEY = "bowerbird.localFiles.lastDirectory";
function lastPath(key = KEY) { try { return localStorage.getItem(key) ?? localStorage.getItem(KEY) ?? ""; } catch { return ""; } }
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

export function LocalFileWorkspace({ onClose, onCreateProject, navigation, onLegacy, toolbarActions }: { onClose: () => void; onCreateProject?: (assetIds?: string[]) => Promise<unknown>; navigation?: ReactNode; toolbarActions?: ReactNode; onLegacy?: () => void }) {
  const useLocalFileMode = useLibraryModeStore();
  const pane = useLibraryPane();
  const pathKey = pane ? `${KEY}.${pane.id}` : KEY;
  const glass = useLibraryGlass();
  const [locations, setLocations] = useState<FileWorkspaceStatus | null>(null);
  const [savingPlace, setSavingPlace] = useState(false);
  const placePending = useRef(false);
  const mode = useLocalFileMode(s => s.mode);
  const [allLocations, setAllLocations] = useState(() => useLocalFileMode.getState().mode === "global");
  const globalRequest = useLocalFileMode(s => s.globalRequest);
  const [directory, setDirectory] = useState<LocalDirectory | null>(null);
  const [pathInput, setPathInput] = useState(() => lastPath(pathKey));
  const [editingPath, setEditingPath] = useState(false);
  const [panel, setPanel] = useState<"actions" | "colors" | null>(null);
  const header = useRef<HTMLDivElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const addressButton = useRef<HTMLDivElement>(null);
  const colorsButton = useRef<HTMLButtonElement>(null);
  const sharedNavigationHost = useLocalFileMode(s => s.navigationHost);
  const navigationHost = pane ? null : sharedNavigationHost;
  const [color, setColor] = useState<string | null>(null);
  const [media, setMedia] = useState<"image" | "video" | null>(null);
  const actionsButton = useRef<HTMLButtonElement>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [multiSelect, setMultiSelect] = useState(false);
  const anchor = useRef<string | null>(null);
  const [classification, setClassification] = useState<FolderClassification | null>(null);
  const [globalView, setGlobalView] = useState<GlobalClassificationView | null>(null);
  const [globalLabels, setGlobalLabels] = useState<ClassificationLabel[]>([]);
  const [, setGlobalLabelsError] = useState(false);
  const [tag, setTag] = useState<string | null>(null);
  const [taggedEntries, setTaggedEntries] = useState<LocalFileEntry[]>([]);
  const [tagLoading, setTagLoading] = useState(false);
  const [tagError, setTagError] = useState("");
  const [classifyOpen, setClassifyOpen] = useState(false);
  const [classificationView, setClassificationView] = useState<"classification" | "labels">("classification");
  const [referencesOpen, setReferencesOpen] = useState(false);
  const [recordsRoot, setRecordsRoot] = useState<string | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const busyRef = useRef(false);
  const sequence = useRef(0);
  const previewSequence = useRef(0);
  const menuSequence = useRef(0);
  const [preparingMenu, setPreparingMenu] = useState<{ x: number; y: number; count: number; version: number } | null>(null);
  const alive = useRef(true);
  const [grid, setGrid] = useState<HTMLDivElement | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const query = useLocalFileMode(s => s.query);
  const { width } = useLibraryThumbnail("library");
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
    setSelected(new Set()); setMultiSelect(false); anchor.current = null;
    if (scroll.current) scroll.current.scrollTop = 0;
  }, [tag, query, color, media]);
  useMasonryLayout(grid, width, entries, project ? 8 : 4);

  useEffect(() => {
    // A delayed file lookup must not reopen a menu after dismissal or a source change.
    const cancel = () => { menuSequence.current++; setPreparingMenu(null); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" || event.key === "Tab") cancel(); };
    window.addEventListener("pointerdown", cancel, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      cancel();
      window.removeEventListener("pointerdown", cancel, true);
      window.removeEventListener("keydown", onKey, true);
      if (useStore.getState().contextMenu?.fileSelection) useStore.getState().closeContextMenu();
    };
  }, [mode, directory?.path, tag, query, color, media, project]);

  useEffect(() => {
    if (!directory || mode !== (allLocations ? "global" : "files")) return;
    let current = true; let request = 0; let timer: number | undefined;
    const unlisten = listen("library://assets-changed", () => {
      const version = ++request;
      window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        try {
          const next = allLocations
            ? { ...directory, entries: (await fileWorkspace.all()).entries }
            : await externalFiles.browseAll(directory.path);
          if (!current || version !== request) return;
          setDirectory(next); setRevision(value => value + 1);
          setSelected(previous => new Set([...previous].filter(path => next.entries.some(entry => entry.path === path))));
        } catch (error) { if (current && version === request) notifyError(error, "刷新素材失败"); }
      }, 150);
    });
    return () => { current = false; window.clearTimeout(timer); void unlisten.then(stop => stop()); };
  }, [mode, directory?.path, allLocations]);

  function finishSelection() { setSelected(new Set()); setMultiSelect(false); anchor.current = null; }
  async function openFileMenu(entry: LocalFileEntry, x: number, y: number) {
    if (entry.directory || busy || working) return;
    const version = ++menuSequence.current;
    const files = selected.has(entry.path) ? entries.filter(item => !item.directory && selected.has(item.path)) : [entry];
    useStore.getState().closeContextMenu();
    setPreparingMenu({ x, y, count: files.length, version });
    try {
      // Resolve canonical asset identities only for this explicit operation; never copy the files.
      const assets = [];
      for (const file of files) {
        assets.push(await externalFiles.index(file.path));
        if (!alive.current || version !== menuSequence.current) return;
      }
      const asset = assets[files.indexOf(entry)];
      setPreparingMenu(null);
      useStore.getState().openContextMenu(x, y, asset.id, { asset, fileSelection: {
        assets: [...new Map(assets.map(item => [item.id, item])).values()],
        localPaths: mode === "files" ? Object.fromEntries(assets.map((item, index) => [item.id, files[index].path])) : undefined,
        openReferences: () => setReferencesOpen(true),
        onComplete: finishSelection,
        select: () => { setMultiSelect(true); anchor.current = entry.path; setSelected(previous => new Set([...previous, entry.path])); },
      } });
    } catch (error) { if (alive.current && version === menuSequence.current) { setPreparingMenu(null); notifyError(error, "打开素材菜单失败"); } }
  }

  function editPath() {
    if (editingPath) { addressInput.current?.focus(); addressInput.current?.select(); return; }
    setPanel(null); setPathInput(directory?.path ?? ""); setEditingPath(true);
  }
  function closePanel() {
    (panel === "colors" ? colorsButton : actionsButton).current?.focus({ preventScroll: true });
    setPanel(null);
  }
  function menuAction(action: () => void) { closePanel(); action(); }
  useEffect(() => {
    function focusAddress(event: KeyboardEvent) {
      const workspace = header.current?.closest<HTMLElement>(".local-file-workspace");
      if ((pane && useActiveLibraryPane.getState().pane !== pane) || mode !== "files" || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "l"
        || document.querySelector('[role="dialog"], [role="menu"]')
        || !workspace || workspace.closest('[inert]') || getComputedStyle(workspace).visibility === "hidden") return;
      event.preventDefault(); event.stopPropagation(); editPath();
    }
    window.addEventListener("keydown", focusAddress, true);
    return () => window.removeEventListener("keydown", focusAddress, true);
  }, [directory?.path, editingPath, mode]);
  useEffect(() => {
    if (editingPath) { addressInput.current?.focus(); addressInput.current?.select(); }
  }, [editingPath]);
  useEffect(() => {
    if (!panel || panel === "colors") return;
    header.current?.querySelector<HTMLButtonElement>('[role="dialog"] button:not(:disabled)')?.focus({ preventScroll: true });
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!header.current?.querySelector('[role="dialog"]')?.contains(target)
        && !actionsButton.current?.contains(target) && !colorsButton.current?.contains(target)) setPanel(null);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [panel]);
  async function showAll() {
    const version = ++sequence.current; ++previewSequence.current;
    setLoading(true); setError(""); setPreview(null); setSelected(new Set()); setMultiSelect(false); anchor.current = null;
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
    setLoading(true); setError(""); setPreview(null); setSelected(new Set()); setMultiSelect(false); anchor.current = null;
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
      try { localStorage.setItem(pathKey,result.path); } catch { /* Session browsing remains available. */ }
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
        if (useLocalFileMode.getState().mode === "files") void navigate(lastPath(pathKey) || value.config.root || undefined);
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
  async function changePlace(path: string, added: boolean) {
    if (placePending.current) return;
    placePending.current = true; setSavingPlace(true);
    try {
      const config = await fileWorkspace.place(path, added);
      if (alive.current) setLocations(previous => previous ? { ...previous, config } : null);
    } catch (error) { notifyError(error, "保存常用目录失败"); }
    finally { placePending.current = false; if (alive.current) setSavingPlace(false); }
  }
  async function openDataDirectory() {
    if (placePending.current) return;
    placePending.current = true; setSavingPlace(true);
    try {
      const path = await prepareFileWorkspace();
      if (!alive.current) return;
      const status = await fileWorkspace.status();
      if (!alive.current) return;
      setLocations(status);
      await navigate(path);
    } catch (error) { notifyError(error, "打开资料目录失败"); }
    finally { placePending.current = false; if (alive.current) setSavingPlace(false); }
  }
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
      if (!copy) await addMaterialAssets(assets, destinationProject, onClose, onCreateProject);
      finishSelection();
      notifySuccess(copy ? "已复制到收集箱，原文件保留" : destinationProject ? "已添加到画板，引用原文件" : "所选素材已添加到新项目素材库，原文件保留");
    } catch (e) { notifyError(e,"处理所选文件失败"); }
    finally { busyRef.current = false; if (alive.current) setWorking(false); }
  }
  useLayoutEffect(() => {
    // Move focus off the source tab that is now inside a hidden preserved workspace.
    if (navigation) header.current?.closest('.local-file-workspace')?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
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
  return <section className="local-file-workspace library-tactical" aria-label="本机文件" ref={pinchRef} aria-busy={busy} style={glass.style}
    onKeyDown={e => {
      if (e.target instanceof Element && e.target.closest('input,textarea,[contenteditable="true"],[role="dialog"]')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { e.preventDefault(); e.stopPropagation(); setMultiSelect(true); setSelected(new Set(entries.filter(entry => !entry.directory).map(entry => entry.path))); }
      if (e.altKey && e.key === "ArrowUp" && directory?.parent) { e.preventDefault(); void navigate(directory.parent); }
    }}>
    {glass.definition}
    <LibraryMotion />
    {preparingMenu && <ContextMenu x={preparingMenu.x} y={preparingMenu.y} label="正在准备素材操作" onClose={() => {
      if (menuSequence.current === preparingMenu.version) { menuSequence.current++; setPreparingMenu(null); }
    }}>
      <p className="px-2 py-2 text-muted" role="status">正在准备 {preparingMenu.count} 项素材…</p>
      <button role="menuitem" className="app-context-item px-2 py-1.5" onClick={() => { menuSequence.current++; setPreparingMenu(null); }}>取消</button>
    </ContextMenu>}
    {mode === "files" && (navigationHost ? createPortal(addressNavigation, navigationHost) : addressNavigation)}
    <div className="file-view-heading">
      {navigation}
      <LibraryFloatingControls controlsRef={header}>
      <LibraryBrowserButton/>
      {tag && labelNames.has(tag) && <LibraryTagFilter name={labelNames.get(tag)!} onClear={() => setTag(null)} />}
      <FileColorFilter open={panel === "colors"} onOpenChange={open => setPanel(open ? "colors" : null)} color={color} onColorChange={setColor} palette={palette} triggerRef={colorsButton}/>
      <button ref={actionsButton} className="library-filter-trigger" data-active={!!media || undefined} aria-label="更多文件操作" title="更多" aria-expanded={panel === "actions"} aria-haspopup="dialog" onClick={() => setPanel(panel === "actions" ? null : "actions")}><MoreHorizontal size={16}/></button>
      {!navigation && <button className="folder-return" onClick={onClose}><X size={15}/>{project ? "返回画板" : "返回素材库"}</button>}
      {panel && panel !== "colors" && <div className="folder-popover" role="dialog" aria-label="更多文件操作"
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
          {allLocations && <button className="app-popover-option" disabled={loading} onClick={() => menuAction(() => void showAll())}><RefreshCw size={15}/>刷新素材</button>}
          <div className="folder-menu-label">素材类型</div>
          <button className="app-popover-option" onClick={() => menuAction(() => setMultiSelect(true))}>多选素材</button>
          <div className="file-media-options" role="group" aria-label="素材类型筛选">
            <button aria-pressed={media === null} onClick={() => setMedia(null)}>全部</button>
            <button aria-label="只看图片" aria-pressed={media === "image"} onClick={() => setMedia(media === "image" ? null : "image")}>图片</button>
            <button aria-label="只看视频" aria-pressed={media === "video"} onClick={() => setMedia(media === "video" ? null : "video")}>视频</button>
          </div>
          <div className="folder-menu-divider"/>
          <button className="app-popover-option" disabled={(!allLocations && !classification) || loading} onClick={() => menuAction(() => { setClassificationView("classification"); setClassifyOpen(true); })}>{allLocations ? "自动分类全局素材" : "自动分类此文件夹"}</button>
          <button className="app-popover-option" disabled={(!allLocations && !classification) || loading} onClick={() => menuAction(() => { setClassificationView("labels"); setClassifyOpen(true); })}>管理分类数据</button>
          <div className="folder-menu-divider"/>
          <button className="app-popover-option" disabled={!directory || allLocations || loading} onClick={() => menuAction(() => directory && setRecordsRoot(directory.path))}>随图资料</button>
          <button className="app-popover-option" onClick={() => menuAction(() => setReferencesOpen(true))}>外部引用</button>
          <button className="app-popover-option" onClick={() => menuAction(() => setMoveOpen(true))}>迁移资料目录</button>
          {onLegacy && <button className="app-popover-option" onClick={() => menuAction(onLegacy)}>历史素材</button>}
      </div>}
        {toolbarActions}
      </LibraryFloatingControls>
    </div>
    {error && <p role="alert" className="folder-error">{userErrorMessage(error, "文件操作未完成，请检查保存位置后重试。")}</p>}
    {locations?.migration?.state === "failed" && <p role="alert" className="folder-error">{userErrorMessage(locations.migration.error, "资料目录迁移未完成，请检查目标位置和可用空间。")}</p>}
    {(allLocations || tag) && tagError && <p role="alert" className="folder-error">{userErrorMessage(tagError, "分类素材暂时无法读取，请重新打开后重试。")}</p>}
    <div className="file-browser-body">
    <aside className="file-browser-places" aria-label="文件浏览器目录">
      <button className="file-place-row" disabled={loading || savingPlace || !locations}
        title={locations?.config.root ?? "打开资料目录"}
        aria-current={directory?.path && directory.path === locations?.config.root ? "location" : undefined}
        onClick={() => void openDataDirectory()}><FolderOpen size={15}/><span>资料目录</span></button>
      <div className="file-places-heading"><span>常用目录</span>
        <button aria-label="将当前目录添加到常用目录" title="添加当前目录"
          disabled={!directory?.path || loading || savingPlace || !locations || locations.config.places.includes(directory.path)}
          onClick={() => { if (directory?.path) void changePlace(directory.path, true); }}><Plus size={14}/></button>
      </div>
      <OverlayScrollArea className="file-places-scroll" viewportClassName="file-places-list" label="常用目录滚动条">
        {locations?.config.places.map(path => <div className="file-place-item" key={path}>
          <button className="file-place-row" title={path} disabled={loading || savingPlace}
            aria-current={directory?.path === path ? "location" : undefined} onClick={() => void navigate(path)}>
            <FolderOpen size={14}/><span>{breadcrumbs(path).slice(-1)[0]?.name || path}</span>
          </button>
          <button className="file-place-remove" aria-label={`从常用目录移除 ${path}`} title="从常用目录移除"
            disabled={savingPlace} onClick={() => void changePlace(path, false)}><X size={12}/></button>
        </div>)}
        {locations && !locations.config.places.length && <p className="file-places-empty">浏览文件夹后，点击 + 收藏</p>}
      </OverlayScrollArea>
    </aside>
    <div className="library-browser-grid folder-browser-grid">
    <LibraryTacticalBackdrop />
    <OverlayScrollArea scrollRef={scroll} className="folder-scroll-area" viewportClassName="folder-scroller library-scroller" label="文件夹素材滚动条">
      {color && palette.pending && <p className="folder-empty" role="status">正在筛选颜色…</p>}
      {busy && showLoading && <p className="folder-loading" role="status">{tag ? "正在读取标签图片…" : mode === "global" ? "正在读取全局素材…" : "正在读取文件夹…"}</p>}
      {!busy && !palette.pending && !tagError && !entries.length && <p className="folder-empty">{color || media ? "没有符合筛选条件的素材，可更换或清除筛选。" : tag ? "没有匹配的图片，可切换标签或清除筛选。" : query ? "没有匹配的媒体。" : allLocations ? "暂无全局素材。可通过地址栏选择要浏览的文件夹。" : "此文件夹没有支持的图片、视频或子文件夹。"}</p>}
      <div ref={setGrid} className="folder-masonry" aria-label={tag ? "标签图片" : "目录内容"}>
        {mode === (allLocations ? "global" : "files") && entries.map(entry => <FileMediaCard key={entry.path} entry={entry} selected={selected.has(entry.path)} revision={revision}
          labels={(allLocations ? globalPictures.get(entry.path)?.tags ?? [] : pictures.get(relative(classification?.root ?? "",entry.path) ?? "")?.tags.map(([id]) => id) ?? []).map(id => labelNames.get(id) ?? "").filter(Boolean)}
          onSelect={(additive, range) => {
            const start = entries.findIndex(item => item.path === anchor.current);
            if (range && start >= 0) { const end = entries.indexOf(entry); setSelected(new Set(entries.slice(Math.min(start,end),Math.max(start,end)+1).map(item => item.path))); }
            else { anchor.current = entry.path; setSelected(previous => { const next = new Set(additive || multiSelect ? previous : []); if ((additive || multiSelect) && next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; }); }
          }}
          onContextMenu={(x, y) => void openFileMenu(entry, x, y)}
          onOpen={() => { if (!busy) void openEntry(entry); }} />)}
      </div>
    </OverlayScrollArea>
    {(mediaSelected > 0 || multiSelect) && <div className="folder-selection-bar" role="group" aria-label="所选文件操作">
      <button aria-label="取消文件选择" title="取消选择并退出多选" disabled={working} onClick={finishSelection}><X size={14}/></button>
      <span>已选 {mediaSelected} 项</span>
      <button aria-pressed={multiSelect} onClick={() => setMultiSelect(value => !value)}>多选</button>
      {multiSelect && <button onClick={() => setSelected(new Set(entries.filter(entry => !entry.directory).map(entry => entry.path)))}>全选</button>}
      <button disabled={working || busy || !mediaSelected} onClick={() => void useSelected(true)}><Copy size={14}/><span>复制到收集箱</span></button>
      <button className="folder-selection-primary" disabled={working || busy || !mediaSelected} onClick={() => void useSelected(false)}><Plus size={14}/><span>{project ? "添加到画板" : "把所选素材添加到新项目"}</span></button>
    </div>}
    <ThumbnailSizeSlider scope="library"/>
    </div>
    </div>
    {preview && <Lightbox images={[preview]} index={0} onIndexChange={() => {}} onClose={() => { ++previewSequence.current; setPreview(null); }}/>}
    {classifyOpen && (allLocations || classification) && <LocalClassificationDialog initialView={classificationView} globalScope={allLocations} globalPaths={allLocations ? directory?.entries.map(entry => entry.path) : undefined} folder={!allLocations && classification ? { root: classification.root, recursive: classification.record.recursive } : undefined} selectedFiles={selectedFiles}
      onFilter={setTag} onClose={() => { setClassifyOpen(false); actionsButton.current?.focus({ preventScroll: true }); }}/>}
    {referencesOpen && <ModalShell title="外部引用" width="lg" onClose={() => setReferencesOpen(false)}><LocalFileBrowser initialTab="references" onClose={() => setReferencesOpen(false)} onCreateProject={() => void onCreateProject?.()}/></ModalShell>}
    {recordsRoot && <FileRecordsDialog root={recordsRoot} onClose={() => setRecordsRoot(null)} onRestored={() => setRevision(value => value + 1)} />}
    {moveOpen && <FileWorkspaceMoveDialog onClose={() => setMoveOpen(false)} />}
  </section>;
}
