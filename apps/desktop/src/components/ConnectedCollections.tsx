import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { catalogCache, patchConnectionProgress } from "../lib/catalogCache";
import { openCatalogMenu } from "../lib/openCatalogMenu";
import { originalDeletionFor, usePendingOriginalDeletion } from "../lib/pendingOriginalDeletion";
import { invalidateCatalog, observeCatalogChanges, useCatalogRevision, subscribeConnectionProgress, waitingForConnectionScan } from "../lib/useCatalogRevision";
import { ChevronDown, ChevronRight, Folder, MoreHorizontal, Plus, RefreshCw, Unlink } from "lucide-react";
import { api } from "../lib/api";
import { connectedRows, connectedSubtreeRows, folderConnections, useConnectedNavigation, type ConnectionEntry, type FolderConnection } from "../lib/folderConnections";
import { useLibraryThumbnail, useLibraryPane, useLibraryModeStore, libraryHasOverlay, type LibraryBrowsePosition } from "../lib/libraryPane";
import { useThumbnailPinch } from "../lib/useThumbnailPinch";
import { setDragAssets, getDragAssets, isNativeAssetDrag } from "../lib/dragPayload";
import { externalFiles } from "../lib/externalFiles";
import { addMaterialAssets } from "../lib/materialActions";
import { selectCatalogItem } from "../lib/catalogSelection";
import { notifyError, notifySuccess } from "../lib/notify";
import { userErrorMessage } from "../lib/userError";
import { useStore } from "../store";
import type { Asset } from "../lib/types";
import type { CatalogFilter } from "../lib/materialCatalog";
import { VirtualCatalog, type CatalogLocation } from "./VirtualCatalog";
import { FileMediaCard } from "./FileMediaCard";
import type { CategorizedLibrary } from "./CategorizedLibrary";
import { CatalogAssetCard, LibraryReferenceBadge } from "./CatalogAssetCard";
import { CatalogSelectionBar } from "./CatalogSelectionBar";
import { LibraryCatalogControls } from "./LibraryCatalogControls";
import { LocalFileBrowser } from "./LocalFileBrowser";
import { LibraryTacticalBackdrop } from "./LibraryTacticalBackdrop";
import { LibraryMotion } from "./LibraryMotion";
import { useLibraryGlass } from "./useLibraryGlass";
import { OverlayScrollArea } from "./CollectionScrollArea";
import { ThumbnailSizeSlider } from "./ThumbnailSizeSlider";
import { ContextMenu } from "./ContextMenu";
import { ModalShell } from "./ModalShell";
import { LibraryVideoPreview } from "./LibraryVideoPreview";
import { VideoTranscriptBatchButton } from "./VideoTranscriptBatch";
import { VideoAnalysisBatchButton } from "./VideoAnalysisBatch";
import { videoSourceKey } from "../lib/videoSourceKey";
import { isVideoAsset } from "../lib/videoGeneration";
import { isAudioAsset } from "../lib/audioMedia";
import { isTextAsset } from "../lib/textMedia";
import { stopAudioPreview, stopAudioPreviewInFolder } from "../lib/audioPreview";
import { CollectionEditorDialog, CollectionAssignDialog, CollectionMoveDialog, type MoveEntrySelection } from "./CollectionDialogs";
import "./CategorizedLibrary.css";
import "./ConnectedCollections.css";

type EntryAsset = Asset & { connectionEntry: ConnectionEntry; connectionGroup?: EntryAsset[] };
const entryAsset = (entry: ConnectionEntry): EntryAsset => ({ ...entry.asset, connectionEntry: entry, connectionGroup: entry.group?.map(entryAsset) });
type Menu = { x: number; y: number; folder: FolderConnection };
type Operation = { kind: "disconnect" | "trash-folder" | "move-folder"; folder: FolderConnection }
  | { kind: "rename-entry" | "remove-references"; entries: ConnectionEntry[] };
const entryOf = (asset: Asset) => (asset as EntryAsset).connectionEntry;
const entryKey = (asset: Asset) => entryOf(asset).id;
const assetsOf = (entries: ConnectionEntry[]) => [...new Map(entries.map(entry => [entry.asset_id, entry.asset])).values()];
const visibleEntry = (entry: ConnectionEntry) => !originalDeletionFor(entry.asset_id, entry.asset.store_path);
const browsePositions = new Map<string, LibraryBrowsePosition>();

