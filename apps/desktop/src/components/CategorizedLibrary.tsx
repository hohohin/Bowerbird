import { useLibraryModeStore, useLibraryPane, useLibraryThumbnail, useLibraryPins, type LibraryBrowsePosition } from "../lib/libraryPane";
import { getDragAssets, getDragAssetName, getDragAssetPreview } from "../lib/dragPayload";
import { localClassification, projectClassification } from "../lib/localClassification";
import { LibraryDropPreview } from "./LibraryDropPreview";
import { userErrorMessage } from "../lib/userError";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { ChevronDown, ChevronRight, Folder, MoreHorizontal, Pencil, Plus, Settings2, Trash2, X } from "lucide-react";
import { materialCatalog, type CatalogKind, type MaterialCatalog, type CatalogFilter } from "../lib/materialCatalog";
import { catalogInitial, collectionRows, orderCatalogTags, UNTAGGED_SECTION } from "../lib/materialCatalogOrder";
import { type LibraryMedia } from "../lib/localFileMode";
import { api } from "../lib/api";
import { VirtualCatalog, type CatalogLocation } from "./VirtualCatalog";
import type { CatalogSectionInfo } from "../lib/catalogVirtualLayout";
import { useThumbnailPinch } from "../lib/useThumbnailPinch";
import { addMaterialAssets } from "../lib/materialActions";
import { externalFiles } from "../lib/externalFiles";
import { notifyError, notifySuccess } from "../lib/notify";
import { useStore } from "../store";
import type { Asset, Folder as Collection } from "../lib/types";
import { FileColorFilter } from "./FileColorFilter";
import { LibraryFloatingControls } from "./LibraryFloatingControls";
import { LibraryBrowserButton } from "./LibraryBrowserButton";
import { LibraryMediaSwitch } from "./LibraryMediaSwitch";
import { GeneratedImageFilter } from "./GeneratedImageFilter";
import { useLibraryGlass } from "./useLibraryGlass";
import { LibraryMotion } from "./LibraryMotion";
import { LibraryTacticalBackdrop } from "./LibraryTacticalBackdrop";
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

const browsePositions = new Map<string, LibraryBrowsePosition>();

