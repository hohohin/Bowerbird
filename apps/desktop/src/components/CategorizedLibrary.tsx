import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { ChevronDown, ChevronRight, Folder, MoreHorizontal, Pencil, Plus, Settings2, Trash2, X } from "lucide-react";
import { materialCatalog, type CatalogKind, type MaterialCatalog } from "../lib/materialCatalog";
import { catalogInitial, collectionRows, groupCatalogAssets, orderCatalogTags, isCatalogVideo } from "../lib/materialCatalogOrder";
import { useLocalFileMode, type LibraryMedia } from "../lib/localFileMode";
import { useCatalogPins } from "../lib/catalogPins";
import { setDragAssets } from "../lib/dragPayload";
import { useMasonryLayout } from "../lib/useMasonryLayout";
import { useThumbnailPinch } from "../lib/useThumbnailPinch";
import { useFileColors } from "../lib/useFileColors";
import { addMaterialAssets } from "../lib/materialActions";
import { externalFiles } from "../lib/externalFiles";
import { notifyError, notifySuccess } from "../lib/notify";
import { useStore } from "../store";
import type { Asset, Folder as Collection } from "../lib/types";
import { FileMediaCard } from "./FileMediaCard";
import { FileColorFilter } from "./FileColorFilter";
import { LibraryFloatingControls } from "./LibraryFloatingControls";
import { LibraryBrowserButton } from "./LibraryBrowserButton";
import { LibraryMediaSwitch } from "./LibraryMediaSwitch";
import { GeneratedImageFilter } from "./GeneratedImageFilter";
import { useLibraryGlass } from "./useLibraryGlass";
import { OverlayScrollArea } from "./CollectionScrollArea";
import { ThumbnailSizeSlider } from "./ThumbnailSizeSlider";
import { Lightbox } from "./Lightbox";
import { LocalClassificationDialog } from "./LocalClassificationDialog";
import { LocalFileBrowser } from "./LocalFileBrowser";
import { CollectionAssignDialog, CollectionEditorDialog } from "./CollectionDialogs";
import { ModalShell } from "./ModalShell";
import { CatalogTagIndex } from "./CatalogTagIndex";
import { ContextMenu, DeleteSubmenu } from "./ContextMenu";
import "./CategorizedLibrary.css";

type BrowsePosition = { active: string | null; top: number; alphabetic: boolean; color: string | null; query: string; generatedFilter: string | null };
const browsePositions = new Map<string, BrowsePosition>();