export function ConnectedCollections({ media = "images", projectId = null, positionId = "default", sidebarBody, showGallery, selectedFolderId, foldersExpanded, onFoldersExpandedChange, onClose, onNavigate, onCreateProject, onAssetsChange, toolbarActions, onInsertAsset, onOpenAsset, onAssetContextMenu }: Omit<ComponentProps<typeof CategorizedLibrary>, "kind"> & {
  showGallery: boolean; selectedFolderId: string | null; foldersExpanded: boolean; onFoldersExpandedChange: (expanded: boolean) => void;
}) {
  const mode = useLibraryModeStore();
  const folderListId = useId();
  const FolderChevron = foldersExpanded ? ChevronDown : ChevronRight;
  const query = mode(state => showGallery ? state.query.trim() : ""), searching = !!query;
  const generatedFilter = mode(state => showGallery ? state.generatedFilter : null);
  const catalogMedia = showGallery ? media : "all";
  const pane = useLibraryPane(), positions = pane?.positions ?? browsePositions;
  const positionKey = JSON.stringify([pane ? "pane" : positionId, projectId, media, "connections", selectedFolderId]);
  const [savedPosition] = useState(() => positions.get(positionKey));
  const searchReturn = useRef<number>();
  useLayoutEffect(() => {
    if (searching) searchReturn.current ??= positions.get(positionKey)?.top;
  }, [searching, positions, positionKey]);
  const [folders, setFolders] = useState<FolderConnection[]>([]);
  const [active, setActive] = useState<string | null>(savedPosition?.active ?? null);
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [color, setColor] = useState<string | null>(savedPosition?.color ?? null);
  const revision = useCatalogRevision(media === "images" && !!color);
  const colorsPrepared = invalidateCatalog;
  const [references, setReferences] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [recoveringRoots, setRecoveringRoots] = useState<ReadonlySet<string>>(new Set());
  const loadedFolderScope = useRef<string | null>(null);
  const [selected, setSelected] = useState(new Set<string>());
  const [multiple, setMultiple] = useState(false);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [editor, setEditor] = useState<{ item?: FolderConnection; parentId: string | null } | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [assign, setAssign] = useState<string[] | null>(null);
  const [moveEntries, setMoveEntries] = useState<MoveEntrySelection | null>(null);
  const [preview, setPreview] = useState<{ asset: Asset; path: string; sourceKey: string } | null>(null);
  const [drop, setDrop] = useState<string | null>(null);
  const scroll = useRef<HTMLDivElement>(null), root = useRef<HTMLElement>(null);
  const lock = useRef(false), alive = useRef(true), selectionVersion = useRef(0);
  const anchor = useRef<CatalogLocation | null>(null);
  const ownedMenu = useRef<NonNullable<ReturnType<typeof useStore.getState>["contextMenu"]>["fileSelection"]>();
  const shownEntries = useRef(new Map<string, string>());
  const onBrowseGroup = useCallback((head: string, shown: string | null) => { if (shown) shownEntries.current.set(head, shown); else shownEntries.current.delete(head); }, []);
  const displayedIds = (ids: string[]) => ids.map(id => shownEntries.current.get(id) ?? id);
  const loadedMenuEntries = useRef<{ key: string; entries: Map<string, ConnectionEntry> }>();
  const dragSelection = useRef<ConnectionEntry[]>([]);
  const pendingDeletion = usePendingOriginalDeletion();
  const pendingJump = useRef<string | null>(null);
  const request = useConnectedNavigation();
  const lastRequest = useRef(0);
  const { width } = useLibraryThumbnail("library"), pinch = useThumbnailPinch("library"), glass = useLibraryGlass();
  const scope = null;
  const rows = useMemo(() => connectedRows(folders), [folders]);
  const galleryRows = useMemo(() => selectedFolderId ? connectedSubtreeRows(folders, selectedFolderId) : rows, [selectedFolderId, rows, folders]);
  const foldersById = useMemo(() => new Map(folders.map(folder => [folder.id, folder])), [folders]);
  const canDropInFolder = useCallback((folder: FolderConnection) => folder.available && foldersById.get(folder.root_id)?.available !== false, [foldersById]);
  const searchCount = searching ? galleryRows.reduce((total, { item }) => total + item.count, 0) : 0;
  const sections = useMemo(() => galleryRows.filter(({ item }) => !searching || item.count > 0).map(({ item }) => ({
    id: item.id, name: item.name, count: item.count, tagId: null,
    collection: { id: item.id, rootId: item.root_id, available: canDropInFolder(item) },
  })), [galleryRows, canDropInFolder, searching]);
  const current = folders.find(folder => folder.id === active);
  const connectionRoot = current && foldersById.get(current.root_id);
  const reading = !!current && !error && !current.error && (current.scanning || recoveringRoots.has(current.root_id));
  const filter = useMemo<CatalogFilter & { grouped: boolean }>(() => ({ grouped: true, kind: "connections", id: null, projectId: scope, media: catalogMedia, query, generated: (catalogMedia === "all" || catalogMedia === "images" || catalogMedia === "videos") && generatedFilter ? generatedFilter === "source:generated" : null, color: catalogMedia === "images" ? color : null }), [catalogMedia, query, generatedFilter, color]);
  const filterKey = JSON.stringify([filter, selectedFolderId]);
  const filterRef = useRef(filterKey); filterRef.current = filterKey;
  const assetsChanged = useCallback((assets: Asset[]) => {
    const entries = assets.flatMap(asset => [asset as EntryAsset, ...((asset as EntryAsset).connectionGroup ?? [])]);
    loadedMenuEntries.current = { key: filterKey, entries: new Map(entries.map(asset => [entryKey(asset), entryOf(asset)])) };
    onAssetsChange?.([...new Map(entries.map(asset => [asset.id, asset])).values()]);
  }, [filterKey, onAssetsChange]);
  const readPage = useCallback(async (id: string, offset: number, limit: number) => (await folderConnections.page(id, offset, limit, catalogMedia, scope, filter)).map(entryAsset), [catalogMedia, filter]);
  const activeRef = useRef(active); activeRef.current = active;
  const refresh = useCallback(() => { void folderConnections.refresh(selectedFolderId).catch(reason => notifyError(reason, "无法检查文件夹")); }, [selectedFolderId]);
  useLayoutEffect(() => {
    if (searching) return;
    const view = scroll.current;
    const save = () => positions.set(positionKey, { active: activeRef.current, top: view?.scrollTop ?? 0, alphabetic: false, color, query: "", generatedFilter });
    view?.addEventListener("scroll", save, { passive: true });
    return () => view?.removeEventListener("scroll", save);
  }, [positionKey, positions, color, generatedFilter, searching, showGallery]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => subscribeConnectionProgress(progress => {
    setFolders(folders => patchConnectionProgress(folders, progress));
    if (progress.rootAvailable !== undefined) setRecoveringRoots(previous => {
      const next = new Set(previous);
      if (progress.rootAvailable) next.add(progress.rootId); else next.delete(progress.rootId);
      return next;
    });
  }), []);
  useLayoutEffect(() => {
    let current = true;
    const key = `folders:${JSON.stringify(filter)}`;
    const apply = (value: FolderConnection[]) => {
      loadedFolderScope.current = filterKey;
      setFolders(value); setError(""); setLoading(false);
      const visible = selectedFolderId ? connectedSubtreeRows(value, selectedFolderId) : connectedRows(value);
      setActive(visible.some(({ item }) => item.id === activeRef.current) ? activeRef.current : visible[0]?.item.id ?? null);
      // Native watches own background reconciliation; browsing only reads its index.
    };
    const cached = catalogCache.peek<FolderConnection[]>(key);
    if (cached) apply(cached.value);
    else if (loadedFolderScope.current !== filterKey) setLoading(true);
    void catalogCache.read(key, async () => {
      await observeCatalogChanges();
      return folderConnections.list(scope, catalogMedia, filter);
    }, !!filter.color).then(value => {
      if (current && revision === catalogCache.revision(!!filter.color)) {
        apply(value);
        setRecoveringRoots(previous => {
          if (!previous.size) return previous;
          return new Set([...previous].filter(id => waitingForConnectionScan(id) || value.some(folder => folder.id === id && folder.scanning)));
        });
      }
    }).catch(reason => { if (current) setError(userErrorMessage(reason, "文件夹暂时无法读取，请重试。")); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [filterKey, revision, filter, catalogMedia]);
  function finishSelection() { selectionVersion.current++; setSelected(new Set()); setMultiple(false); dragSelection.current = []; anchor.current = null; }
  useEffect(() => {
    finishSelection(); setMenu(null); setPreview(null);
    return () => { if (ownedMenu.current && useStore.getState().contextMenu?.fileSelection === ownedMenu.current) useStore.getState().closeContextMenu(); };
  }, [filterKey]);
  useEffect(() => {
    let current = true; dragSelection.current = [];
    const version = selectionVersion.current;
    if (selected.size) void folderConnections.resolve([...selected]).then(rows => {
      const entries = rows.filter(visibleEntry);
      if (!current || version !== selectionVersion.current) return;
      dragSelection.current = entries;
      if (entries.length === selected.size) return;
      if (!entries.length) { finishSelection(); return; }
      selectionVersion.current++;
      const retained = new Set(entries.map(entry => entry.id));
      setSelected(retained);
      anchor.current = null;
    }).catch(() => {});
    return () => { current = false; };
  }, [selected, revision, pendingDeletion]);
  const reveal = useCallback((id: string) => {
    const ancestors = new Set<string>(); let parent = foldersById.get(id)?.parent_id;
    while (parent && !ancestors.has(parent)) { ancestors.add(parent); parent = foldersById.get(parent)?.parent_id; }
    setCollapsed(previous => { if (![...ancestors].some(id => previous.has(id))) return previous; return new Set([...previous].filter(id => !ancestors.has(id))); });
  }, [foldersById]);
  const navigate = useCallback((id: string) => {
    reveal(id); setActive(id);
    if (id === selectedFolderId) scroll.current?.scrollTo({ top: 0 });
    mode.getState().selectHierarchy({ kind: "folders", folderId: id });
  }, [reveal, mode, selectedFolderId]);
  useEffect(() => { if (selectedFolderId) reveal(selectedFolderId); }, [selectedFolderId, reveal]);
  const onActive = useCallback((id: string | null) => { if (editor || operation || assign || preview || menu || references) return; setActive(id); }, [editor, operation, assign, preview, menu, references]);
  useEffect(() => {
    if (request.paneId ? request.paneId !== pane?.id : root.current?.closest('[inert], [aria-hidden="true"]')) return;
    if (request.id && request.sequence !== lastRequest.current) {
      lastRequest.current = request.sequence; pendingJump.current = request.id; invalidateCatalog();
      if (useConnectedNavigation.getState().sequence === request.sequence) useConnectedNavigation.setState({ id: null });
    }
  }, [request, pane?.id]);
  useEffect(() => {
    const id = pendingJump.current;
    if (id && folders.some(folder => folder.id === id)) {
      pendingJump.current = null;
      onFoldersExpandedChange(true);
      navigate(id);
    }
  }, [folders, navigate, onFoldersExpandedChange]);
  async function run(action: () => Promise<void>, changed = false) {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try { await action(); if (changed && alive.current) { finishSelection(); invalidateCatalog(); } }
    catch (reason) { notifyError(reason, "操作未完成，请重试"); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  async function resolve(ids: string[]) {
    const entries = (await folderConnections.resolve(ids)).filter(visibleEntry);
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
          if (!alive.current || version !== selectionVersion.current || filterRef.current !== filterKey) return;
          const section = sections[index], start = section.id === first.section ? first.index : 0;
          const end = section.id === last.section ? last.index + 1 : section.count;
          ids.push(...await folderConnections.ids(section.id, media, scope, start, end - start, filter));
        }
        if (alive.current && version === selectionVersion.current && filterRef.current === filterKey) { setSelected(previous => new Set([...previous, ...displayedIds(ids)])); setMultiple(true); }
      }); return;
    }
    anchor.current = location;
    const next = selectCatalogItem(selected, id, { additive, range, multiple });
    setSelected(next.selected); setMultiple(next.multiple);
  }
  function selectAll() {
    const version = selectionVersion.current;
    void run(async () => {
      const ids = await folderConnections.ids(selectedFolderId, media, scope, 0, Infinity, filter, !!selectedFolderId);
      if (alive.current && version === selectionVersion.current && filterRef.current === filterKey) { setSelected(new Set(displayedIds(ids))); setMultiple(true); }
    });
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (!showGallery || !galleryReady || event.key.toLowerCase() !== "a" || !(event.ctrlKey || event.metaKey) || !root.current?.closest(".library-catalog")?.contains(target) || target.closest('input,textarea,select,[role="combobox"],[contenteditable="true"]') || libraryHasOverlay(root.current)) return;
      event.preventDefault(); selectAll();
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [filterKey, busy, loading, showGallery]);
  function canShowOverlay() {
    return alive.current && !!root.current?.isConnected && !root.current.closest('[inert], [aria-hidden="true"]');
  }
  function openDetail(asset: Pick<Asset, "id">) { if (onOpenAsset) onOpenAsset(asset); else useStore.getState().openDetail(asset.id); }
  function openAsset(asset: Asset) {
    if (busy || !entryOf(asset).available) return;
    if (onInsertAsset) onInsertAsset(asset);
    else if (isAudioAsset(asset)) {
      const state = useStore.getState();
      if (state.boardOpen || state.genEditing) window.dispatchEvent(new CustomEvent("bowerbird://board-asset-picked", { detail: asset.id }));
      else openPreview(asset);
    } else if (isVideoAsset(asset)) activate(asset);
    else openDetail(asset);
  }
  function activate(asset: Asset) {
    if (busy || !entryOf(asset).available) return;
    const state = useStore.getState();
    if (!onInsertAsset && projectId && state.activeProjectId !== projectId) return;
    if (isAudioAsset(asset)) { openPreview(asset); return; }
    if (isTextAsset(asset)) { openDetail(asset); return; }
    if (!onInsertAsset && (state.boardOpen || state.genEditing)) window.dispatchEvent(new CustomEvent("bowerbird://board-asset-picked", { detail: asset.id }));
    else openPreview(asset);
  }
  function openPreview(asset: Asset) {
    const route = useStore.getState().projectRouteRevision;
    void run(async () => {
      if (!asset.store_path) throw new Error("原文件暂不可用");
      const version = selectionVersion.current;
      const path = isAudioAsset(asset) ? asset.store_path : await externalFiles.media(asset.store_path);
      if (!canShowOverlay() || filterRef.current !== filterKey || selectionVersion.current !== version) return;
      if (useStore.getState().projectRouteRevision !== route) return;
      setPreview({ asset, path, sourceKey: entryOf(asset).version ?? videoSourceKey(asset)! });
    });
  }
  function context(asset: Asset, x: number, y: number, location: CatalogLocation) {
    const entry = entryOf(asset);
    const entryIds = selected.has(entry.id) ? [...selected] : [entry.id];
    openCatalogMenu({
      ids: entryIds, hit: entry, cached: loadedMenuEntries.current?.key === filterKey ? loadedMenuEntries.current.entries : undefined,
      keyOf: target => target.id, visible: visibleEntry, lookup: folderConnections.resolve,
      inScope: () => canShowOverlay() && filterRef.current === filterKey && revision === catalogCache.revision(!!filter.color),
      present(entries) {
        const open = onAssetContextMenu ?? useStore.getState().openContextMenu;
        const move = () => setMoveEntries({ entryIds, entries });
        if (entries.length !== entryIds.length) {
          open(x, y, asset.id, { asset, moveIncompleteSelection: move });
          return;
        }
        const fileSelection = {
          assets: assetsOf(entries), openReferences: () => setReferences(true),
          onComplete: () => { finishSelection(); invalidateCatalog(); },
          select: () => { anchor.current = location; setSelected(previous => new Set([...previous, ...entries.map(item => item.id)])); setMultiple(true); },
          entries: { count: entries.length, available: entries.every(item => item.available),
            rename: () => setOperation({ kind: "rename-entry", entries }), move,
            removeReferences: entries.every(item => item.is_reference) ? () => setOperation({ kind: "remove-references", entries }) : undefined },
        };
        ownedMenu.current = fileSelection;
        open(x, y, asset.id, { asset, generationGroup: [...shownEntries.current.values()].includes(entry.id) ? { assetId: asset.id } : undefined, libraryProjectId: scope ?? undefined, fileSelection });
      },
      failed: reason => notifyError(reason, "操作未完成，请重试"),
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
    if (next) [...(sidebarBody?.querySelectorAll<HTMLElement>('[data-collection-id]') ?? [])].find(element => element.dataset.collectionId === next)?.focus();
  }
  async function relocate(folder: FolderConnection) { const path = await api.pickFolder(folder.path); if (path) await folderConnections.relocate(folder.root_id, path); }
  const menuButton = (label: string, action: () => void, disabled = false) => <button type="button" role="menuitem" className="app-context-item" disabled={disabled || busy} onClick={() => { setMenu(null); action(); }}>{label}</button>;
  const initialTop = searching ? 0 : searchReturn.current ?? positions.get(positionKey)?.top;
  const galleryReady = !loading && loadedFolderScope.current === filterKey;
  useLayoutEffect(() => {
    if (!searching && galleryReady) searchReturn.current = undefined;
  });
  return <section ref={root} data-catalog-searching={searching || undefined} className="categorized-library library-tactical connected-collections" aria-label="按文件夹浏览素材" data-creation-pick-disabled={multiple || busy} data-file-import-project-id={scope ?? ""}
    style={{ ...glass.style, display: showGallery ? undefined : "none" } as CSSProperties}>
    {showGallery && <>{glass.definition}<LibraryMotion/>
    <div className="file-view-heading">
      {selected.size > 0 || multiple ? <CatalogSelectionBar count={selected.size} busy={busy} projectId={projectId} onFinish={finishSelection} onSelectAll={selectAll}
        onMove={() => setMoveEntries({ entryIds: [...selected] })}
        onAssign={() => void run(async () => { const entries = await resolve([...selected]); if (canShowOverlay()) setAssign(assetsOf(entries).map(asset => asset.id)); })}
        onAdd={media !== "audios" ? () => void run(async () => { const key = filterRef.current; const entries = await resolve([...selected]); if (!canShowOverlay() || filterRef.current !== key) return; await addMaterialAssets(assetsOf(entries), projectId, onNavigate ?? onClose, onCreateProject); finishSelection(); notifySuccess(projectId ? "已添加到画板" : "已添加到新项目素材库"); }) : undefined}/>
      : <div className="video-collection-controls"><LibraryCatalogControls filter={filter} onColorChange={setColor} onColorsPrepared={colorsPrepared} onSearchStart={() => {
      if (galleryReady) searchReturn.current = scroll.current?.scrollTop;
    }} onStartSelection={() => { setMultiple(true); requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>(".catalog-selection button")?.focus()); }}>
      <button className="library-filter-trigger" aria-label="刷新文件夹" title="刷新同步" onClick={refresh}><RefreshCw size={14} className={folders.some(folder => folder.scanning) ? "connected-refreshing" : undefined}/></button>{toolbarActions}
      {media === "videos" && current?.available && <>
        <VideoTranscriptBatchButton scope={{ projectId: scope, folderId: current.id, label: `文件夹内视频 · ${current.name}` }}/>
        <VideoAnalysisBatchButton scope={{ projectId: scope, folderId: current.id, label: `文件夹内视频 · ${current.name}` }}/>
      </>}
    </LibraryCatalogControls></div>}</div>
    <div className="catalog-body">
      <div ref={pinch} className="catalog-gallery">
        <LibraryTacticalBackdrop/>
        {error && <p className="catalog-error" role="alert">{error}<button onClick={() => invalidateCatalog()}>重试</button></p>}
        {!searching && current && (connectionRoot?.available === false || reading || !current.available || current.error) &&
          <div className="connected-status" role="status">
            {connectionRoot?.available !== false && reading ? <><RefreshCw size={14} className="connected-refreshing"/><span>正在读取「{current.name}」…</span></> :
              <><Unlink size={14}/><span>{connectionRoot?.available === false ? `「${connectionRoot.name}」已离线，接回原目录后会自动读取。`
                : current.error ? userErrorMessage(current.error, "文件夹暂时无法读取，请重试。") : "文件夹暂不可用"}</span>
                {!current.available ? <button onClick={() => void run(() => relocate(current), true)}>重新定位</button> : <button onClick={refresh}>刷新</button>}</>}
          </div>}
        <OverlayScrollArea scrollRef={scroll} className="catalog-scroll" viewportClassName="catalog-scroller library-scroller" viewportStyle={{ paddingBottom: 0, overflowAnchor: "none", scrollPaddingTop: 48 }}>
          {searching && !loading && !error && !searchCount && <p className="catalog-hint catalog-empty">没有匹配的素材。</p>}
          {!searching && !loading && !sections.length && !error && <p className="catalog-hint catalog-empty">{selectedFolderId ? "此文件夹当前不可用。" : "点击「建立连接」选择素材文件夹。"}</p>}
          {galleryReady && <VirtualCatalog key={`${pane?.id ?? "main"}:${filterKey}`} filter={filter} sections={sections} headings width={width} revision={revision} scroll={scroll} selected={selected} jump={null} initialTop={initialTop} onActive={onActive}
            readPage={readPage} pageScope="folders" itemKey={entryKey} emptySection={id => {
              const folder = foldersById.get(id);
              return folder && foldersById.get(folder.root_id)?.available === false ? "文件夹已离线" : folder?.scanning ? "正在读取文件夹…" : null;
            }}
            onAssetsChange={assetsChanged} onSelect={select} onActivate={activate} onOpen={openAsset} onContextMenu={context}
            renderItem={(head, style, ratio, location, pageRevision) => <CatalogAssetCard key={entryKey(head)} asset={head} group={(head as EntryAsset).connectionGroup} itemKey={entryKey}
              style={style} ratio={ratio} selected={selected} revision={pageRevision} onBrowseGroup={onBrowseGroup}
              onSelect={(asset, additive, range) => select(asset, additive, range, location)} onOpen={openAsset} onContextMenu={(asset, x, y) => context(asset, x, y, location)}
              renderMedia={(asset, mediaStyle, mediaRatio) => { const entry = entryOf(asset); return <div key={entry.id} data-connection-entry={entry.id} data-reference={entry.is_reference || undefined} className="connected-media" style={mediaStyle}>
              <FileMediaCard entry={{ path: asset.store_path ?? "", name: entry.name, directory: false, preview: asset.thumb_path, version: entry.version ?? `${asset.id}:${asset.file_mtime}:${asset.thumb_path ?? pageRevision}` }} expectedVersion={entry.version ?? undefined} style={{ width: "100%", height: "100%" }} aspectRatio={mediaRatio} selected={selected.has(entry.id)} revision={pageRevision} labels={[]} assetId={asset.id} generated={!!(head as EntryAsset).connectionGroup?.length || !!asset.generation_session_id || asset.source === "comfy-h3"} duration={asset.duration}
                onSelect={(additive, range) => select(asset, additive, range, location)} onActivate={!multiple ? () => activate(asset) : undefined} onOpen={() => openAsset(asset)} onContextMenu={(x, y) => context(asset, x, y, location)}
                dragAssetIds={() => { const entries = selected.has(entry.id) ? dragSelection.current : [entry]; if (!entry.available || !entries.length || (selected.has(entry.id) && entries.length !== selected.size)) return []; return assetsOf(entries).map(asset => asset.id); }} onDragEnd={() => setDragAssets(null)}/>
              {entry.is_reference && <LibraryReferenceBadge/>}{!entry.available && <span className="connected-missing"><Unlink size={18}/>原文件失联</span>}
            </div>; }}/>}/>}
        </OverlayScrollArea>
        <ThumbnailSizeSlider scope="library"/>
      </div>
    </div></>}
    {sidebarBody && createPortal(<div className="library-folder-tree" aria-label="文件夹目录">
        <div className="library-folder-heading">
          <button type="button" className="catalog-row library-sidebar-primary" aria-expanded={foldersExpanded} aria-controls={folderListId}
            onClick={() => onFoldersExpandedChange(!foldersExpanded)}><Folder size={14} aria-hidden="true"/>文件夹
            <FolderChevron size={14} className="library-sidebar-chevron" aria-hidden="true"/>
          </button>
          <button type="button" aria-label="新建文件夹" title="新建文件夹" onClick={() => setEditor({ parentId: null })}><Plus size={12} aria-hidden="true"/></button>
        </div>
        <div id={folderListId} className="library-sidebar-children" hidden={!foldersExpanded}>
          <button type="button" className="catalog-row" aria-current={showGallery && selectedFolderId === null || undefined}
            onClick={() => mode.getState().selectHierarchy({ kind: "folders", folderId: null })}>全部文件夹素材</button>
          <div role="tree" aria-label="文件夹层级">{visibleRows.map(({ item, depth }) => {
            const children = folders.some(folder => folder.parent_id === item.id);
            const available = canDropInFolder(item);
            return <div key={item.id} role="treeitem" aria-label={item.name} aria-level={depth + 1} aria-selected={showGallery && selectedFolderId === item.id} aria-expanded={children ? !collapsed.has(item.id) : undefined}
              data-collection-id={item.id} data-file-import-collection-id={item.id} data-file-import-collection-name={item.name} data-file-import-collection-available={available}
              tabIndex={selectedFolderId === item.id || (!selectedFolderId && visibleRows[0]?.item.id === item.id) ? 0 : -1} title={item.path} className={`catalog-row catalog-tree-row${!available ? " is-offline" : ""}${drop === item.id ? " is-drop-target" : ""}${menu && "folder" in menu && menu.folder.id === item.id ? " is-menu-open" : ""}`}
              style={{ paddingLeft: 4 + Math.min(depth, 8) * 17 }} onClick={() => navigate(item.id)} onKeyDown={event => treeKey(event, item)} onContextMenu={event => { event.preventDefault(); setMenu({ folder: item, x: event.clientX, y: event.clientY }); }}
              onDragOver={event => { if (getDragAssets()?.length && available) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = isNativeAssetDrag() ? "copy" : "link"; setDrop(item.id); } }} onDragLeave={() => setDrop(null)}
              onDrop={event => { const ids = getDragAssets(); setDrop(null); if (!ids?.length) return; event.preventDefault(); event.stopPropagation(); if (available) void run(() => folderConnections.references([...new Set(ids)], item.id), true); }}>
              {children && <button className="catalog-tree-toggle" tabIndex={-1} aria-label={`${collapsed.has(item.id) ? "展开" : "收起"}${item.name}`} onClick={event => { event.stopPropagation(); toggle(item.id); }}>{collapsed.has(item.id) ? <ChevronRight size={12}/> : <ChevronDown size={12}/>}</button>}
              {!item.parent_id && <Folder size={13} data-folder-glyph aria-hidden="true"/>}
              <span className="catalog-tree-name">{item.name}</span>{!available && <Unlink size={12} aria-label="连接不可用"/>}
              <div className="catalog-tree-row-actions" onKeyDown={event => event.stopPropagation()}><button className="catalog-tree-add" aria-label={`在「${item.name}」中新建文件夹`} title="新建文件夹" disabled={!item.available} onClick={event => { event.stopPropagation(); setEditor({ parentId: item.id }); }}><Plus size={12}/></button>
                <button aria-label={`「${item.name}」的更多操作`} title="更多操作" onClick={event => { event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); setMenu({ folder: item, x: rect.right, y: rect.bottom }); }}><MoreHorizontal size={14}/></button></div>
            </div>;
          })}</div>
          {loading && <p className="catalog-hint" role="status">正在读取文件夹…</p>}
        </div>
      </div>, sidebarBody)}
    {menu && <ContextMenu x={menu.x} y={menu.y} label="文件夹操作" onClose={() => setMenu(null)}>
      <>{menuButton("重命名文件夹", () => setEditor({ item: menu.folder, parentId: menu.folder.parent_id }), !menu.folder.available)}{menuButton("移动文件夹", () => setOperation({ kind: "move-folder", folder: menu.folder }), !menu.folder.available)}{menu.folder.available ? menuButton("移到回收站", () => setOperation({ kind: "trash-folder", folder: menu.folder })) : menuButton("删除文件夹", () => setOperation({ kind: "disconnect", folder: menu.folder }))}{!menu.folder.available && menuButton("重新定位", () => void run(() => relocate(menu.folder), true))}{!menu.folder.parent_id && menu.folder.available && menuButton("断开连接", () => setOperation({ kind: "disconnect", folder: menu.folder }))}</>
    </ContextMenu>}
    {references && <ModalShell title="外部引用" width="lg" onClose={() => setReferences(false)}><LocalFileBrowser initialTab="references" onClose={() => setReferences(false)} onCreateProject={() => void onCreateProject?.()}/></ModalShell>}
    {editor && <CollectionEditorDialog collections={folders} {...editor} projectId={scope} onClose={() => setEditor(null)} onSaved={id => { pendingJump.current = id; invalidateCatalog(); }}/ >}
    {assign && <CollectionAssignDialog assetIds={assign} onClose={() => setAssign(null)} onSaved={() => { finishSelection(); invalidateCatalog(); }}/ >}
    {moveEntries && <CollectionMoveDialog selection={moveEntries} onClose={() => setMoveEntries(null)} onSaved={finishSelection}/>}
    {operation && <ConnectionOperation key={operation.kind} operation={operation} folders={folders} onClose={() => setOperation(null)} onSaved={() => { finishSelection(); invalidateCatalog(); }}/ >}
    {preview && <LibraryVideoPreview {...preview} projectId={projectId} onClose={() => setPreview(null)}/>}
  </section>;
}

