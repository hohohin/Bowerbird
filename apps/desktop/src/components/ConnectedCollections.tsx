import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type CSSProperties } from "react";
import { listen } from "@tauri-apps/api/event";
import { ChevronDown, ChevronRight, Folder, Link2, MoreHorizontal, Plus, RefreshCw, Unlink } from "lucide-react";
import { api } from "../lib/api";
import { connectedRows, folderConnections, useConnectedNavigation, type ConnectionEntry, type FolderConnection } from "../lib/folderConnections";
import { useLibraryThumbnail, useLibraryPane, type LibraryBrowsePosition } from "../lib/libraryPane";
import { useThumbnailPinch } from "../lib/useThumbnailPinch";
import { setDragAssets, getDragAssets } from "../lib/dragPayload";
import { externalFiles } from "../lib/externalFiles";
import { addMaterialAssets } from "../lib/materialActions";
import { notifyError } from "../lib/notify";
import { userErrorMessage } from "../lib/userError";
import { useStore } from "../store";
import type { Asset } from "../lib/types";
import type { CatalogFilter } from "../lib/materialCatalog";
import { VirtualCatalog, type CatalogLocation } from "./VirtualCatalog";
import { FileMediaCard } from "./FileMediaCard";
import type { CategorizedLibrary } from "./CategorizedLibrary";
import { LibraryFloatingControls } from "./LibraryFloatingControls";
import { LibraryMediaSwitch } from "./LibraryMediaSwitch";
import { LibraryTacticalBackdrop } from "./LibraryTacticalBackdrop";
import { LibraryMotion } from "./LibraryMotion";
import { useLibraryGlass } from "./useLibraryGlass";
import { OverlayScrollArea } from "./CollectionScrollArea";
import { ThumbnailSizeSlider } from "./ThumbnailSizeSlider";
import { ContextMenu } from "./ContextMenu";
import { ModalShell } from "./ModalShell";
import { Lightbox } from "./Lightbox";
import { CollectionEditorDialog, CollectionAssignDialog } from "./CollectionDialogs";
import "./CategorizedLibrary.css";
import "./ConnectedCollections.css";

type EntryAsset = Asset & { connectionEntry: ConnectionEntry };
type Menu = { x: number; y: number; folder: FolderConnection } | { x: number; y: number; entries: ConnectionEntry[] };
type Operation = { kind: "disconnect" | "trash-folder" | "move-folder"; folder: FolderConnection }
  | { kind: "rename-entry" | "move-entries" | "trash-entries"; entries: ConnectionEntry[] };
const entryOf = (asset: Asset) => (asset as EntryAsset).connectionEntry;
const entryKey = (asset: Asset) => entryOf(asset).id;
const assetsOf = (entries: ConnectionEntry[]) => [...new Map(entries.map(entry => [entry.asset_id, entry.asset])).values()];
const browsePositions = new Map<string, LibraryBrowsePosition>();

