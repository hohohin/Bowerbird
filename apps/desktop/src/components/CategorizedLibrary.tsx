import { useLibraryModeStore, useLibraryPane, useLibraryThumbnail, useLibraryPins, libraryHasOverlay, type LibraryBrowsePosition } from "../lib/libraryPane";
import { getDragAssets, getDragAssetName, getDragAssetPreview } from "../lib/dragPayload";
import { localClassification, projectClassification } from "../lib/localClassification";
import { LibraryDropPreview } from "./LibraryDropPreview";
import { userErrorMessage } from "../lib/userError";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { catalogCache } from "../lib/catalogCache";
import { openCatalogMenu } from "../lib/openCatalogMenu";
import { hasPendingOriginalDeletions, isPendingOriginal, usePendingOriginalDeletion } from "../lib/pendingOriginalDeletion";
import { invalidateCatalog, useCatalogRevision } from "../lib/useCatalogRevision";
import { Settings2 } from "lucide-react";
import { materialCatalog, type CatalogKind, type MaterialCatalog, type CatalogFilter } from "../lib/materialCatalog";
import { catalogInitial, orderCatalogTags, UNTAGGED_SECTION } from "../lib/materialCatalogOrder";
import { type LibraryMedia } from "../lib/localFileMode";
import { api } from "../lib/api";
import { VirtualCatalog, type CatalogLocation } from "./VirtualCatalog";
import type { CatalogSectionInfo } from "../lib/catalogVirtualLayout";
import { useThumbnailPinch } from "../lib/useThumbnailPinch";
import { addMaterialAssets } from "../lib/materialActions";
import { selectCatalogItem } from "../lib/catalogSelection";
import { externalFiles } from "../lib/externalFiles";
import { notifyError, notifySuccess } from "../lib/notify";
import { useStore } from "../store";
import type { Asset, Project } from "../lib/types";
import { useLibraryGlass } from "./useLibraryGlass";
import { CatalogSelectionBar } from "./CatalogSelectionBar";
import { LibraryCatalogControls } from "./LibraryCatalogControls";
import { LibrarySemanticSearch, emptySemanticResultMessage, useLibrarySemanticSearch } from "./LibrarySemanticSearch";
import { LibraryMotion } from "./LibraryMotion";
import { LibraryTacticalBackdrop } from "./LibraryTacticalBackdrop";
import { OverlayScrollArea } from "./CollectionScrollArea";
import { ThumbnailSizeSlider } from "./ThumbnailSizeSlider";
import { LibraryVideoPreview } from "./LibraryVideoPreview";
import { VideoTranscriptBatchButton } from "./VideoTranscriptBatch";
import { videoSourceKey } from "../lib/videoSourceKey";
import { isVideoAsset } from "../lib/videoGeneration";
import { isAudioAsset } from "../lib/audioMedia";
import { isTextAsset } from "../lib/textMedia";
import { LocalClassificationDialog } from "./LocalClassificationDialog";
import { LocalFileBrowser } from "./LocalFileBrowser";
import { CollectionAssignDialog, CollectionMoveDialog } from "./CollectionDialogs";
import { ModalShell } from "./ModalShell";
import { CatalogTagIndex } from "./CatalogTagIndex";
import "./CategorizedLibrary.css";

const browsePositions = new Map<string, LibraryBrowsePosition>();