function ConnectionOperation({ operation, folders, onClose, onSaved }: { operation: Operation; folders: FolderConnection[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(operation.kind === "rename-entry" ? operation.entries[0].name : "");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const lock = useRef(false);
  const moving = operation.kind === "move-folder";
  function allowed(folder: FolderConnection) {
    if (!folder.available) return false;
    if (operation.kind !== "move-folder") return true;
    let current: FolderConnection | undefined = folder;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) { if (current.id === operation.folder.id) return false; seen.add(current.id); current = folders.find(item => item.id === current!.parent_id); }
    return true;
  }
  const references = "entries" in operation && operation.entries.every(entry => entry.is_reference);
  const title = operation.kind === "rename-entry" ? references ? "重命名分身" : "重命名原文件" : operation.kind === "disconnect" ? operation.folder.available ? "断开连接" : "删除文件夹" : moving ? "移动到文件夹" : operation.kind === "remove-references" ? (operation.entries.length > 1 ? "删除所选分身" : "删除此分身") : "移到回收站";
  async function save() {
    if (lock.current) return; lock.current = true; setBusy(true); setError("");
    try {
      if ("folder" in operation) stopAudioPreviewInFolder(operation.folder.path);
      else operation.entries.filter(entry => !entry.is_reference).forEach(entry => stopAudioPreview(entry.asset_id));
      switch (operation.kind) {
        case "rename-entry": await folderConnections.renameEntry(operation.entries[0].id, name); break;
        case "move-folder": await folderConnections.moveFolder(operation.folder.id, target); break;
        case "remove-references": await folderConnections.removeReferences(operation.entries.map(entry => entry.id)); break;
        case "trash-folder": await folderConnections.trashFolder(operation.folder.id); break;
        case "disconnect": await folderConnections.disconnect(operation.folder.id); break;
      }
      onSaved(); onClose();
    } catch (reason) { setError(userErrorMessage(reason, "操作未完成，请重试。")); }
    finally { lock.current = false; setBusy(false); }
  }
  return <ModalShell title={title} onClose={onClose} preventClose={busy}><form className="catalog-form" onSubmit={event => { event.preventDefault(); void save(); }}>
    {operation.kind === "rename-entry" ? <label>名称<input data-modal-autofocus value={name} onChange={event => setName(event.target.value)} disabled={busy}/></label> : moving ? <fieldset className="connected-destinations" disabled={busy}><legend>目标文件夹</legend>{connectedRows(folders).filter(row => allowed(row.item)).map(({ item, depth }) => <label key={item.id} style={{ paddingLeft: depth * 16 }}><input type="radio" name="connection-destination" checked={target === item.id} onChange={() => setTarget(item.id)}/><Folder size={14}/>{item.name}</label>)}</fieldset>
      : <><p>{"folder" in operation ? operation.folder.name : `${operation.entries.length} 项`}</p><p>{operation.kind === "disconnect" ? !operation.folder.available ? `移除该文件夹及其下级文件夹，原文件和创作资料保留。${operation.folder.parent_id ? "目录恢复可访问后，刷新会重新显示。" : ""}` : "原文件和创作资料保留。" : operation.kind === "remove-references" ? "只删除选中的分身文件。原文件、其他分身和创作资料均保留。" : "将文件移到回收站；原文件的其他分身将显示失联，创作资料保留。"}</p></>}
    {moving && <p>移动文件，保留素材身份和创作资料。</p>}{error && <p role="alert">{error}</p>}
    <div className="connected-dialog-actions"><button type="button" disabled={busy} onClick={onClose}>取消</button><button className="app-button-accent" type="submit" disabled={busy || (moving && !target) || (operation.kind === "rename-entry" && !name.trim())}>{busy ? "处理中…" : title}</button></div>
  </form></ModalShell>;
}