export function ConnectedCollections({ media = "images", projectId = null, projectScope = false, positionId = "default", navigation, onClose, onCreateProject, onAssetsChange, toolbarActions }: ComponentProps<typeof CategorizedLibrary>) {
  const pane = useLibraryPane(), positions = pane?.positions ?? browsePositions;
  const positionKey = JSON.stringify([pane ? "pane" : positionId, projectId, projectScope, media, "connections"]);
  const [savedPosition] = useState(() => positions.get(positionKey));
  const [folders, setFolders] = useState<FolderConnection[]>([]);
  const [active, setActive] = useState<string | null>(savedPosition?.active ?? null);
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(new Set<string>());
  const [multiple, setMultiple] = useState(false);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [editor, setEditor] = useState<{ item?: FolderConnection; parentId: string | null } | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [assign, setAssign] = useState<string[] | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [jump, setJump] = useState<{ id: string; sequence: number } | null>(null);
  const [drop, setDrop] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(208);
  const scroll = useRef<HTMLDivElement>(null), root = useRef<HTMLElement>(null);
  const dragging = useRef<{ x: number; width: number } | null>(null);
  const lock = useRef(false), alive = useRef(true), selectionVersion = useRef(0);
  const anchor = useRef<CatalogLocation | null>(null);
  const dragSelection = useRef<ConnectionEntry[]>([]);
  const pendingJump = useRef<string | null>(null);
  const request = useConnectedNavigation();
  const lastRequest = useRef(0);
  const { width } = useLibraryThumbnail("library"), pinch = useThumbnailPinch("library"), glass = useLibraryGlass();
  const scope = projectScope ? projectId : null;
  const rows = useMemo(() => connectedRows(folders), [folders]);
  const foldersById = useMemo(() => new Map(folders.map(folder => [folder.id, folder])), [folders]);
  const sections = useMemo(() => rows.map(({ item }) => ({ id: item.id, name: item.name, count: item.count, tagId: null })), [rows]);
  const current = folders.find(folder => folder.id === active);
  const filter = useMemo<CatalogFilter>(() => ({ kind: "collections", id: null, projectId: scope, media, query: "", generated: null, color: null }), [scope, media]);
  const filterKey = JSON.stringify(filter);
  const filterRef = useRef(filterKey); filterRef.current = filterKey;
  const readPage = useCallback(async (id: string, offset: number, limit: number) => (await folderConnections.page(id, offset, limit, media, scope)).map(entry => ({ ...entry.asset, connectionEntry: entry })), [media, scope]);
  const refresh = useCallback(() => { void folderConnections.refresh().catch(reason => notifyError(reason, "无法检查文件夹")); }, []);
  const activeRef = useRef(active); activeRef.current = active;
  useLayoutEffect(() => {
    const view = scroll.current;
    const save = () => positions.set(positionKey, { active: activeRef.current, top: view?.scrollTop ?? 0, alphabetic: false, color: null, query: "", generatedFilter: null });
    view?.addEventListener("scroll", save, { passive: true });
    return () => { save(); view?.removeEventListener("scroll", save); };
  }, [positionKey, positions]);
  useEffect(() => {
    alive.current = true; let timer: number | undefined;
    const unlisten = listen("library://assets-changed", () => { window.clearTimeout(timer); timer = window.setTimeout(() => setRevision(value => value + 1), 100); });
    const focused = () => refresh(); window.addEventListener("focus", focused); refresh();
    return () => { alive.current = false; window.clearTimeout(timer); void unlisten.then(stop => stop()); window.removeEventListener("focus", focused); };
  }, [refresh]);
  useEffect(() => {
    let current = true;
    folderConnections.list(scope, media).then(value => {
      if (!current) return;
      setFolders(value); setError(""); setActive(id => value.some(folder => folder.id === id) ? id : connectedRows(value)[0]?.item.id ?? null);
    }).catch(reason => { if (current) setError(userErrorMessage(reason, "集合暂时无法读取，请重试。")); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [scope, media, revision]);
  function finishSelection() { selectionVersion.current++; setSelected(new Set()); setMultiple(false); dragSelection.current = []; anchor.current = null; }
  useEffect(() => { finishSelection(); setMenu(null); setPreview(null); }, [filterKey]);
  useEffect(() => {
    let current = true; dragSelection.current = [];
    if (selected.size) void folderConnections.resolve([...selected]).then(entries => { if (current && entries.length === selected.size) dragSelection.current = entries; }).catch(() => {});
    return () => { current = false; };
  }, [selected, revision]);
  const reveal = useCallback((id: string) => {
    const ancestors = new Set<string>(); let parent = foldersById.get(id)?.parent_id;
    while (parent && !ancestors.has(parent)) { ancestors.add(parent); parent = foldersById.get(parent)?.parent_id; }
    setCollapsed(previous => { if (![...ancestors].some(id => previous.has(id))) return previous; return new Set([...previous].filter(id => !ancestors.has(id))); });
  }, [foldersById]);
  const navigate = useCallback((id: string) => { reveal(id); setActive(id); setJump(previous => ({ id, sequence: (previous?.sequence ?? 0) + 1 })); }, [reveal]);
  const onActive = useCallback((id: string | null) => { if (editor || operation || assign || preview || menu) return; setActive(id); if (id) reveal(id); }, [editor, operation, assign, preview, menu, reveal]);
  useEffect(() => {
    if (request.paneId && request.paneId !== pane?.id) return;
    if (request.id && request.sequence !== lastRequest.current) {
      lastRequest.current = request.sequence; pendingJump.current = request.id; setRevision(value => value + 1);
      if (useConnectedNavigation.getState().sequence === request.sequence) useConnectedNavigation.setState({ id: null });
    }
  }, [request, pane?.id]);
  useEffect(() => {
    const id = pendingJump.current;
    if (id && folders.some(folder => folder.id === id)) { pendingJump.current = null; navigate(id); }
  }, [folders, navigate]);
  async function run(action: () => Promise<void>, changed = false) {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try { await action(); if (changed && alive.current) { finishSelection(); setRevision(value => value + 1); } }
    catch (reason) { notifyError(reason, "操作未完成，请重试"); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  async function resolve(ids: string[]) {
    const entries = await folderConnections.resolve(ids);
    if (entries.length !== ids.length) throw new Error("部分所选文件已不存在，请重新选择");
    return entries;
  }
  function select(asset: Asset, additive: boolean, range: boolean, location: CatalogLocation) {
    if (busy) return;
    const id = entryKey(asset);
    if (range && anchor.current) {
      const from = anchor.current, version = selectionVersion.current;
      void run(async () => {
        const a = sections.findIndex(section => section.id === from.section), b = sections.findIndex(section => section.id === location.section);
        if (a < 0 || b < 0) return;
        const forward = a < b || (a === b && from.index <= location.index), first = forward ? from : location, last = forward ? location : from;
        const ids: string[] = [];
        for (let index = Math.min(a, b); index <= Math.max(a, b); index++) {
          if (!alive.current || version !== selectionVersion.current) return;
          const section = sections[index], start = section.id === first.section ? first.index : 0;
          const end = section.id === last.section ? last.index + 1 : section.count;
          ids.push(...await folderConnections.ids(section.id, media, scope, start, end - start));
        }
        if (alive.current && version === selectionVersion.current) { setSelected(previous => new Set([...previous, ...ids])); setMultiple(true); }
      }); return;
    }
    anchor.current = location;
    setSelected(previous => { const next = additive || multiple ? new Set(previous) : new Set<string>(); next.has(id) ? next.delete(id) : next.add(id); return next; });
    if (additive) setMultiple(true);
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key.toLowerCase() !== "a" || !(event.ctrlKey || event.metaKey) || !root.current?.contains(target) || target.closest('input,textarea,[contenteditable="true"]') || document.querySelector('[role="dialog"], [role="menu"]')) return;
      event.preventDefault(); const version = selectionVersion.current;
      void run(async () => { const ids = await folderConnections.ids(null, media, scope); if (version === selectionVersion.current) { setSelected(new Set(ids)); setMultiple(true); } });
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [media, scope, busy]);
  function activate(asset: Asset) {
    if (busy || !entryOf(asset).available) return;
    const state = useStore.getState();
    if (projectId && state.activeProjectId !== projectId) return;
    if (projectId && (state.boardOpen || state.genEditing)) window.dispatchEvent(new CustomEvent("bowerbird://board-asset-picked", { detail: asset.id }));
    else void run(async () => { if (!asset.store_path) throw new Error("原文件暂不可用"); const path = await externalFiles.media(asset.store_path); if (alive.current) setPreview(path); });
  }
  function context(asset: Asset, x: number, y: number) {
    const entry = entryOf(asset), key = filterRef.current;
    void run(async () => {
      const entries = selected.has(entry.id) ? await resolve([...selected]) : [entry];
      if (alive.current && filterRef.current === key) setMenu({ x, y, entries });
    });
  }
  function hidden(folder: FolderConnection) {
    const visited = new Set<string>(); let parent = folder.parent_id;
    while (parent && !visited.has(parent)) { visited.add(parent); if (collapsed.has(parent)) return true; parent = foldersById.get(parent)?.parent_id ?? null; }
    return false;
  }
  function toggle(id: string) { setCollapsed(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next; }); }
  const visibleRows = rows.filter(row => !hidden(row.item));
  function treeKey(event: React.KeyboardEvent, folder: FolderConnection) {
    if (event.target !== event.currentTarget) return;
    const index = visibleRows.findIndex(row => row.item.id === folder.id), children = folders.filter(item => item.parent_id === folder.id);
    let next: string | undefined;
    if (event.key === "ArrowDown") next = visibleRows[Math.min(index + 1, visibleRows.length - 1)]?.item.id;
    else if (event.key === "ArrowUp") next = visibleRows[Math.max(index - 1, 0)]?.item.id;
    else if (event.key === "Home") next = visibleRows[0]?.item.id;
    else if (event.key === "End") next = visibleRows[visibleRows.length - 1]?.item.id;
    else if (event.key === "ArrowRight") { if (children.length && collapsed.has(folder.id)) toggle(folder.id); else next = children[0]?.id; }
    else if (event.key === "ArrowLeft") { if (children.length && !collapsed.has(folder.id)) toggle(folder.id); else next = folder.parent_id ?? undefined; }
    else if (event.key === "Enter" || event.key === " ") navigate(folder.id);
    else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ folder, x: rect.right, y: rect.top }); }
    else return;
    event.preventDefault(); event.stopPropagation();
    if (next) [...root.current!.querySelectorAll<HTMLElement>('[data-collection-id]')].find(element => element.dataset.collectionId === next)?.focus();
  }
  async function relocate(folder: FolderConnection) { const path = await api.pickFolder(folder.path); if (path) await folderConnections.relocate(folder.root_id, path); }
  const menuButton = (label: string, action: () => void, disabled = false) => <button type="button" role="menuitem" disabled={disabled || busy} onClick={() => { setMenu(null); action(); }}>{label}</button>;
  return <section ref={root} className="categorized-library library-tactical connected-collections" aria-label="按集合浏览素材" data-file-import-project-id={scope ?? ""} data-file-import-collection-id={active ?? undefined} data-file-import-collection-name={current?.name}
    style={{ ...glass.style, "--catalog-sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
    {glass.definition}<LibraryMotion/>
    <div className="catalog-body">
      <aside className="catalog-sidebar" aria-label="集合目录">
        <div className="catalog-sidebar-heading"><strong>集合</strong><button aria-label="新建集合" title="新建集合" onClick={() => setEditor({ parentId: null })}><Plus size={16}/></button></div>
        <OverlayScrollArea className="catalog-tree-scroll" viewportClassName="catalog-index" label="集合目录滚动条">
          <div role="tree" aria-label="集合层级">{visibleRows.map(({ item, depth }) => {
            const children = folders.some(folder => folder.parent_id === item.id);
            return <div key={item.id} role="treeitem" aria-label={item.name} aria-level={depth + 1} aria-selected={active === item.id} aria-expanded={children ? !collapsed.has(item.id) : undefined}
              data-collection-id={item.id} data-file-import-collection-id={item.id} data-file-import-collection-name={item.name} tabIndex={active === item.id || !active ? 0 : -1} title={item.path} className={`catalog-row catalog-tree-row${!item.available ? " is-offline" : ""}${drop === item.id ? " is-drop-target" : ""}`}
              style={{ paddingLeft: 4 + Math.min(depth, 8) * 17 }} onClick={() => navigate(item.id)} onKeyDown={event => treeKey(event, item)} onContextMenu={event => { event.preventDefault(); setMenu({ folder: item, x: event.clientX, y: event.clientY }); }}
              onDragOver={event => { if (getDragAssets()?.length && item.available) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "link"; setDrop(item.id); } }} onDragLeave={() => setDrop(null)}
              onDrop={event => { const ids = getDragAssets(); setDrop(null); if (!ids?.length) return; event.preventDefault(); event.stopPropagation(); void run(() => folderConnections.references([...new Set(ids)], item.id), true); }}>
              {children && <button className="catalog-tree-toggle" tabIndex={-1} aria-label={`${collapsed.has(item.id) ? "展开" : "收起"}${item.name}`} onClick={event => { event.stopPropagation(); toggle(item.id); }}>{collapsed.has(item.id) ? <ChevronRight size={12}/> : <ChevronDown size={12}/>}</button>}
              <Folder className="catalog-tree-icon" size={14}/><span className="catalog-tree-name">{item.name}</span>{!item.available && <Unlink size={12} aria-label="连接不可用"/>}
              <div className="catalog-tree-row-actions" onKeyDown={event => event.stopPropagation()}><button className="catalog-tree-add" aria-label={`在「${item.name}」中新建集合`} title="新建集合" disabled={!item.available} onClick={event => { event.stopPropagation(); setEditor({ parentId: item.id }); }}><Plus size={14}/></button>
                <button aria-label={`「${item.name}」的更多操作`} title="更多操作" onClick={event => { event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); setMenu({ folder: item, x: rect.right, y: rect.bottom }); }}><MoreHorizontal size={14}/></button></div>
            </div>;
          })}</div>
          {loading && <p className="catalog-hint" role="status">正在读取集合…</p>}
        </OverlayScrollArea>
        <div className="catalog-sidebar-resize" role="separator" aria-label="调整集合侧栏宽度" aria-orientation="vertical" tabIndex={0} aria-valuenow={sidebarWidth} aria-valuemin={120} aria-valuemax={320}
          onPointerDown={event => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); dragging.current = { x: event.clientX, width: sidebarWidth }; }}
          onPointerMove={event => { if (dragging.current) setSidebarWidth(Math.max(120, Math.min(320, dragging.current.width + event.clientX - dragging.current.x))); }} onPointerUp={() => { dragging.current = null; }} onPointerCancel={() => { dragging.current = null; }}
          onKeyDown={event => { if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); setSidebarWidth(value => Math.max(120, Math.min(320, value + (event.key === "ArrowRight" ? 16 : -16)))); } }}/>
      </aside>
      <div ref={pinch} className="catalog-gallery">
        <LibraryTacticalBackdrop/>
        <div className="file-view-heading">{navigation}<LibraryFloatingControls><LibraryMediaSwitch/><button className="library-filter-trigger" aria-label="刷新集合" onClick={refresh}><RefreshCw size={14} className={folders.some(folder => folder.scanning) ? "connected-refreshing" : undefined}/></button>{toolbarActions}</LibraryFloatingControls></div>
        {error && <p className="catalog-error" role="alert">{error}<button onClick={() => setRevision(value => value + 1)}>重试</button></p>}
        {current && (!current.available || current.error) && <div className="connected-status"><Unlink size={14}/><span>{current.error ? userErrorMessage(current.error, "文件夹暂时无法读取，请重试。") : "文件夹暂不可用"}</span>{!current.available ? <button onClick={() => void run(() => relocate(current), true)}>重新定位</button> : <button onClick={refresh}>刷新</button>}</div>}
        <OverlayScrollArea scrollRef={scroll} className="catalog-scroll" viewportClassName="catalog-scroller library-scroller" viewportStyle={{ paddingBottom: 0, overflowAnchor: "none", scrollPaddingTop: 48 }}>
          {!loading && !folders.length && !error && <p className="catalog-hint catalog-empty">点击「建立连接」选择素材文件夹。</p>}
          {!loading && <VirtualCatalog key={`${pane?.id ?? "main"}:${filterKey}`} filter={filter} sections={sections} headings width={width} revision={revision} scroll={scroll} selected={selected} jump={jump} initialTop={savedPosition?.top} onActive={onActive}
            readPage={readPage} itemKey={entryKey} emptySection={id => folders.find(folder => folder.id === id)?.scanning ? "正在检查文件夹…" : "暂无素材"}
            onAssetsChange={onAssetsChange} onSelect={select} onActivate={activate} onOpen={asset => useStore.getState().openDetail(asset.id)} onContextMenu={context}
            renderItem={(asset, style, ratio, location) => { const entry = entryOf(asset); return <div key={entry.id} data-connection-entry={entry.id} data-reference={entry.is_reference || undefined} className="connected-media" style={style}>
              <FileMediaCard entry={{ path: asset.store_path ?? "", name: entry.name, directory: false, preview: asset.thumb_path, version: `${asset.id}:${asset.file_mtime}:${asset.thumb_path}` }} style={{ width: "100%", height: "100%" }} aspectRatio={ratio} selected={selected.has(entry.id)} revision={revision} labels={[]} assetId={asset.id} generated={!!asset.generation_session_id}
                onSelect={(additive, range) => select(asset, additive, range, location)} onActivate={!multiple ? () => activate(asset) : undefined} onOpen={() => useStore.getState().openDetail(asset.id)} onContextMenu={(x, y) => context(asset, x, y)}
                onDragStart={event => { const entries = selected.has(entry.id) ? dragSelection.current : [entry]; if (!entry.available || !entries.length || (selected.has(entry.id) && entries.length !== selected.size)) { event.preventDefault(); return; } const ids = assetsOf(entries).map(asset => asset.id); setDragAssets(ids, asset.name, event.currentTarget.querySelector("img")?.src); event.dataTransfer.effectAllowed = "copyLink"; event.dataTransfer.setData("text/plain", ids.join(",")); }} onDragEnd={() => setDragAssets(null)}/>
              {entry.is_reference && <span className="connected-reference" aria-label="素材分身"><Link2 size={13}/></span>}{!entry.available && <span className="connected-missing"><Unlink size={18}/>原文件失联</span>}
            </div>; }}/>}
        </OverlayScrollArea>
        <ThumbnailSizeSlider scope="library"/>
        {!!selected.size && <div className="connected-selection"><span>已选 {selected.size} 项</span>
          <button disabled={busy} onClick={() => void run(async () => { setAssign(assetsOf(await resolve([...selected])).map(asset => asset.id)); })}>添加到集合</button>
          <button disabled={busy} onClick={() => void run(async () => { await addMaterialAssets(assetsOf(await resolve([...selected])), projectId, onClose, onCreateProject); })}>添加到画板</button>
          <button disabled={busy} onClick={() => void run(async () => { setOperation({ kind: "trash-entries", entries: await resolve([...selected]) }); })}>移到回收站</button><button onClick={finishSelection}>取消</button>
        </div>}
      </div>
    </div>
    {menu && <ContextMenu x={menu.x} y={menu.y} label={"folder" in menu ? "集合操作" : "素材操作"} onClose={() => setMenu(null)}>
      {"folder" in menu ? <>{menuButton("重命名集合", () => setEditor({ item: menu.folder, parentId: menu.folder.parent_id }), !menu.folder.available)}{menuButton("移动文件夹", () => setOperation({ kind: "move-folder", folder: menu.folder }), !menu.folder.available)}{menuButton("移到回收站", () => setOperation({ kind: "trash-folder", folder: menu.folder }), !menu.folder.available)}{!menu.folder.available && menuButton("重新定位", () => void run(() => relocate(menu.folder), true))}{!menu.folder.parent_id && menuButton("断开连接", () => setOperation({ kind: "disconnect", folder: menu.folder }))}</>
        : <>{menu.entries.length === 1 && menuButton("查看详情", () => useStore.getState().openDetail(menu.entries[0].asset_id))}{menuButton("选择", () => { setSelected(new Set(menu.entries.map(entry => entry.id))); setMultiple(true); })}{menuButton("添加到集合", () => setAssign(assetsOf(menu.entries).map(asset => asset.id)))}{menuButton("添加到画板", () => void run(() => addMaterialAssets(assetsOf(menu.entries), projectId, onClose, onCreateProject)), menu.entries.some(entry => !entry.available))}{menuButton("移动到文件夹", () => setOperation({ kind: "move-entries", entries: menu.entries }))}{menu.entries.length === 1 && menuButton(menu.entries[0].is_reference ? "重命名分身" : "重命名原文件", () => setOperation({ kind: "rename-entry", entries: menu.entries }))}{menuButton(menu.entries.every(entry => entry.is_reference) ? "删除分身" : "移到回收站", () => setOperation({ kind: "trash-entries", entries: menu.entries }))}</>}
    </ContextMenu>}
    {editor && <CollectionEditorDialog collections={folders} {...editor} projectId={scope} onClose={() => setEditor(null)} onSaved={id => { pendingJump.current = id; setRevision(value => value + 1); }}/ >}
    {assign && <CollectionAssignDialog assetIds={assign} onClose={() => setAssign(null)} onSaved={() => { finishSelection(); setRevision(value => value + 1); }}/ >}
    {operation && <ConnectionOperation key={operation.kind} operation={operation} folders={folders} onClose={() => setOperation(null)} onSaved={() => { finishSelection(); setRevision(value => value + 1); }}/ >}
    {preview && <Lightbox images={[preview]} index={0} onIndexChange={() => {}} onClose={() => setPreview(null)}/ >}
  </section>;
}