export function CategorizedLibrary({ kind, media = "images", projectId = null, projectScope = false, navigation, onClose, onCreateProject, onAssetsChange }: {
  kind: CatalogKind; projectId?: string | null; projectScope?: boolean; navigation: ReactNode; onClose: () => void; onCreateProject?: (ids?: string[]) => Promise<unknown>;
  media?: LibraryMedia;
  onAssetsChange?: (assets: Asset[]) => void;
}) {
  const glass = useLibraryGlass();
  const positionKey = JSON.stringify([projectId, projectScope, media, kind]);
  const [savedPosition] = useState(() => browsePositions.get(positionKey));
  const restorePosition = useRef(savedPosition);
  const flat = media === "videos" && kind === "tags";
  const [catalog, setCatalog] = useState<MaterialCatalog>({ tags: [], collections: [], prompts: [], tag_asset_ids: {} });
  const [active, setActive] = useState<string | null>(savedPosition?.active ?? null);
  const [pinnedSection, setPinnedSection] = useState<string | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [revision, setRevision] = useState(0);
  const [catalogError, setCatalogError] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const loadedCatalogScope = useRef<string | null>(null);
  const loadedAssetScope = useRef<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [multiple, setMultiple] = useState(false);
  const [alphabetic, setAlphabetic] = useState(savedPosition?.alphabetic ?? false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState<{ item?: Collection; parentId: string | null } | null>(null);
  const [deleting, setDeleting] = useState<Collection | null>(null);
  const [collectionMenu, setCollectionMenu] = useState<{ item: Collection; x: number; y: number; trigger: HTMLElement } | null>(null);
  const [assign, setAssign] = useState<string[] | null>(null);
  const [manageTags, setManageTags] = useState(false);
  const [references, setReferences] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [colorsOpen, setColorsOpen] = useState(false);
  const [color, setColor] = useState<string | null>(savedPosition?.color ?? null);
  const lock = useRef(false);
  const anchor = useRef<string | null>(null);
  const alive = useRef(true);
  const previewVersion = useRef(0);
  const [grid, setGrid] = useState<HTMLDivElement | null>(null);
  const sidebar = useRef<HTMLElement>(null);
  const resizing = useRef<{ pointer: number; x: number; width: number } | null>(null);
  const [sidebarMetrics, setSidebarMetrics] = useState({ width: 208, max: 320 });
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(() => {
    try { const value = Number(localStorage.getItem("bowerbird.catalog.tagSidebarWidth")); return value >= 89 && value <= 320 ? value : null; } catch { return null; }
  });
  const [jump, setJump] = useState<{ id: string; sequence: number } | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const query = useLocalFileMode(s => s.query);
  const generatedFilter = useLocalFileMode(s => s.generatedFilter);
  const pinnedTags = useCatalogPins(s => s.ids);
  const togglePin = useCatalogPins(s => s.toggle);
  const width = useStore(s => s.libraryThumbnailWidth);
  const pinch = useThumbnailPinch("library");
  const mediaAssets = useMemo(() => assets.filter(a => isCatalogVideo(a) === (media === "videos")), [assets, media]);
  const files = useMemo(() => mediaAssets.filter(a => a.store_path).map(a => ({ path: a.store_path!, name: a.name, directory: false })), [mediaAssets]);
  const palette = useFileColors(files, colorsOpen || !!color, revision);
  const entries = useMemo(() => mediaAssets.filter(a => (!query || a.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    && (!generatedFilter || (a.generation_session_id != null) === (generatedFilter === "source:generated"))
    && (!color || (a.store_path && palette.colors.get(a.store_path)?.includes(color)))), [mediaAssets, query, generatedFilter, color, palette.colors]);
  const tags = useMemo(() => orderCatalogTags(catalog.tags, catalog.prompts, !!projectId && !alphabetic, pinnedTags), [catalog, projectId, alphabetic, pinnedTags]);
  const groups = useMemo(() => groupCatalogAssets(tags, entries, catalog.tag_asset_ids ?? {}), [tags, entries, catalog.tag_asset_ids]);
  const visibleTags = useMemo(() => tags.filter(tag => groups.some(group => group.id === tag.id)), [tags, groups]);
  const selectionOrder = useMemo(() => kind === "tags" && !flat ? [...new Map(groups.flatMap(group => group.assets).map(asset => [asset.id, asset])).values()] : entries, [kind, flat, groups, entries]);
  const rows = useMemo(() => collectionRows(catalog.collections), [catalog.collections]);
  const currentCollection = catalog.collections.find(c => c.id === active);
  const selectedAssets = entries.filter(a => selected.has(a.id));
  const scope = kind === "collections" ? currentCollection?.id ?? null : null;
  const reading = loading || catalogLoading || (!!color && palette.pending);
  const position = useRef({ active, alphabetic, color, query, generatedFilter });
  position.current = { active, alphabetic, color, query, generatedFilter };
  useLayoutEffect(() => {
    const view = scroll.current;
    return () => { browsePositions.set(positionKey, { ...position.current, top: view?.scrollTop ?? 0 }); };
  }, [positionKey]);
  useLayoutEffect(() => {
    if (reading || !grid || !restorePosition.current) return;
    const saved = restorePosition.current;
    const frame = requestAnimationFrame(() => {
      if (scroll.current && saved.query === query && saved.generatedFilter === generatedFilter) scroll.current.scrollTop = saved.top;
      restorePosition.current = undefined;
    });
    return () => cancelAnimationFrame(frame);
  }, [reading, grid, entries, query, generatedFilter]);
  useEffect(() => {
    onAssetsChange?.(mediaAssets);
    return () => onAssetsChange?.([]);
  }, [mediaAssets, onAssetsChange]);
  function navigateTag(id: string) { setActive(id); setJump(previous => ({ id, sequence: (previous?.sequence ?? 0) + 1 })); }
  function navigateLetter(letter: string) {
    const target = orderCatalogTags(visibleTags, [], false).find(tag => !pinnedTags.includes(tag.id) && catalogInitial(tag.name) === letter)
      ?? visibleTags.find(tag => catalogInitial(tag.name) === letter);
    if (target) { setAlphabetic(true); navigateTag(target.id); }
  }
  function resizeSidebar(value: number | null) {
    const maximum = Math.min(320, (sidebar.current?.parentElement?.clientWidth ?? 520) - 200);
    const next = value === null ? null : Math.max(89, Math.min(maximum, value));
    setSidebarWidth(next);
    try { if (next === null) localStorage.removeItem("bowerbird.catalog.tagSidebarWidth"); else localStorage.setItem("bowerbird.catalog.tagSidebarWidth", String(next)); } catch { /* Session width still works. */ }
  }
  useLayoutEffect(() => {
    const element = sidebar.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setSidebarMetrics({ width: Math.round(element.getBoundingClientRect().width), max: Math.min(320, (element.parentElement?.clientWidth ?? 520) - 200) }));
    observer.observe(element); if (element.parentElement) observer.observe(element.parentElement);
    return () => observer.disconnect();
  }, [kind]);
  useEffect(() => {
    alive.current = true;
    let timer: number | undefined;
    const unlisten = listen("library://assets-changed", () => {
      window.clearTimeout(timer); timer = window.setTimeout(() => setRevision(v => v + 1), 120);
    });
    return () => { alive.current = false; previewVersion.current++; window.clearTimeout(timer); void unlisten.then(stop => stop()); };
  }, []);
  useEffect(() => {
    const scopeKey = JSON.stringify([projectId, kind]);
    let current = true; setCatalogError("");
    if (loadedCatalogScope.current !== scopeKey) setCatalogLoading(true);
    materialCatalog.read(projectId).then(value => {
      if (!current) return;
      loadedCatalogScope.current = scopeKey;
      setCatalog(value);
      setActive(id => kind === "collections"
        ? value.collections.some(item => item.id === id) ? id : collectionRows(value.collections)[0]?.item.id ?? null
        : id && !value.tags.some(item => item.id === id) ? null : id);
    }).catch(error => { if (current) setCatalogError(String(error)); }).finally(() => { if (current) setCatalogLoading(false); });
    return () => { current = false; };
  }, [projectId, kind, revision]);
  useEffect(() => {
    const scopeKey = JSON.stringify([kind, scope, projectScope, projectId]);
    let current = true; setError("");
    // Classification emits an assets-changed event per image. Keep the current
    // scope visible while refreshing; only a real scope change clears its cards.
    if (loadedAssetScope.current !== scopeKey) { setLoading(true); setAssets([]); }
    // The collection browser only reads a concrete collection, never the whole library.
    if (kind === "collections" && !scope) { setLoading(false); return; }
    materialCatalog.assets(kind, scope, projectScope ? projectId : null).then(value => { if (current) { loadedAssetScope.current = scopeKey; setAssets(value); setSelected(previous => new Set([...previous].filter(id => value.some(a => a.id === id)))); } })
      .catch(error => { if (current) setError(String(error)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [kind, scope, revision, projectScope, projectId]);
  useEffect(() => {
    if (kind !== "collections" || !currentCollection) return;
    setCollapsed(previous => {
      const next = new Set(previous), visited = new Set<string>();
      let parent = currentCollection.parent_id;
      while (parent && !visited.has(parent)) {
        visited.add(parent); next.delete(parent);
        parent = catalog.collections.find(item => item.id === parent)?.parent_id;
      }
      return next.size === previous.size ? previous : next;
    });
  }, [kind, currentCollection, catalog.collections]);
  useEffect(() => {
    setSelected(new Set()); setMultiple(false); anchor.current = null; previewVersion.current++; setPreview(null); setJump(null);
    useStore.getState().closeContextMenu();
    setPinnedSection(null);
    if (scroll.current) scroll.current.scrollTop = 0;
  }, [kind, scope, query, color, generatedFilter, projectId, projectScope]);
  useLayoutEffect(() => {
    if (kind !== "tags" || !jump || reading || !grid || !scroll.current) return;
    const frame = requestAnimationFrame(() => {
      const view = scroll.current;
      const target = [...grid.querySelectorAll<HTMLElement>('[data-tag-section]')].find(el => el.dataset.tagSection === jump.id);
      if (target && view) view.scrollTop += target.getBoundingClientRect().top - view.getBoundingClientRect().top;
    });
    return () => cancelAnimationFrame(frame);
  }, [kind, jump, reading, grid, groups]);
  useEffect(() => {
    const view = scroll.current;
    if (!view || !grid) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = view.getBoundingClientRect().top;
      const sections = [...grid.querySelectorAll<HTMLElement>('[data-catalog-section]')];
      const reached = [...sections].reverse().find(el => el.getBoundingClientRect().top <= top + 0.5);
      setPinnedSection(view.scrollTop > 0 && reached ? reached.dataset.catalogSection ?? null : null);
      const current = reached ?? sections[0];
      if (kind === "tags" && current) setActive(current.dataset.tagSection ?? null);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const observer = new ResizeObserver(() => { grid.style.setProperty("--catalog-viewport-height", `${view.clientHeight}px`); schedule(); });
    observer.observe(view); observer.observe(grid); view.addEventListener("scroll", schedule);
    schedule();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); view.removeEventListener("scroll", schedule); };
  }, [kind, grid, groups]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "a" || document.querySelector('[role="dialog"], [role="menu"]')) return;
      const target = event.target as HTMLElement | null;
      if (!target?.closest('.categorized-library') || target.closest('input,textarea,select,[contenteditable="true"]') || !grid?.offsetWidth) return;
      event.preventDefault(); setMultiple(true); setSelected(new Set(entries.map(a => a.id)));
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [entries, grid]);
  function finishSelection() { setSelected(new Set()); setMultiple(false); anchor.current = null; }
  function select(asset: Asset, additive: boolean, range: boolean) {
    if (working) return;
    if (range && anchor.current) {
      const start = selectionOrder.findIndex(a => a.id === anchor.current), end = selectionOrder.indexOf(asset);
      if (start >= 0) { setSelected(previous => new Set([...previous, ...selectionOrder.slice(Math.min(start,end), Math.max(start,end) + 1).map(a => a.id)])); setMultiple(true); return; }
    }
    anchor.current = asset.id;
    if (additive || range || multiple) setSelected(previous => { const next = new Set(previous); if (next.has(asset.id)) next.delete(asset.id); else next.add(asset.id); return next; });
    else setSelected(new Set([asset.id]));
    if (additive || range) setMultiple(true);
  }
  function activate(asset: Asset) {
    if (working) return;
    const state = useStore.getState();
    if (projectId && (state.activeProjectId !== projectId || !state.canvasLibraryOpen)) return;
    if (projectId && (state.boardOpen || state.genEditing)) {
      window.dispatchEvent(new CustomEvent("bowerbird://board-asset-picked", { detail: asset.id }));
    } else void openPreview(asset);
  }
  function openDetail(asset: Asset) {
    if (working) return;
    previewVersion.current++;
    setPreview(null);
    useStore.getState().openDetail(asset.id);
  }
  async function openPreview(asset: Asset) {
    const version = ++previewVersion.current;
    try {
      if (!asset.store_path) throw new Error("素材原文件不可用");
      const path = await externalFiles.media(asset.store_path);
      if (alive.current && version === previewVersion.current) setPreview(path);
    } catch (error) { if (alive.current && version === previewVersion.current) notifyError(error, "无法预览素材"); }
  }
  function context(asset: Asset, x: number, y: number) {
    if (working) return;
    const targets = selected.has(asset.id) ? selectedAssets : [asset];
    if (!selected.has(asset.id)) setSelected(new Set([asset.id]));
    useStore.getState().openContextMenu(x, y, asset.id, { asset, libraryProjectId: projectScope ? projectId ?? undefined : undefined, fileSelection: { assets: targets, openReferences: () => setReferences(true),
      onComplete: finishSelection, select: () => { setMultiple(true); setSelected(previous => new Set([...previous, asset.id])); } } });
  }
  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setWorking(true);
    try { await action(); }
    catch (error) { notifyError(error, "操作失败"); }
    finally { lock.current = false; if (alive.current) setWorking(false); }
  }
  function toggle(id: string) { setCollapsed(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  function hidden(id: string) {
    const visited = new Set<string>();
    let parent = catalog.collections.find(c => c.id === id)?.parent_id;
    while (parent && !visited.has(parent)) { if (collapsed.has(parent)) return true; visited.add(parent); parent = catalog.collections.find(c => c.id === parent)?.parent_id; }
    return false;
  }
  function listKey(event: React.KeyboardEvent<HTMLElement>) {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-catalog-item]')];
    const index = items.indexOf(document.activeElement?.closest<HTMLElement>('[data-catalog-item]') as HTMLElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : Math.max(0, Math.min(items.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
    event.preventDefault(); event.stopPropagation(); items[next]?.focus();
  }
  return <section className={`categorized-library${kind === "tags" && !flat ? " is-tag-catalog" : ""}`} aria-label={flat ? "平铺浏览视频" : kind === "tags" ? "按标签浏览素材" : "按集合浏览素材"}
    style={{ ...glass.style, ...(sidebarWidth !== null ? { "--catalog-sidebar-width": `${sidebarWidth}px` } : {}) } as CSSProperties}>
    {glass.definition}
    <div className="catalog-body">
      {!flat && <aside ref={sidebar} className="catalog-sidebar" aria-label={kind === "tags" ? "标签分类" : "集合目录"}>
        <div className="catalog-sidebar-heading"><strong>{kind === "tags" ? "标签" : "集合"}</strong>
          <button title={kind === "tags" ? "管理标签" : "新建集合"} aria-label={kind === "tags" ? "管理标签" : "新建集合"}
            onClick={() => kind === "tags" ? setManageTags(true) : setEditor({ parentId: null })}>{kind === "tags" ? <Settings2 size={15}/> : <Plus size={16}/>}</button></div>
        {kind === "tags" && <p className="catalog-sort-note">{projectId ? <button onClick={() => { setAlphabetic(v => !v); setJump(null); if (scroll.current) scroll.current.scrollTop = 0; }} title="根据本项目生图提示词和素材标签在本机排序；点击切换拼音顺序">{alphabetic ? "拼音 A–Z" : "项目相关优先"}</button> : "拼音 A–Z"}</p>}
        {catalogError && <p className="catalog-error" role="alert">{catalogError}<button onClick={() => setRevision(v => v + 1)}>重试</button></p>}
        {kind === "tags" ? <CatalogTagIndex tags={visibleTags} active={active} alphabetic={!projectId || alphabetic} pinned={pinnedTags} onTogglePin={id => { togglePin(id); setJump(null); if (scroll.current) scroll.current.scrollTop = 0; }} onNavigate={navigateTag} onLetter={navigateLetter}/> : <OverlayScrollArea className="catalog-tree-scroll" viewportClassName="catalog-index" label="集合目录滚动条">
          <div role="tree" aria-label="集合层级" onKeyDown={listKey}>
            {rows.filter(row => !hidden(row.item.id)).map(({ item, depth, path }) => {
              const children = catalog.collections.some(c => c.parent_id === item.id);
              return <div key={item.id} data-catalog-item data-collection-id={item.id} role="treeitem" aria-label={item.name} aria-level={depth + 1} aria-selected={active === item.id}
                aria-expanded={children ? !collapsed.has(item.id) : undefined} tabIndex={active === item.id ? 0 : -1} title={path}
                className={`catalog-row catalog-tree-row${collectionMenu?.item.id === item.id ? " is-menu-open" : ""}`} style={{ paddingLeft: 4 + Math.min(depth, 8) * 24 }} onClick={event => { setActive(item.id); event.currentTarget.focus(); }}
                onKeyDown={event => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setActive(item.id); }
                  if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
                    event.preventDefault(); event.stopPropagation();
                    if (children && (event.key === "ArrowLeft" ? !collapsed.has(item.id) : collapsed.has(item.id))) toggle(item.id);
                    else {
                      const target = event.key === "ArrowLeft" ? item.parent_id : rows.find(row => row.item.parent_id === item.id)?.item.id;
                      if (target) [...event.currentTarget.parentElement!.querySelectorAll<HTMLElement>('[data-collection-id]')]
                        .find(row => row.dataset.collectionId === target)?.focus();
                    }
                  }
                }}>
                {children && <button className="catalog-tree-toggle" tabIndex={-1} aria-label={`${collapsed.has(item.id) ? "展开" : "收起"}${item.name}`} onClick={e => { e.stopPropagation(); toggle(item.id); }}>{collapsed.has(item.id) ? <ChevronRight size={12}/> : <ChevronDown size={12}/>}</button>}
                <Folder className="catalog-tree-icon" size={14} aria-hidden="true"/><span className="catalog-tree-name">{item.name}</span>
                <div className="catalog-tree-row-actions">
                <button className="catalog-tree-add" aria-label={`在「${item.name}」中新建子集合`} title="新建子集合"
                  onClick={event => { event.stopPropagation(); setEditor({ parentId: item.id }); }}><Plus size={14}/></button>
                <button aria-label={`「${item.name}」的更多操作`} title="更多操作" aria-haspopup="menu" aria-expanded={collectionMenu?.item.id === item.id}
                  onClick={event => { event.stopPropagation(); const trigger = event.currentTarget, rect = trigger.getBoundingClientRect(); setCollectionMenu({ item, x: rect.right, y: rect.bottom, trigger }); }}><MoreHorizontal size={14}/></button>
                </div>
              </div>;
            })}
          </div>
          {catalogLoading && <p className="catalog-hint" role="status">正在读取集合…</p>}
          {!catalogLoading && !catalog.collections.length && !catalogError && <p className="catalog-hint">还没有集合，点击上方 ＋ 创建。</p>}
        </OverlayScrollArea>}
        <div className="catalog-sidebar-resize" role="separator" aria-label={kind === "tags" ? "调整标签侧栏宽度" : "调整集合侧栏宽度"} aria-orientation="vertical"
          tabIndex={0} aria-valuemin={89} aria-valuemax={sidebarMetrics.max} aria-valuenow={sidebarMetrics.width} title="拖动调宽 · 左右键微调 · 双击恢复默认宽度"
          onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); resizing.current = { pointer: event.pointerId, x: event.clientX, width: sidebar.current!.getBoundingClientRect().width }; }}
          onPointerMove={event => { const start = resizing.current; if (start?.pointer === event.pointerId) resizeSidebar(start.width + event.clientX - start.x); }}
          onPointerUp={() => { resizing.current = null; }} onPointerCancel={() => { resizing.current = null; }} onLostPointerCapture={() => { resizing.current = null; }}
          onDoubleClick={() => resizeSidebar(null)} onKeyDown={event => {
            if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
            event.preventDefault(); event.stopPropagation(); resizeSidebar(event.key === "Home" ? null : (sidebar.current?.getBoundingClientRect().width ?? 208) + (event.key === "ArrowLeft" ? -16 : 16));
          }}/>
      </aside>}
      <div ref={pinch} className="catalog-gallery">
        <div className="file-view-heading">
          {navigation}
          <LibraryFloatingControls>
            <LibraryMediaSwitch/>
            <GeneratedImageFilter floating value={generatedFilter} onChange={useLocalFileMode.getState().setGeneratedFilter}/>
            <LibraryBrowserButton/>
            <FileColorFilter open={colorsOpen} onOpenChange={setColorsOpen} color={color} onColorChange={setColor} palette={palette}/>
          </LibraryFloatingControls>
        </div>
        {flat && catalogError && <p className="catalog-error" role="alert">{catalogError}<button onClick={() => setRevision(v => v + 1)}>重试</button></p>}
        {error && <p role="alert" className="catalog-error">{error}<button onClick={() => setRevision(v => v + 1)}>重试</button></p>}
        <OverlayScrollArea scrollRef={scroll} className="catalog-scroll" viewportClassName="catalog-scroller library-scroller">
          {reading ? <p className="catalog-hint catalog-empty" role="status">正在读取素材…</p> : !entries.length && !error && !catalogError ? <p className="catalog-hint catalog-empty">{kind === "collections" && !currentCollection ? "还没有集合，点击左侧 ＋ 新建集合。" : query || color || generatedFilter ? "没有匹配的素材。" : kind === "tags" ? "还没有已登记的素材。" : "集合还没有素材。可在素材右键菜单中选择「添加到集合」。"}</p> : null}
          {color && !!palette.failed && <p className="catalog-error" role="alert">{palette.failed} 项颜色读取失败<button onClick={palette.retry}>重试</button></p>}
          <div ref={setGrid} className={`catalog-sections${kind === "tags" ? " catalog-tag-sections" : ""}`} aria-label="分类素材">
            {entries.length > 0 && (flat ? <CatalogMediaGrid assets={entries} width={width} selected={selected} revision={revision} onSelect={select} onActivate={multiple ? undefined : activate} onOpen={openDetail} onContextMenu={context}/> : kind === "tags" ? !reading && !error && !catalogError && groups.map(group => <CatalogSection key={group.id} tagId={group.id} title={group.name} pinned={pinnedSection === group.id}>
              <CatalogMediaGrid assets={group.assets} width={width} selected={selected} revision={revision} onSelect={select} onActivate={multiple ? undefined : activate} onOpen={openDetail} onContextMenu={context}/>
            </CatalogSection>) : currentCollection && <CatalogSection title={currentCollection.name} pinned={pinnedSection === "collection"}>
              <CatalogMediaGrid assets={entries} width={width} selected={selected} revision={revision} onSelect={select} onActivate={multiple ? undefined : activate} onOpen={openDetail} onContextMenu={context}/>
            </CatalogSection>)}
          </div>
        </OverlayScrollArea>
        <ThumbnailSizeSlider scope="library"/>
        {(selectedAssets.length > 0 || multiple) && <div className="catalog-selection" role="group" aria-label="分类素材所选操作">
          <button aria-label="取消选择" disabled={working} onClick={finishSelection}><X size={14}/></button>
          <span>{selectedAssets.length} 项</span><button disabled={working} onClick={() => { setMultiple(true); setSelected(new Set(entries.map(a => a.id))); }}>全选</button>
          <button disabled={working || !selectedAssets.length} onClick={() => setAssign(selectedAssets.map(a => a.id))}>添加到集合</button>
          {kind === "collections" && active && <button disabled={working || !selectedAssets.length} onClick={() => void run(async () => { await materialCatalog.members(active, selectedAssets.map(a => a.id), false); finishSelection(); setRevision(v => v + 1); })}>移出集合</button>}
          <button disabled={working || !selectedAssets.length} onClick={() => void run(async () => { await addMaterialAssets(selectedAssets, projectId, onClose, onCreateProject); finishSelection(); notifySuccess(projectId ? "已添加到画板" : "已添加到新项目素材库"); })}>{projectId ? "添加到画板" : "添加到新项目"}</button>
        </div>}
      </div>
    </div>
    {preview && <Lightbox images={[preview]} index={0} onIndexChange={() => {}} onClose={() => setPreview(null)}/>}
    {manageTags && <LocalClassificationDialog initialView="labels" projectId={projectScope ? projectId ?? undefined : undefined} onClose={() => { setManageTags(false); setRevision(v => v + 1); }}/>}
    {references && <ModalShell title="外部引用" width="lg" onClose={() => setReferences(false)}><LocalFileBrowser initialTab="references" onClose={() => setReferences(false)} onCreateProject={() => void onCreateProject?.()}/></ModalShell>}
    {editor && <CollectionEditorDialog {...editor} collections={catalog.collections} onClose={() => setEditor(null)} onSaved={id => { setActive(id); setRevision(v => v + 1); }}/>}
    {collectionMenu && <ContextMenu x={collectionMenu.x} y={collectionMenu.y} label="集合操作" trigger={collectionMenu.trigger} onClose={() => setCollectionMenu(null)}>
      <button role="menuitem" className="app-context-item px-2 py-1.5" onClick={() => { setEditor({ item: collectionMenu.item, parentId: collectionMenu.item.parent_id ?? null }); setCollectionMenu(null); }}><Pencil size={13} aria-hidden="true"/>重命名</button>
      <DeleteSubmenu><button role="menuitem" className="app-context-item is-danger px-2 py-1.5" onClick={() => { setDeleting(collectionMenu.item); setCollectionMenu(null); }}><Trash2 size={13} aria-hidden="true"/>删除集合</button></DeleteSubmenu>
    </ContextMenu>}
    {assign && <CollectionAssignDialog assetIds={assign} onClose={() => setAssign(null)} onSaved={() => { finishSelection(); setRevision(v => v + 1); }}/>}
    {deleting && <ModalShell title="删除集合" onClose={() => setDeleting(null)} preventClose={working}>
      <p>删除「{deleting.name}」及其子集合？只移除集合关系，素材和电脑中的原文件均保留。</p>
      <button className="app-button-dark" disabled={working} onClick={() => void run(async () => { await materialCatalog.deleteCollection(deleting.id); setDeleting(null); setActive(null); setRevision(v => v + 1); })}>{working ? "删除中…" : "删除集合"}</button>
    </ModalShell>}
  </section>;
}