export function CategorizedLibrary({ kind, media = "images", projectId = null, projectScope = false, navigation, onClose, onCreateProject, onAssetsChange, positionId = "default", showEmptyTags = false, toolbarActions, dropPreview = false }: {
  kind: CatalogKind; projectId?: string | null; projectScope?: boolean; navigation: ReactNode; onClose: () => void; onCreateProject?: (ids?: string[]) => Promise<unknown>;
  media?: LibraryMedia; positionId?: string; showEmptyTags?: boolean;
  toolbarActions?: ReactNode; dropPreview?: boolean;
  onAssetsChange?: (assets: Asset[]) => void;
}) {
  const useLocalFileMode = useLibraryModeStore();
  const pane = useLibraryPane();
  const root = useRef<HTMLElement>(null);
  const glass = useLibraryGlass();
  const positions = pane?.positions ?? browsePositions;
  const positionKey = JSON.stringify([pane ? "pane" : positionId, projectId, projectScope, media, kind]);
  const [savedPosition] = useState(() => positions.get(positionKey));
  const flat = kind === "all" || (media === "videos" && kind === "tags");
  const [catalog, setCatalog] = useState<MaterialCatalog>({ tags: [], collections: [], prompts: [], tag_asset_ids: {} });
  const [active, setActive] = useState<string | null>(savedPosition?.active ?? null);
  const [total, setTotal] = useState(0);
  const [untagged, setUntagged] = useState(0);
  const [revision, setRevision] = useState(0);
  const [catalogError, setCatalogError] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(true);
  const loadedCatalogScope = useRef<string | null>(null);
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
  const [colorProgress, setColorProgress] = useState({ pending: false, failed: 0 });
  const [colorRetry, setColorRetry] = useState(0);
  const lock = useRef(false);
  const anchor = useRef<CatalogLocation | null>(null);
  const selectionVersion = useRef(0);
  const alive = useRef(true);
  const previewVersion = useRef(0);
  const sidebar = useRef<HTMLElement>(null);
  const resizing = useRef<{ pointer: number; x: number; width: number } | null>(null);
  const [sidebarMetrics, setSidebarMetrics] = useState({ width: 208, max: 320 });
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(() => {
    try { const value = Number(localStorage.getItem(`bowerbird.catalog.tagSidebarWidth${pane ? `.${pane.id}` : ""}`)); return value >= 89 && value <= 320 ? value : null; } catch { return null; }
  });
  const [jump, setJump] = useState<{ id: string; sequence: number } | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const query = useLocalFileMode(s => s.query);
  const generatedFilter = useLocalFileMode(s => s.generatedFilter);
  const [dragItem, setDragItem] = useState({ name: "", preview: null as string | null, count: 0 });
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const { ids: pinnedTags, toggle: togglePin } = useLibraryPins();
  const { width } = useLibraryThumbnail("library");
  const pinch = useThumbnailPinch("library");
  const tags = useMemo(() => orderCatalogTags(catalog.tags, catalog.prompts, !!projectId && !alphabetic, pinnedTags), [catalog, projectId, alphabetic, pinnedTags]);
  const visibleTags = useMemo(() => tags.filter(tag => showEmptyTags || tag.count > 0), [tags, showEmptyTags]);
  const rows = useMemo(() => collectionRows(catalog.collections), [catalog.collections]);
  const currentCollection = catalog.collections.find(c => c.id === active);
  const scope = kind === "collections" ? currentCollection?.id ?? null : null;
  const filter = useMemo<CatalogFilter>(() => ({ kind: flat ? "all" : kind, id: scope, projectId: projectScope ? projectId : null, media,
    query, generated: generatedFilter ? generatedFilter === "source:generated" : null, color }), [kind, flat, scope, projectScope, projectId, media, query, generatedFilter, color]);
  const filterKey = JSON.stringify([filter, projectId]);
  const filterKeyRef = useRef(filterKey); filterKeyRef.current = filterKey;
  const reading = catalogLoading;
  const palette = { colors: new Map<string, string[]>(), ...colorProgress, retry: () => setColorRetry(v => v + 1) };
  const colorScope = JSON.stringify({ ...filter, color: null });
  const indexColors = colorsOpen || !!color;
  useEffect(() => {
    if (!indexColors) { setColorProgress({ pending: false, failed: 0 }); return; }
    let current = true;
    setColorProgress({ pending: true, failed: 0 });
    void (async () => {
      let after: string | null = null, failed = 0;
      try {
        do {
          const batch = await materialCatalog.prepareColors(JSON.parse(colorScope), after);
          if (!current) return;
          failed += batch.failed; after = batch.after;
          setColorProgress({ pending: batch.more, failed });
          if (batch.updated) setRevision(v => v + 1);
          if (!batch.more) break;
        } while (current);
      } catch { if (current) setColorProgress({ pending: false, failed: failed + 1 }); }
    })();
    return () => { current = false; };
  }, [colorScope, indexColors, colorRetry]);
  const sections = useMemo<CatalogSectionInfo[]>(() => flat ? [{ id: "all", name: "", count: total, tagId: null }]
    : kind === "tags" ? [...visibleTags.map(tag => ({ id: tag.id, name: tag.name, count: tag.count, tagId: tag.id })),
      ...(untagged ? [{ id: UNTAGGED_SECTION, name: "未分类", count: untagged, tagId: UNTAGGED_SECTION }] : [])]
    : currentCollection ? [{ id: "collection", name: currentCollection.name, count: total, tagId: null }] : [], [flat, kind, total, visibleTags, untagged, currentCollection]);
  const onActive = useCallback((id: string | null) => { if (kind === "tags" && !flat) setActive(id); }, [kind, flat]);
  const position = useRef({ active, alphabetic, color, query, generatedFilter });
  position.current = { active, alphabetic, color, query, generatedFilter };
  useLayoutEffect(() => {
    const view = scroll.current;
    const save = () => positions.set(positionKey, { ...position.current, top: view?.scrollTop ?? 0 });
    view?.addEventListener("scroll", save, { passive: true });
    return () => { save(); view?.removeEventListener("scroll", save); };
  }, [positionKey, positions]);
  useLayoutEffect(() => { positions.set(positionKey, { ...position.current, top: scroll.current?.scrollTop ?? 0 }); });
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
    try { if (next === null) localStorage.removeItem(`bowerbird.catalog.tagSidebarWidth${pane ? `.${pane.id}` : ""}`); else localStorage.setItem(`bowerbird.catalog.tagSidebarWidth${pane ? `.${pane.id}` : ""}`, String(next)); } catch { /* Session width still works. */ }
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
    let current = true; setCatalogError("");
    if (loadedCatalogScope.current !== filterKey) setCatalogLoading(true);
    materialCatalog.overview(filter, projectId).then(value => {
      if (!current) return;
      loadedCatalogScope.current = filterKey;
      setCatalog(value.catalog); setTotal(value.total); setUntagged(value.untagged);
      setActive(id => kind === "collections"
        ? value.catalog.collections.some(item => item.id === id) ? id : collectionRows(value.catalog.collections)[0]?.item.id ?? null
        : id);
    }).catch(error => { if (current) setCatalogError(String(error)); }).finally(() => { if (current) setCatalogLoading(false); });
    return () => { current = false; };
  }, [filterKey, revision]);
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
    selectionVersion.current++;
    if (scroll.current) scroll.current.scrollTop = 0;
  }, [filterKey]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "a" || document.querySelector('[role="dialog"], [role="menu"]')) return;
      const target = event.target as HTMLElement | null;
      if (!target || !root.current?.contains(target) || target.closest('input,textarea,select,[contenteditable="true"]')) return;
      event.preventDefault(); void selectAll();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [filterKey, total, working]);
  function finishSelection() { selectionVersion.current++; setSelected(new Set()); setMultiple(false); anchor.current = null; }
  async function readIds(queryFilter: CatalogFilter, start: number, count: number) {
    const result: string[] = [], version = selectionVersion.current;
    for (let offset = start; offset < start + count; offset += 2000) {
      if (!alive.current || version !== selectionVersion.current) return [];
      const ids = await materialCatalog.ids(queryFilter, offset, Math.min(2000, start + count - offset));
      result.push(...ids);
      if (ids.length < Math.min(2000, start + count - offset)) break;
    }
    return result;
  }
  async function selectAll() {
    if (working || reading) return;
    const version = selectionVersion.current;
    await run(async () => {
      const ids = await readIds(filter, 0, total);
      if (alive.current && selectionVersion.current === version) { setSelected(new Set(ids)); setMultiple(true); }
    });
  }
  async function resolveSelection(ids = [...selected]) {
    const assets: Asset[] = [];
    for (let i = 0; i < ids.length; i += 200) assets.push(...await api.getAssetsByIds(ids.slice(i, i + 200)));
    if (assets.length !== ids.length) throw new Error("部分所选素材已不存在，请重新选择");
    return assets;
  }
  function select(asset: Asset, additive: boolean, range: boolean, location: CatalogLocation) {
    if (working) return;
    if (range && anchor.current) {
      const from = anchor.current, version = selectionVersion.current;
      const a = sections.findIndex(s => s.id === from.section), b = sections.findIndex(s => s.id === location.section);
      if (a >= 0 && b >= 0) {
        void run(async () => {
          const forward = a < b || (a === b && from.index <= location.index);
          const first = forward ? from : location, last = forward ? location : from;
          const ids: string[] = [];
          for (let i = Math.min(a,b); i <= Math.max(a,b); i++) {
            const section = sections[i], start = section.id === first.section ? first.index : 0;
            const end = section.id === last.section ? last.index : section.count - 1;
            for (const id of await readIds({ ...filter, id: section.tagId ?? filter.id }, start, end - start + 1)) ids.push(id);
          }
          if (alive.current && selectionVersion.current === version) { setSelected(previous => new Set([...previous, ...ids])); setMultiple(true); }
        });
        return;
      }
    }
    anchor.current = location;
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
  function openDetail(asset: Pick<Asset, "id">) {
    if (working) return;
    previewVersion.current++;
    setPreview(null);
    useStore.getState().openDetail(asset.id);
  }
  async function openPreview(asset: Pick<Asset, "store_path">) {
    const version = ++previewVersion.current;
    try {
      if (!asset.store_path) throw new Error("素材原文件不可用");
      const path = await externalFiles.media(asset.store_path);
      if (alive.current && version === previewVersion.current) setPreview(path);
    } catch (error) { if (alive.current && version === previewVersion.current) notifyError(error, "无法预览素材"); }
  }
  function context(asset: Asset, x: number, y: number) {
    if (working) return;
    const ids = selected.has(asset.id) ? [...selected] : [asset.id];
    const key = filterKey;
    if (!selected.has(asset.id)) setSelected(new Set([asset.id]));
    void run(async () => {
      const targets = ids.length === 1 ? [asset] : await resolveSelection(ids);
      if (!alive.current || filterKeyRef.current !== key) return;
      useStore.getState().openContextMenu(x, y, asset.id, { asset, libraryProjectId: projectScope ? projectId ?? undefined : undefined, fileSelection: { assets: targets, openReferences: () => setReferences(true),
        onComplete: finishSelection, select: () => { setMultiple(true); setSelected(previous => new Set([...previous, asset.id])); } } });
    });
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
  useEffect(() => {
    const clear = () => setDropTarget(null);
    window.addEventListener("dragend", clear); window.addEventListener("drop", clear);
    return () => { window.removeEventListener("dragend", clear); window.removeEventListener("drop", clear); };
  }, []);
  const dropName = kind === "tags" ? catalog.tags.find(tag => tag.id === dropTarget)?.name : catalog.collections.find(item => item.id === dropTarget)?.name;
  function dropDestination(target: EventTarget) {
    const element = (target as HTMLElement).closest<HTMLElement>(kind === "tags" ? '[data-tag-id], [data-tag-section]' : '[data-collection-id], .catalog-gallery');
    const id = kind === "tags" ? element?.dataset.tagId ?? element?.dataset.tagSection : element?.dataset.collectionId ?? (element ? active : null);
    return id === UNTAGGED_SECTION ? null : id ?? null;
  }
  return <section ref={root} onDragOver={event => {
    const id = !flat && dropDestination(event.target);
    if (!id || !getDragAssets()?.length || working) { setDropTarget(null); return; }
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy"; setDropTarget(id);
    const ids = getDragAssets()!;
    const name = getDragAssetName() ?? "图片", preview = getDragAssetPreview();
    setDragItem(previous => previous.name === name && previous.preview === preview && previous.count === ids.length ? previous : { name, preview, count: ids.length });
  }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null); }}
    onDragEnd={() => setDropTarget(null)} onDrop={event => {
      const id = !flat && dropDestination(event.target), ids = getDragAssets(); setDropTarget(null);
      if (!id || !ids?.length) return;
      event.preventDefault(); event.stopPropagation();
      void run(async () => {
        if (kind === "tags") await (projectScope && projectId ? projectClassification(projectId) : localClassification).example(id, [...new Set(ids)], true);
        else await materialCatalog.members(id, [...new Set(ids)]);
        if (alive.current) setRevision(value => value + 1);
        notifySuccess(kind === "tags" ? "已添加手动分类" : "已添加到集合");
      });
    }} data-drop-target={dropTarget ?? undefined} data-file-import-project-id={projectScope ? projectId ?? "" : ""} className={`categorized-library library-tactical${kind === "tags" && !flat ? " is-tag-catalog" : ""}`} aria-label={flat ? media === "videos" ? "平铺浏览视频" : "平铺浏览全部图片" : kind === "tags" ? "按标签浏览素材" : "按集合浏览素材"}
    style={{ ...glass.style, ...(sidebarWidth !== null ? { "--catalog-sidebar-width": `${sidebarWidth}px` } : {}) } as CSSProperties}>
    {dropPreview && dropTarget && dropName && <LibraryDropPreview {...dragItem} target={dropName} collection={kind === "collections"}/>}
    {glass.definition}
    <LibraryMotion />
    <div className="catalog-body">
      {!flat && <aside ref={sidebar} className="catalog-sidebar" aria-label={kind === "tags" ? "标签分类" : "集合目录"}>
        <div className="catalog-sidebar-heading"><strong>{kind === "tags" ? "标签" : "集合"}</strong>
          <button title={kind === "tags" ? "管理标签" : "新建集合"} aria-label={kind === "tags" ? "管理标签" : "新建集合"}
            onClick={() => kind === "tags" ? setManageTags(true) : setEditor({ parentId: null })}>{kind === "tags" ? <Settings2 size={15}/> : <Plus size={16}/>}</button></div>
        {kind === "tags" && <p className="catalog-sort-note">{projectId ? <button onClick={() => { setAlphabetic(v => !v); setJump(null); if (scroll.current) scroll.current.scrollTop = 0; }} title="根据本项目生图提示词和素材标签在本机排序；点击切换拼音顺序">{alphabetic ? "拼音 A–Z" : "项目相关优先"}</button> : "拼音 A–Z"}</p>}
        {catalogError && <p className="catalog-error" role="alert">{userErrorMessage(catalogError, "素材列表暂时无法读取，请重试。")}<button onClick={() => setRevision(v => v + 1)}>重试</button></p>}
        {kind === "tags" ? <CatalogTagIndex tags={visibleTags} active={active} dropTarget={dropTarget} alphabetic={!projectId || alphabetic} pinned={pinnedTags} onTogglePin={id => { togglePin(id); setJump(null); if (scroll.current) scroll.current.scrollTop = 0; }} onNavigate={navigateTag} onLetter={navigateLetter}/> : <OverlayScrollArea className="catalog-tree-scroll" viewportClassName="catalog-index" label="集合目录滚动条">
          <div role="tree" aria-label="集合层级" onKeyDown={listKey}>
            {rows.filter(row => !hidden(row.item.id)).map(({ item, depth, path }) => {
              const children = catalog.collections.some(c => c.parent_id === item.id);
              return <div key={item.id} data-catalog-item data-collection-id={item.id} role="treeitem" aria-label={item.name} aria-level={depth + 1} aria-selected={active === item.id}
                aria-expanded={children ? !collapsed.has(item.id) : undefined} tabIndex={active === item.id ? 0 : -1} title={path}
                className={`catalog-row catalog-tree-row${dropTarget === item.id ? " is-drop-target" : ""}${collectionMenu?.item.id === item.id ? " is-menu-open" : ""}`} style={{ paddingLeft: 4 + Math.min(depth, 8) * 24 }} onClick={event => { setActive(item.id); event.currentTarget.focus(); }}
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
        <LibraryTacticalBackdrop />
        <div className="file-view-heading">
          {navigation}
          <LibraryFloatingControls>
            <LibraryMediaSwitch/>
            <GeneratedImageFilter floating value={generatedFilter} onChange={useLocalFileMode.getState().setGeneratedFilter}/>
            <LibraryBrowserButton/>
            <FileColorFilter open={colorsOpen} onOpenChange={setColorsOpen} color={color} onColorChange={setColor} palette={palette}/>
            {toolbarActions}
          </LibraryFloatingControls>
        </div>
        {flat && catalogError && <p className="catalog-error" role="alert">{userErrorMessage(catalogError, "素材列表暂时无法读取，请重试。")}<button onClick={() => setRevision(v => v + 1)}>重试</button></p>}
        <OverlayScrollArea scrollRef={scroll} className="catalog-scroll" viewportClassName="catalog-scroller library-scroller" viewportStyle={{ paddingBottom: 0, overflowAnchor: "none" }}>
          {reading ? <p className="catalog-hint catalog-empty" role="status">正在读取素材…</p> : !total && !catalogError ? <p className="catalog-hint catalog-empty">{kind === "collections" && !currentCollection ? "还没有集合，点击左侧 ＋ 新建集合。" : query || color || generatedFilter ? "没有匹配的素材。" : kind !== "collections" ? "还没有已登记的素材。" : "集合还没有素材。可在素材右键菜单中选择「添加到集合」。"}</p> : null}
          {loadedCatalogScope.current === filterKey && <VirtualCatalog key={filterKey} filter={filter} sections={sections} headings={!flat} width={width} revision={revision} scroll={scroll}
            selected={selected} jump={jump} initialTop={savedPosition?.query === query && savedPosition?.color === color && savedPosition?.generatedFilter === generatedFilter ? savedPosition.top : 0}
            onActive={onActive} onAssetsChange={onAssetsChange} onSelect={select} onActivate={multiple || working ? undefined : activate} onOpen={openDetail} onContextMenu={context}/>}
        </OverlayScrollArea>
        <ThumbnailSizeSlider scope="library"/>
        {(selected.size > 0 || multiple) && <div className="catalog-selection" role="group" aria-label="分类素材所选操作">
          <button aria-label="取消选择" disabled={working} onClick={finishSelection}><X size={14}/></button>
          <span>{working ? "正在处理…" : `${selected.size} 项`}</span><button disabled={working} onClick={() => void selectAll()}>全选</button>
          <button disabled={working || !selected.size} onClick={() => setAssign([...selected])}>添加到集合</button>
          {kind === "collections" && active && <button disabled={working || !selected.size} onClick={() => void run(async () => { await materialCatalog.members(active, [...selected], false); finishSelection(); setRevision(v => v + 1); })}>移出集合</button>}
          <button disabled={working || !selected.size} onClick={() => void run(async () => { const key = filterKey; const assets = await resolveSelection(); if (!alive.current || filterKeyRef.current !== key) return; await addMaterialAssets(assets, projectId, onClose, onCreateProject); finishSelection(); notifySuccess(projectId ? "已添加到画板" : "已添加到新项目素材库"); })}>{projectId ? "添加到画板" : "添加到新项目"}</button>
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