function ConnectionOperation({ operation, folders, onClose, onSaved }: { operation: Operation; folders: FolderConnection[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(operation.kind === "rename-entry" ? operation.entries[0].name : "");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const lock = useRef(false);
  const moving = operation.kind === "move-folder" || operation.kind === "move-entries";
  function allowed(folder: FolderConnection) {
    if (!folder.available) return false;
    if (operation.kind !== "move-folder") return true;
    let current: FolderConnection | undefined = folder;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) { if (current.id === operation.folder.id) return false; seen.add(current.id); current = folders.find(item => item.id === current!.parent_id); }
    return true;
  }
  const references = "entries" in operation && operation.entries.every(entry => entry.is_reference);
  const title = operation.kind === "rename-entry" ? references ? "重命名分身" : "重命名原文件" : operation.kind === "disconnect" ? "断开连接" : moving ? "移动到文件夹" : references ? "删除分身" : "移到回收站";
  async function save() {
    if (lock.current) return; lock.current = true; setBusy(true); setError("");
    try {
      switch (operation.kind) {
        case "rename-entry": await folderConnections.renameEntry(operation.entries[0].id, name); break;
        case "move-folder": await folderConnections.moveFolder(operation.folder.id, target); break;
        case "move-entries": await folderConnections.moveEntries(operation.entries.map(entry => entry.id), target); break;
        case "trash-entries": await folderConnections.trashEntries(operation.entries.map(entry => entry.id)); break;
        case "trash-folder": await folderConnections.trashFolder(operation.folder.id); break;
        case "disconnect": await folderConnections.disconnect(operation.folder.id); break;
      }
      onSaved(); onClose();
    } catch (reason) { setError(userErrorMessage(reason, "操作未完成，请重试。")); }
    finally { lock.current = false; setBusy(false); }
  }
  return <ModalShell title={title} onClose={onClose} preventClose={busy}><form className="catalog-form" onSubmit={event => { event.preventDefault(); void save(); }}>
    {operation.kind === "rename-entry" ? <label>名称<input data-modal-autofocus value={name} onChange={event => setName(event.target.value)} disabled={busy}/></label> : moving ? <fieldset className="connected-destinations" disabled={busy}><legend>目标集合</legend>{connectedRows(folders).filter(row => allowed(row.item)).map(({ item, depth }) => <label key={item.id} style={{ paddingLeft: depth * 16 }}><input type="radio" name="connection-destination" checked={target === item.id} onChange={() => setTarget(item.id)}/><Folder size={14}/>{item.name}</label>)}</fieldset>
      : <><p>{"folder" in operation ? operation.folder.name : `${operation.entries.length} 项`}</p><p>{operation.kind === "disconnect" ? "原文件和创作资料保留。" : references ? "只删除分身，原文件和创作资料保留。" : "将文件移到回收站；原文件的其他分身将显示失联，创作资料保留。"}</p></>}
    {moving && <p>移动文件，保留素材身份和创作资料。</p>}{error && <p role="alert">{error}</p>}
    <div className="connected-dialog-actions"><button type="button" disabled={busy} onClick={onClose}>取消</button><button className="app-button-accent" type="submit" disabled={busy || (moving && !target) || (operation.kind === "rename-entry" && !name.trim())}>{busy ? "处理中…" : title}</button></div>
  </form></ModalShell>;
}