/** Tags and collections share the same floating heading and content layout. */
function CatalogSection({ tagId, title, pinned, children }: { tagId?: string; title: string; pinned: boolean; children: ReactNode }) {
  return <section data-catalog-section={tagId ?? "collection"} data-tag-section={tagId} aria-label={`${title}${tagId ? "图片" : "素材"}`}>
    <h3 className={`catalog-section-heading${pinned ? " is-pinned" : ""}`}><span className={`catalog-section-title${pinned ? " library-floating-surface" : ""}`} title={title}>{title}</span></h3>
    {children}
  </section>;
}

function CatalogMediaGrid({ assets, width, selected, revision, onSelect, onActivate, onOpen, onContextMenu }: {
  assets: Asset[]; width: number; selected: Set<string>; revision: number;
  onSelect: (asset: Asset, additive: boolean, range: boolean) => void; onOpen: (asset: Asset) => void;
  onActivate?: (asset: Asset) => void;
  onContextMenu: (asset: Asset, x: number, y: number) => void;
}) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  useMasonryLayout(element, width, assets, 8);
  return <div ref={setElement} className="folder-masonry" style={assets.length ? undefined : { height: 0 }}>{assets.map(asset => <FileMediaCard key={asset.id}
    entry={{ path: asset.store_path ?? "", name: asset.name, directory: false, preview: asset.thumb_path, version: `${asset.id}:${asset.file_mtime ?? 0}:${asset.thumb_path}` }}
    selected={selected.has(asset.id)} revision={revision} labels={[]} aspectRatio={asset.width && asset.height ? asset.width / asset.height : undefined}
    assetId={asset.id} generated={asset.generation_session_id != null} onDragStart={event => {
      const ids = selected.has(asset.id) ? [...selected] : [asset.id];
      setDragAssets(ids); event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData("text/plain", ids.join(","));
    }} onDragEnd={() => setDragAssets(null)}
    onSelect={(additive, range) => onSelect(asset, additive, range)} onActivate={onActivate ? () => onActivate(asset) : undefined}
    onOpen={() => onOpen(asset)} onContextMenu={(x,y) => onContextMenu(asset,x,y)}/>)}</div>;
}