export function CategorizedLibrary({ kind, media = "images", projectId = null, browseProjectId = projectId, projectScope = false, overviewProjects, sidebarBody, onClose, onNavigate, onCreateProject, onAssetsChange, onInsertAsset, onOpenAsset, onAssetContextMenu, positionId = "default", toolbarActions, dropPreview = false, semanticSearchEnabled = false }: {
  kind: Exclude<CatalogKind, "collections">; projectId?: string | null; browseProjectId?: string | null; projectScope?: boolean; onClose: () => void; onNavigate?: () => void; onCreateProject?: (ids?: string[]) => Promise<unknown>;
  overviewProjects?: Project[]; sidebarBody?: HTMLElement | null;
  media?: LibraryMedia; positionId?: string;
  toolbarActions?: ReactNode; dropPreview?: boolean; semanticSearchEnabled?: boolean;
  onAssetsChange?: (assets: Asset[]) => void;
  onInsertAsset?: (asset: Asset) => void; onOpenAsset?: (asset: Pick<Asset, "id">) => void;
  onAssetContextMenu?: ReturnType<typeof useStore.getState>["openContextMenu"];
}) {
  const useLocalFileMode = useLibraryModeStore();
  const pane = useLibraryPane();
  const root = useRef<HTMLElement>(null);
  const glass = useLibraryGlass();
  const positions = pane?.positions ?? browsePositions;
  const catalogProjectId = projectScope ? browseProjectId : null;
  const projectOverview = !!overviewProjects;
  const positionKey = JSON.stringify([pane ? "pane" : positionId, projectId, browseProjectId, projectScope, media, kind]);
  const [savedPosition] = useState(() => positions.get(positionKey));
  const flow = kind === "all";
  const [catalog, setCatalog] = useState<MaterialCatalog>({ tags: [], collections: [], prompts: [], tag_asset_ids: {} });
  const [active, setActive] = useState<string | null>(savedPosition?.active ?? null);
  const [total, setTotal] = useState(0);
  const [projectCounts, setProjectCounts] = useState<Record<string, number>>({});
  const [untagged, setUntagged] = useState(0);
  const [catalogError, setCatalogError] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(true);
  const loadedCatalogScope = useRef<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const pendingDeletion = usePendingOriginalDeletion();
  const [multiple, setMultiple] = useState(false);
  const alphabetic = true;
  const [assign, setAssign] = useState<string[] | null>(null);
  const [moveIds, setMoveIds] = useState<string[] | null>(null);
  const [manageTags, setManageTags] = useState(false);
  const [references, setReferences] = useState(false);
  const [preview, setPreview] = useState<{ asset: Asset; path: string; sourceKey: string } | null>(null);
  const [working, setWorking] = useState(false);
  const [color, setColor] = useState<string | null>(savedPosition?.color ?? null);
  const revision = useCatalogRevision(media === "images" && !!color);
  const lock = useRef(false);
  const anchor = useRef<CatalogLocation | null>(null);
  const selectionVersion = useRef(0);
  const shownGroupAssets = useRef(new Map<string, string>());
  const onBrowseGroup = useCallback((head: string, shown: string | null) => { if (shown) shownGroupAssets.current.set(head, shown); else shownGroupAssets.current.delete(head); }, []);
  const alive = useRef(true);
  const previewVersion = useRef(0);
  const [jump, setJump] = useState<{ id: string; sequence: number } | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const query = useLocalFileMode(s => s.query.trim());
  const searching = !!query;
  const flat = flow || searching;
  const searchReturn = useRef<LibraryBrowsePosition>();
  useLayoutEffect(() => {
    if (searching) searchReturn.current ??= positions.get(positionKey);
  }, [searching, positions, positionKey]);
  const generatedFilter = useLocalFileMode(s => s.generatedFilter);
  const [dragItem, setDragItem] = useState({ name: "", preview: null as string | null, count: 0 });
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const { ids: pinnedTags, toggle: togglePin } = useLibraryPins();
  const { width } = useLibraryThumbnail("library");
  const pinch = useThumbnailPinch("library");
  const tags = useMemo(() => orderCatalogTags(catalog.tags, [], false, pinnedTags), [catalog, pinnedTags]);
  const filter = useMemo<CatalogFilter>(() => ({ kind: flat ? "all" : "tags", id: null, projectId: projectScope ? browseProjectId : null, media,
    query, generated: (media === "all" || media === "images" || media === "videos") && generatedFilter ? generatedFilter === "source:generated" : null, color: media === "images" ? color : null }), [flat, projectScope, browseProjectId, media, query, generatedFilter, color]);
  const filterKey = JSON.stringify([filter, projectOverview]);
  const semanticPaneInstance = useId();
  const browseBeforeSearch = useRef<{ key: string; top: number } | null>(null);
  const semantic = useLibrarySemanticSearch({ paneId: `${pane?.id ?? positionId}:${semanticPaneInstance}`, filter, revision,
    enabled: semanticSearchEnabled && flow && (media === "all" || media === "images") && (!projectScope || !!browseProjectId),
    onResults: () => { if (browseBeforeSearch.current?.key !== filterKey) browseBeforeSearch.current = { key: filterKey, top: scroll.current?.scrollTop ?? 0 }; } });
  const session = semantic.result?.session;
  const sessionId = session?.sessionId;
  const galleryTotal = projectOverview ? overviewProjects.reduce((sum, project) => sum + (projectCounts[project.id] ?? 0), 0) : session?.resultCount ?? total;
  const galleryKey = sessionId ? `${filterKey}:${sessionId}` : filterKey;
  const galleryKeyRef = useRef(galleryKey); galleryKeyRef.current = galleryKey;
  const loadedMenuAssets = useRef<{ key: string; assets: Map<string, Asset> }>();
  const catalogAssetsChanged = useCallback((assets: Asset[]) => {
    loadedMenuAssets.current = { key: galleryKey, assets: new Map(assets.map(asset => [asset.id, asset])) };
    onAssetsChange?.(assets);
  }, [galleryKey, onAssetsChange]);
  const scopedProjectName = useStore(state => projectScope ? state.projects.find(project => project.id === browseProjectId)?.name : null);
  const reading = !session && catalogLoading;
  const colorsPrepared = invalidateCatalog;
  const returnPosition = searchReturn.current ?? savedPosition;
  const galleryReady = loadedCatalogScope.current === filterKey;
  useLayoutEffect(() => {
    if (!searching && galleryReady) searchReturn.current = undefined;
  });
  const sections = useMemo<CatalogSectionInfo[]>(() => overviewProjects
    ? overviewProjects.map(project => ({ id: project.id, name: project.name, count: projectCounts[project.id] ?? 0, tagId: null, projectId: project.id }))
    : flat ? [{ id: "all", name: "", count: galleryTotal, tagId: null }]
    : [...tags.map(tag => ({ id: tag.id, name: tag.name, count: tag.count, tagId: tag.id })),
      ...(untagged ? [{ id: UNTAGGED_SECTION, name: "未分类", count: untagged, tagId: UNTAGGED_SECTION }] : [])], [overviewProjects, projectCounts, flat, galleryTotal, tags, untagged]);
  const onActive = useCallback((id: string | null) => { if (!flat) setActive(id); }, [flat]);
  const position = useRef({ active, alphabetic, color, query, generatedFilter });
  position.current = { active, alphabetic, color, query, generatedFilter };
  useLayoutEffect(() => {
    if (sessionId || searching) return;
    const view = scroll.current;
    const save = () => positions.set(positionKey, { ...position.current, top: browseBeforeSearch.current?.key === filterKey ? browseBeforeSearch.current.top : view?.scrollTop ?? 0 });
    view?.addEventListener("scroll", save, { passive: true });
    return () => view?.removeEventListener("scroll", save);
  }, [positionKey, positions, sessionId, filterKey, searching]);
  useLayoutEffect(() => {
    if (!sessionId && !searching && loadedCatalogScope.current === filterKey) positions.set(positionKey, { ...position.current, top: browseBeforeSearch.current?.key === filterKey ? browseBeforeSearch.current.top : scroll.current?.scrollTop ?? 0 });
  }, [positions, positionKey, active, alphabetic, color, query, generatedFilter, sessionId, filterKey, searching, catalogLoading]);
  function navigateTag(id: string) { setActive(id); setJump(previous => ({ id, sequence: (previous?.sequence ?? 0) + 1 })); }
  function navigateLetter(letter: string) {
    const target = tags.find(tag => !pinnedTags.includes(tag.id) && catalogInitial(tag.name) === letter)
      ?? tags.find(tag => catalogInitial(tag.name) === letter);
    if (target) navigateTag(target.id);
  }
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; previewVersion.current++; };
  }, []);
  useLayoutEffect(() => {
    let current = true; setCatalogError("");
    const key = `overview:${filterKey}`;
    if (projectOverview) {
      const apply = (value: Record<string, number>) => {
        loadedCatalogScope.current = filterKey;
        setProjectCounts(value); setCatalogLoading(false);
      };
      const cached = catalogCache.peek<Record<string, number>>(key);
      if (cached) apply(cached.value);
      else if (loadedCatalogScope.current !== filterKey) setCatalogLoading(true);
      void catalogCache.read(key, () => materialCatalog.projectCounts(filter), !!filter.color).then(value => {
        if (current && revision === catalogCache.revision(!!filter.color)) apply(value);
      }).catch(error => { if (current) { setCatalogError(String(error)); setCatalogLoading(false); } });
      return () => { current = false; };
    }
    const apply = (value: Awaited<ReturnType<typeof materialCatalog.overview>>) => {
      loadedCatalogScope.current = filterKey;
      setCatalog(value.catalog); setTotal(value.total); setUntagged(value.untagged);
      setCatalogLoading(false);
    };
    const cached = catalogCache.peek<Awaited<ReturnType<typeof materialCatalog.overview>>>(key);
    if (cached) apply(cached.value);
    else if (loadedCatalogScope.current !== filterKey) setCatalogLoading(true);
    void catalogCache.read(key, () => materialCatalog.overview(filter, catalogProjectId), !!filter.color).then(value => {
      if (current && revision === catalogCache.revision(!!filter.color)) apply(value);
    }).catch(error => { if (current) setCatalogError(String(error)); }).finally(() => { if (current) setCatalogLoading(false); });
    return () => { current = false; };
  }, [filterKey, revision]);
  useEffect(() => {
    setSelected(new Set()); setMultiple(false); anchor.current = null; previewVersion.current++; setPreview(null); setJump(null);
    useStore.getState().closeContextMenu();
    selectionVersion.current++;
    if (!sessionId) {
      browseBeforeSearch.current = null;
    }
  }, [galleryKey, filterKey, sessionId]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "a" || libraryHasOverlay(root.current)) return;
      const target = event.target as HTMLElement | null;
      if (!target || !root.current?.closest(".library-catalog")?.contains(target) || target.closest('input,textarea,select,[role="combobox"],[contenteditable="true"]')) return;
      event.preventDefault(); void selectAll();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [galleryKey, galleryTotal, working, reading, sections]);
  function finishSelection() { selectionVersion.current++; setSelected(new Set()); setMultiple(false); anchor.current = null; }
  async function readIds(queryFilter: CatalogFilter, start: number, count: number) {
    const result: string[] = [], version = selectionVersion.current;
    const pageSize = session ? 60 : 2000;
    const current = () => alive.current && version === selectionVersion.current && galleryKeyRef.current === galleryKey;
    for (let offset = start; offset < start + count; offset += pageSize) {
      if (!current()) return [];
      const limit = Math.min(pageSize, start + count - offset);
      const ids = await (session ? semantic.readIds(session, offset, limit) : materialCatalog.ids(queryFilter, offset, limit));
      if (!current()) return [];
      result.push(...(session ? ids : ids.map(id => shownGroupAssets.current.get(projectOverview ? `${queryFilter.projectId}:${id}` : id) ?? id)));
      if (ids.length < limit) break;
    }
    if (!hasPendingOriginalDeletions()) return result;
    const assets = await resolveSelection(result, true);
    const visible = new Set(assets.map(asset => asset.id));
    return result.filter(id => visible.has(id));
  }
  async function selectAll() {
    if (working || reading || (session && !galleryTotal)) return;
    const version = selectionVersion.current;
    await run(async () => {
      const ids = new Set<string>();
      if (projectOverview) {
        for (const section of sections) {
          if (!alive.current || selectionVersion.current !== version) return;
          for (const id of await readIds({ ...filter, projectId: section.projectId! }, 0, section.count)) ids.add(id);
        }
      } else for (const id of await readIds(filter, 0, galleryTotal)) ids.add(id);
      if (alive.current && selectionVersion.current === version && galleryKeyRef.current === galleryKey) { setSelected(new Set(ids)); setMultiple(true); }
    });
  }
  async function resolveSelection(ids = [...selected], allowPartial = false, isCurrent = () => true) {
    const assets: Asset[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      if (!isCurrent()) return [];
      const rows = await api.getAssetsByIds(ids.slice(i, i + 200));
      assets.push(...rows.filter(asset => !isPendingOriginal(asset.id, asset.store_path)));
    }
    if (!allowPartial && assets.length !== ids.length) throw new Error("部分所选素材已不存在，请重新选择");
    return assets;
  }
  useEffect(() => {
    if (!pendingDeletion.size || !selected.size) return;
    let alive = true;
    void resolveSelection([...selected], true).then(assets => {
      if (!alive || assets.length === selected.size) return;
      selectionVersion.current++;
      setSelected(new Set(assets.map(asset => asset.id)));
      if (!assets.length) setMultiple(false);
    }).catch(() => {});
    return () => { alive = false; };
  }, [selected, pendingDeletion]);
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
            const pageIds = await readIds({ ...filter, id: section.tagId ?? filter.id, projectId: section.projectId ?? filter.projectId }, start, end - start + 1);
            // Range endpoints can be an older image currently shown in a group.
            for (const endpoint of [first, last]) if (endpoint.section === section.id && endpoint.assetId && pageIds.length) pageIds[endpoint.index - start] = endpoint.assetId;
            for (const id of pageIds) ids.push(id);
          }
          if (alive.current && selectionVersion.current === version && galleryKeyRef.current === galleryKey) { setSelected(previous => new Set([...previous, ...ids])); setMultiple(true); }
        });
        return;
      }
    }
    anchor.current = location;
    const next = selectCatalogItem(selected, asset.id, { additive, range, multiple });
    setSelected(next.selected); setMultiple(next.multiple);
  }
  function activate(asset: Asset) {
    if (working) return;
    if (onInsertAsset && isAudioAsset(asset)) { onInsertAsset(asset); return; }
    if (isTextAsset(asset)) { openDetail(asset); return; }
    if (onInsertAsset) { void openPreview(asset); return; }
    const state = useStore.getState();
    if (projectId && (state.activeProjectId !== projectId || !state.canvasLibraryOpen)) return;
    if (state.boardOpen || state.genEditing) {
      window.dispatchEvent(new CustomEvent("bowerbird://board-asset-picked", { detail: asset.id }));
    } else if (isAudioAsset(asset)) openDetail(asset);
    else void openPreview(asset);
  }
  function openDetail(asset: Pick<Asset, "id">) {
    if (working) return;
    previewVersion.current++;
    setPreview(null);
    if (onOpenAsset) onOpenAsset(asset); else useStore.getState().openDetail(asset.id);
  }
  function openAsset(asset: Asset) {
    if (working) return;
    if (onInsertAsset) onInsertAsset(asset);
    else if (isVideoAsset(asset)) activate(asset);
    else openDetail(asset);
  }
  function canShowOverlay() {
    return alive.current && !!root.current?.isConnected && !root.current.closest('[inert], [aria-hidden="true"]');
  }
  async function openPreview(asset: Asset) {
    const version = ++previewVersion.current;
    const routeRevision = useStore.getState().projectRouteRevision;
    const isCurrent = () => canShowOverlay() && version === previewVersion.current && useStore.getState().projectRouteRevision === routeRevision;
    try {
      if (!asset.store_path) throw new Error("素材原文件不可用");
      const path = await externalFiles.media(asset.store_path);
      if (isCurrent()) setPreview({ asset, path, sourceKey: videoSourceKey(asset)! });
    } catch (error) { if (isCurrent()) notifyError(error, "无法预览素材"); }
  }
  function context(asset: Asset, x: number, y: number, location: CatalogLocation) {
    const ids = selected.has(asset.id) ? [...selected] : [asset.id];
    openCatalogMenu({
      ids, hit: asset, cached: loadedMenuAssets.current?.key === galleryKey ? loadedMenuAssets.current.assets : undefined, keyOf: target => target.id,
      visible: target => !isPendingOriginal(target.id, target.store_path),
      lookup: (missing, current) => resolveSelection(missing, true, current),
      inScope: () => canShowOverlay() && galleryKeyRef.current === galleryKey && revision === catalogCache.revision(!!filter.color),
      present(targets) {
        const open = onAssetContextMenu ?? useStore.getState().openContextMenu;
        if (targets.length !== ids.length) {
          open(x, y, asset.id, { asset, moveIncompleteSelection: () => setMoveIds(ids) });
          return;
        }
        open(x, y, asset.id, { asset, generationGroup: !session && [...shownGroupAssets.current.values()].includes(asset.id) ? { assetId: asset.id } : undefined, libraryProjectId: projectOverview ? location.section : browseProjectId ?? undefined, fileSelection: { assets: targets, openReferences: () => setReferences(true),
          onComplete: finishSelection, select: () => { anchor.current = location; setMultiple(true); setSelected(previous => new Set([...previous, asset.id])); } } });
      },
      failed: reason => notifyError(reason, "操作失败"),
    });
  }
  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setWorking(true);
    try { await action(); }
    catch (error) { notifyError(error, "操作失败"); }
    finally { lock.current = false; if (alive.current) setWorking(false); }
  }
  useEffect(() => {
    const clear = () => setDropTarget(null);
    window.addEventListener("dragend", clear); window.addEventListener("drop", clear);
    return () => { window.removeEventListener("dragend", clear); window.removeEventListener("drop", clear); };
  }, []);
  const dropName = catalog.tags.find(tag => tag.id === dropTarget)?.name;
  function dropDestination(target: EventTarget) {
    const element = (target as HTMLElement).closest<HTMLElement>('[data-tag-id], [data-tag-section]');
    const id = element?.dataset.tagId ?? element?.dataset.tagSection;
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
        await (projectScope && browseProjectId ? projectClassification(browseProjectId) : localClassification).example(id, [...new Set(ids)], true);
        if (alive.current) invalidateCatalog();
        notifySuccess("已添加手动分类");
      });
    }} data-creation-pick-disabled={multiple || working} data-drop-target={dropTarget ?? undefined} data-file-import-project-id={projectScope ? browseProjectId ?? "" : ""}
      data-catalog-searching={searching || undefined}
      className={`categorized-library library-tactical${!flat ? " is-tag-catalog" : ""}`} aria-label={flat ? media === "videos" ? "平铺浏览视频" : "平铺浏览全部图片" : "按标签浏览素材"}
    style={glass.style as CSSProperties}>
    {dropPreview && dropTarget && dropName && <LibraryDropPreview {...dragItem} target={dropName} collection={false}/>}
    {glass.definition}
    <LibraryMotion />
    <div className="file-view-heading">
      {selected.size > 0 || multiple ? <CatalogSelectionBar count={selected.size} busy={working} projectId={projectId} onFinish={finishSelection}
        onSelectAll={() => void selectAll()} onAssign={() => setAssign([...selected])} onMove={() => setMoveIds([...selected])}
        onAdd={media !== "audios" ? () => void run(async () => { const key = galleryKey; const assets = await resolveSelection(); if (!alive.current || galleryKeyRef.current !== key) return; await addMaterialAssets(assets, projectId, onNavigate ?? onClose, onCreateProject); finishSelection(); notifySuccess(projectId ? "已添加到画板" : "已添加到新项目素材库"); }) : undefined}/>
      :
      <div className="video-collection-controls">
      <LibraryCatalogControls filter={filter} onColorChange={setColor} onColorsPrepared={colorsPrepared} onSearchStart={() => {
        if (galleryReady) searchReturn.current = { ...position.current, top: scroll.current?.scrollTop ?? 0 };
      }} onStartSelection={() => { setMultiple(true); requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>(".catalog-selection button")?.focus()); }}>{toolbarActions}
        {flow && media === "videos" && (!projectScope || browseProjectId) && <VideoTranscriptBatchButton scope={{ projectId: projectScope ? browseProjectId : null, label: projectScope ? `项目内视频${scopedProjectName ? ` · ${scopedProjectName}` : ""}` : "全部视频" }}/>}
        {semantic.scope && <LibrarySemanticSearch key={semantic.scope} owner={root} search={semantic}
          scopeLabel={projectScope ? `项目素材${scopedProjectName ? ` / ${scopedProjectName}` : ""}` : "全部素材"}/>}
      </LibraryCatalogControls>
      </div>}
    </div>
    <div className="catalog-body">
      {!flow && sidebarBody && createPortal(<>
        <div className="catalog-sidebar-heading"><span>拼音 A–Z</span>
          <button title="管理标签" aria-label="管理标签" onClick={() => setManageTags(true)}><Settings2 size={15}/></button></div>
        {catalogError && <p className="catalog-error" role="alert">{userErrorMessage(catalogError, "素材列表暂时无法读取，请重试。")}<button onClick={() => invalidateCatalog()}>重试</button></p>}
        <CatalogTagIndex tags={tags} active={active} dropTarget={dropTarget} alphabetic pinned={pinnedTags} onTogglePin={id => { togglePin(id); setJump(null); if (scroll.current) scroll.current.scrollTop = 0; }} onNavigate={navigateTag} onLetter={navigateLetter}/>
      </>, sidebarBody)}
      <div ref={pinch} className="catalog-gallery">
        <LibraryTacticalBackdrop />
        {flat && !session && catalogError && <p className="catalog-error" role="alert">{userErrorMessage(catalogError, "素材列表暂时无法读取，请重试。")}<button onClick={() => invalidateCatalog()}>重试</button></p>}
        <OverlayScrollArea scrollRef={scroll} className="catalog-scroll" viewportClassName="catalog-scroller library-scroller" viewportStyle={{ paddingBottom: 0, overflowAnchor: "none" }}>
          {reading ? <p className="catalog-hint catalog-empty" role="status">正在读取素材…</p> : !galleryTotal && (session || !catalogError) ? <p className="catalog-hint catalog-empty">{session ? emptySemanticResultMessage(session) : query || color || generatedFilter ? "没有匹配的素材。" : "还没有已登记的素材。"}</p> : null}
          {(session || galleryReady) && <VirtualCatalog key={galleryKey} filter={filter} sections={sections} headings={projectOverview || !flat} width={width} revision={revision} scroll={scroll}
            selected={selected} jump={flat ? null : jump} pageScope={projectOverview ? "projects" : sessionId} emptySection={projectOverview || !flat ? () => null : undefined} readPage={session ? (_section, offset, limit) => semantic.readPage(session, offset, limit) : undefined}
            initialTop={session ? 0 : browseBeforeSearch.current?.key === filterKey ? browseBeforeSearch.current.top : returnPosition?.query === query && returnPosition?.color === color && returnPosition?.generatedFilter === generatedFilter ? returnPosition.top : 0}
            onActive={onActive} onAssetsChange={catalogAssetsChanged} onBrowseGroup={onBrowseGroup} onSelect={select} onActivate={multiple || working ? undefined : activate} onOpen={openAsset} onContextMenu={context}/>}
        </OverlayScrollArea>
        <ThumbnailSizeSlider scope="library"/>
      </div>
    </div>
    {preview && <LibraryVideoPreview {...preview} projectId={projectId} onClose={() => setPreview(null)}/>}
    {manageTags && <LocalClassificationDialog initialView="labels" projectId={projectScope ? browseProjectId ?? undefined : undefined} onClose={() => { setManageTags(false); invalidateCatalog(); }}/>}
    {references && <ModalShell title="外部引用" width="lg" onClose={() => setReferences(false)}><LocalFileBrowser initialTab="references" onClose={() => setReferences(false)} onCreateProject={() => void onCreateProject?.()}/></ModalShell>}
    {assign && <CollectionAssignDialog assetIds={assign} onClose={() => setAssign(null)} onSaved={() => { finishSelection(); invalidateCatalog(); }}/>}
    {moveIds && <CollectionMoveDialog selection={{ assetIds: moveIds }} onClose={() => setMoveIds(null)} onSaved={finishSelection}/>}
  </section>;
}
