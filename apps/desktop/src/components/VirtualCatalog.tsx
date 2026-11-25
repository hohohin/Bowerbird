import { userErrorMessage } from "../lib/userError";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject, type ReactNode, type CSSProperties } from "react";
import { materialCatalog, type CatalogFilter } from "../lib/materialCatalog";
import { catalogLayout, catalogScrollScale, masonryGeometry, masonryRatios, visibleCatalogBlocks, CATALOG_CACHE_PAGES, CATALOG_GAP, CATALOG_PAGE_SIZE, type CatalogSectionInfo, type CatalogPlacementCache } from "../lib/catalogVirtualLayout";
import type { Asset } from "../lib/types";
import { api } from "../lib/api";
import { CatalogAssetCard } from "./CatalogAssetCard";
import { catalogCache, patchCatalogPage, type CatalogFolderScope, type CatalogPreviewChange } from "../lib/catalogCache";
import { subscribeCatalogPreviews } from "../lib/useCatalogRevision";
import { originalDeletionEpoch, originalDeletionFor, usePendingOriginalDeletion } from "../lib/pendingOriginalDeletion";

export interface CatalogLocation { section: string; index: number; assetId?: string }
export interface CatalogJump { id: string }
type PageSection = CatalogSectionInfo & { collection?: CatalogFolderScope & { available: boolean } };
type Page = { assets: Asset[]; groups: Record<string, Asset[]>; revision: number; deletionEpoch: number };
type EntryAsset = Asset & { connectionGroup?: EntryAsset[] };
function visiblePage(page: Page, hasPending: boolean): Page & { sourceIndices?: number[] } {
  if (!hasPending && page.deletionEpoch === originalDeletionEpoch()) return page;
  const visible = (asset: Asset) => !originalDeletionFor(asset.id, asset.store_path, page.deletionEpoch);
  const groups: Page["groups"] = {};
  const assets: Asset[] = [];
  const sourceIndices: number[] = [];
  for (const [index, head] of (page.assets as EntryAsset[]).entries()) {
    const group = head.connectionGroup ?? page.groups[head.id];
    if (!group?.length) {
      if (visible(head)) { assets.push(head); sourceIndices.push(index); }
      continue;
    }
    const remaining = group.filter(visible);
    if (!remaining.length) continue;
    sourceIndices.push(index);
    const representative = visible(head) ? head : remaining[remaining.length - 1];
    if (head.connectionGroup) assets.push({ ...representative, connectionGroup: remaining } as EntryAsset);
    else { assets.push(representative); groups[representative.id] = remaining; }
  }
  return { ...page, assets, groups, sourceIndices };
}
// Keep only visited pages' ratios after asset eviction/view switches. A page's
// total height alone cannot continue uneven columns or adapt to a new width.
const layoutHistory = new Map<string, Map<string, readonly number[]>>();
const assetKey = (asset: Asset) => asset.id;
export function VirtualCatalog({ filter, sections, headings, width: thumbnailWidth, compact = false, revision, scroll, selected, jump, onJumped, initialTop, onActive, onAssetsChange, onBrowseGroup, onSelect, onActivate, onOpen, onContextMenu, readPage, pageScope, browseScope, itemKey = assetKey, renderItem, emptySection }: {
  filter: CatalogFilter; sections: PageSection[]; headings: boolean; width: number; compact?: boolean; revision: number;
  scroll: RefObject<HTMLDivElement>; selected: Set<string>; jump: CatalogJump | null; onJumped?: (jump: CatalogJump) => void; initialTop?: number;
  onActive: (id: string | null) => void; onAssetsChange?: (assets: Asset[]) => void;
  onBrowseGroup?: (head: string, shown: string | null) => void;
  onSelect: (asset: Asset, additive: boolean, range: boolean, location: CatalogLocation) => void;
  onActivate?: (asset: Asset, location: CatalogLocation) => void; onOpen: (asset: Asset, location: CatalogLocation) => void;
  onContextMenu: (asset: Asset, x: number, y: number, location: CatalogLocation) => void;
  readPage?: (sectionId: string, offset: number, limit: number) => Promise<Asset[]>;
  pageScope?: string; browseScope?: string | null;
  itemKey?: (asset: Asset) => string;
  renderItem?: (asset: Asset, style: CSSProperties, ratio: number, location: CatalogLocation, pageRevision: number) => ReactNode;
  emptySection?: (sectionId: string) => ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const pendingDeletion = usePendingOriginalDeletion();
  const colorFiltered = !!filter.color;
  const [viewport, setViewport] = useState(() => ({ top: initialTop ?? 0, height: scroll.current?.clientHeight || 800, width: scroll.current?.clientWidth || 800 }));
  const columns = viewport.width >= 340 ? 3 : 2;
  const width = compact ? Math.max(96, Math.floor((viewport.width - 16 + CATALOG_GAP) / columns) - CATALOG_GAP) : thumbnailWidth;
  const [tick, setTick] = useState(0);
  const geometryKey = JSON.stringify(pageScope ? [filter, pageScope] : filter);
  const pagePrefix = `pages:${geometryKey}:`;
  const [pages] = useState(() => new Map(catalogCache.entries<Omit<Page, "revision">>(pagePrefix)
    .slice(-CATALOG_CACHE_PAGES).map(([key, entry]) => [key.slice(pagePrefix.length), { ...entry.value, revision: entry.revision }])));
  const cache = useRef(pages);
  const [geometryRevision, setGeometryRevision] = useState(0);
  const placements = useRef<CatalogPlacementCache>(new Map());
  const measured = useRef(new Map<string, readonly number[]>());
  const errors = useRef(new Map<string, { revision: number; message: string }>());
  const pending = useRef(new Set<string>());
  const alive = useRef(true);
  const version = useRef(revision); version.current = revision;
  const anchor = useRef<{ key: string; delta: number; asset?: { id: string; delta: number } } | { section: string; delta: number } | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const oldGeometry = useRef("");
  const activeScope = useRef(browseScope);
  const changingScope = activeScope.current !== browseScope;
  const sectionsRef = useRef(sections); sectionsRef.current = sections;
  const showEmpty = !!emptySection;
  if (oldGeometry.current !== geometryKey) {
    measured.current = layoutHistory.get(geometryKey) ?? new Map();
    layoutHistory.delete(geometryKey); layoutHistory.set(geometryKey, measured.current);
    if (layoutHistory.size > 16) layoutHistory.delete(layoutHistory.keys().next().value!);
    placements.current.clear();
    for (const [key, page] of cache.current) measured.current.set(key, masonryRatios(page.assets));
    oldGeometry.current = geometryKey;
  }
  const layout = useMemo(() => {
    const layout = catalogLayout(sections, viewport.width, width, measured.current, headings, placements.current);
    if (showEmpty) {
      let extra = 0;
      const offsets: number[] = [];
      layout.groups.forEach((group, index) => {
        offsets[index] = extra;
        group.top += extra;
        if (!sections[index].count) { extra += 40 - group.height; group.height = 40; }
      });
      for (const block of layout.blocks) { block.top += offsets[block.section]; block.maxBottom += offsets[block.section]; }
      layout.height += extra;
    }
    const last = layout.groups[layout.groups.length - 1];
    if (headings && last) {
      // Leave scroll room for the final collection without stretching its empty row.
      if (!showEmpty || sections[sections.length - 1].count) last.height = Math.max(last.height, viewport.height);
      layout.height = last.top + Math.max(last.height, viewport.height);
    }
    return layout;
  }, [sections, viewport.width, viewport.height, width, headings, geometryRevision, geometryKey, showEmpty]);
  const layoutRef = useRef(layout); layoutRef.current = layout;
  const scale = catalogScrollScale(layout.height + 100, viewport.height);
  const top = changingScope ? initialTop ?? 0 : viewport.top;
  const logicalTop = top / scale;
  const visible = visibleCatalogBlocks(layout.blocks, logicalTop, viewport.height);
  const focusBlock = !changingScope && focused ? layout.blocks.find(block => block.key === focused) : undefined;
  if (focusBlock && !visible.some(block => block.key === focused)) visible.push(focusBlock);
  const wanted = useRef(visible); wanted.current = visible;
  const pump = useRef<() => void>(() => {});
  const applyPreviews = useRef<(change: CatalogPreviewChange) => void>(() => {});
  function rememberAnchor() {
    const view = scroll.current;
    if (!view || anchor.current) return;
    const top = view.scrollTop / catalogScrollScale(layoutRef.current.height + 100, view.clientHeight);
    const currentSections = sectionsRef.current;
    const emptyIndex = showEmpty ? layoutRef.current.groups.findIndex((group, index) => !currentSections[index].count && group.top <= top + 1 && group.top + group.height > top) : -1;
    if (emptyIndex >= 0) {
      anchor.current = { section: currentSections[emptyIndex].id, delta: top - layoutRef.current.groups[emptyIndex].top };
      return;
    }
    const visible = visibleCatalogBlocks(layoutRef.current.blocks, top, view.clientHeight, 0);
    let distance = Infinity;
    // Overlapping pages can include a much earlier portrait. Anchor the nearest
    // visible card, so replacing estimates does not move the user's current row.
    for (const block of visible) {
      const page = cache.current.get(block.key);
      if (!page) continue;
      const geometry = masonryGeometry(page.assets, viewport.width, width, block.columnTops);
      geometry.cells.forEach((cell, index) => {
        const y = block.top + cell.top;
        if (y + cell.height < top || y > top + view.clientHeight || Math.abs(y - top) >= distance) return;
        distance = Math.abs(y - top);
        anchor.current = { key: block.key, delta: top - block.top, asset: { id: itemKey(page.assets[index]), delta: top - y } };
      });
    }
    if (anchor.current) return;
    const intersecting = visibleCatalogBlocks(layoutRef.current.blocks, top, 1, 0);
    const block = intersecting[intersecting.length - 1];
    if (block) anchor.current = { key: block.key, delta: top - block.top };
  }
  function measurePage(key: string, assets: Asset[]) {
    const next = masonryRatios(assets);
    const before = measured.current.get(key);
    // Missing entries have always used square estimates.
    if (before?.length === next.length && next.every((ratio, i) => ratio === before[i])) return;
    if (!before && next.every(ratio => ratio === 1)) return;
    rememberAnchor();
    measured.current.set(key, next);
    setGeometryRevision(value => value + 1);
  }
  applyPreviews.current = change => {
    let changed = false;
    for (const [key, page] of cache.current) {
      const next = patchCatalogPage(page, change);
      if (next !== page) { measurePage(key, next.assets); cache.current.set(key, next); changed = true; }
    }
    if (changed) setTick(value => value + 1);
  };
  useEffect(() => subscribeCatalogPreviews(change => applyPreviews.current(change)), []);
  pump.current = () => {
    if (!alive.current) return;
    for (const block of wanted.current) {
      if (pending.current.size >= 3) break;
      const section = sections[block.section];
      const scope = section.collection;
      const requestedRevision = catalogCache.revision(colorFiltered, scope);
      if (!scope && version.current !== requestedRevision) continue;
      if (pending.current.has(block.key) || errors.current.get(block.key)?.revision === requestedRevision || cache.current.get(block.key)?.revision === requestedRevision) continue;
      pending.current.add(block.key);
      const isCurrent = () => alive.current && (!!scope || version.current === requestedRevision) && catalogCache.revision(colorFiltered, scope) === requestedRevision;
      const pageFilter = { ...filter, id: section.tagId ?? filter.id, projectId: section.projectId ?? filter.projectId };
      void catalogCache.read(`${pagePrefix}${block.key}`, async () => {
        const deletionEpoch = originalDeletionEpoch();
        const assets = await (readPage ? readPage(section.id, block.offset, CATALOG_PAGE_SIZE) : materialCatalog.page(pageFilter, block.offset, CATALOG_PAGE_SIZE));
        const ids = readPage ? [] : assets.map(asset => asset.id);
        const groups = ids.length ? await api.listGenerationGroups(ids, pageFilter.projectId, pageFilter) ?? {} : {};
        return { assets, groups, deletionEpoch };
      }, colorFiltered, scope).then(page => {
        if (!isCurrent()) return;
        measurePage(block.key, page.assets);
        errors.current.delete(block.key);
        cache.current.delete(block.key); cache.current.set(block.key, { ...page, revision: requestedRevision });
        const keep = new Set(wanted.current.map(item => item.key));
        for (const key of cache.current.keys()) {
          if (cache.current.size <= CATALOG_CACHE_PAGES) break;
          if (!keep.has(key)) cache.current.delete(key);
        }
        setTick(v => v + 1);
      }).catch(error => {
        if (isCurrent()) { errors.current.set(block.key, { revision: requestedRevision, message: String(error) }); setTick(v => v + 1); }
      }).finally(() => { pending.current.delete(block.key); pump.current(); });
    }
  };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const wantedKey = visible.map(block => block.key).join("|");
  useEffect(() => { pump.current(); }, [wantedKey, revision, tick]);
  useEffect(() => {
    if (!onAssetsChange) return;
    const ids = new Set(sections.map(section => section.id));
    const pages = [...cache.current].filter(([key]) => ids.has(key.slice(0, key.lastIndexOf(":"))))
      .map(([, page]) => visiblePage(page, pendingDeletion.size > 0));
    onAssetsChange([...new Map(pages.flatMap(page => [...page.assets, ...Object.values(page.groups).flat()]).map(asset => [itemKey(asset), asset])).values()]);
  }, [tick, pendingDeletion, onAssetsChange, itemKey, sections]);
  useEffect(() => () => onAssetsChange?.([]), [onAssetsChange]);
  useLayoutEffect(() => {
    const view = scroll.current;
    if (!view) return;
    let frame = 0;
    const update = () => { frame = 0; setViewport({ top: view.scrollTop, height: view.clientHeight, width: view.clientWidth }); };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule); observer.observe(view);
    const wheel = (event: WheelEvent) => {
      const scale = catalogScrollScale(layoutRef.current.height + 100, view.clientHeight);
      if (scale === 1 || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? view.clientHeight : 1;
      view.scrollTop += event.deltaY * unit * scale;
    };
    view.addEventListener("wheel", wheel, { passive: false });
    view.addEventListener("scroll", schedule); update();
    return () => { observer.disconnect(); view.removeEventListener("scroll", schedule); view.removeEventListener("wheel", wheel); cancelAnimationFrame(frame); };
  }, [scroll]);
  useLayoutEffect(() => {
    if (changingScope) { anchor.current = null; return; }
    if (anchor.current && scroll.current) {
      const saved = anchor.current;
      if ("section" in saved) {
        const group = layout.groups[sections.findIndex(section => section.id === saved.section)];
        if (group) {
          scroll.current.scrollTop = (group.top + saved.delta) * scale;
          const scrollTop = scroll.current.scrollTop;
          setViewport(current => current.top === scrollTop ? current : { ...current, top: scrollTop });
        }
        anchor.current = null;
        return;
      }
      const block = layout.blocks.find(item => item.key === saved.key);
      if (block) {
        const page = cache.current.get(block.key);
        const index = saved.asset && page ? page.assets.findIndex(asset => itemKey(asset) === saved.asset!.id) : -1;
        const cell = index >= 0 ? masonryGeometry(page!.assets, viewport.width, width, block.columnTops).cells[index] : null;
        const top = cell ? block.top + cell.top + saved.asset!.delta : block.top + Math.min(saved.delta, Math.max(0, block.height - 1));
        scroll.current.scrollTop = top * scale;
        const scrollTop = scroll.current.scrollTop;
        setViewport(current => current.top === scrollTop ? current : { ...current, top: scrollTop });
      }
      anchor.current = null;
    }
  }, [layout, scroll, changingScope]);
  const restored = useRef(false);
  const jumped = useRef<typeof jump>(null);
  useLayoutEffect(() => {
    if (changingScope) {
      activeScope.current = browseScope;
      restored.current = false;
      setFocused(null);
    }
    if (!restored.current && (changingScope || layout.blocks.length) && scroll.current) {
      scroll.current.scrollTop = initialTop ?? 0;
      const top = scroll.current.scrollTop;
      setViewport(previous => previous.top === top ? previous : { ...previous, top });
      restored.current = true;
    }
  }, [layout, initialTop, scroll, browseScope, changingScope]);
  useLayoutEffect(() => {
    const view = scroll.current;
    if (!jump || jumped.current === jump || !view) return;
    const destination = layout.groups[sections.findIndex(section => section.id === jump.id)];
    if (!destination) return;
    jumped.current = jump;
    anchor.current = null;
    view.scrollTop = destination.top * scale;
    const top = view.scrollTop;
    setViewport(current => current.top === top ? current : { ...current, top });
    onJumped?.(jump);
  }, [jump, sections, layout, scale, scroll, onJumped]);
  let current: string | null = headings ? sections[0]?.id ?? null : null;
  if (headings) sections.forEach((section, index) => { if (layout.groups[index].top <= logicalTop + 1) current = section.id; });
  useEffect(() => { onActive(current); }, [current, onActive]);
  return <div ref={root} className={`catalog-sections catalog-virtual${filter.kind === "tags" ? " catalog-tag-sections" : ""}`} aria-label="分类素材" style={{ height: Math.min(layout.height + 100, 8_000_000), position: "relative", overflow: "clip", overflowAnchor: "none" }} data-cached-pages={cache.current.size}>
    {sections.map((section, index) => <section key={section.id} data-catalog-section={section.id}
      data-tag-section={section.tagId ?? undefined} data-tag-name={section.tagId ? section.name : undefined}
      data-file-import-collection-id={section.collection?.id} data-file-import-collection-name={section.collection ? section.name : undefined}
      data-file-import-collection-available={section.collection?.available} className={showEmpty && !section.count ? "is-empty" : undefined}
      aria-label={headings ? `${section.name}${section.tagId && filter.media === "images" ? "图片" : "素材"}` : undefined} style={{ position: "absolute", top: layout.groups[index].top * scale, height: layout.groups[index].height * scale, width: "100%" }}>
      {headings && (current === section.id || visible.some(block => block.section === index) || (showEmpty && !section.count && layout.groups[index].top + layout.groups[index].height >= logicalTop - 500 && layout.groups[index].top <= logicalTop + viewport.height + 500)) && <h3 style={{ position: "absolute", width: "100%", top: Math.min(Math.max(layout.groups[index].top, logicalTop), layout.groups[index].top + layout.groups[index].height - 40) - logicalTop + top - layout.groups[index].top * scale }} className={`catalog-section-heading${current === section.id && top > 0 ? " is-pinned" : ""}`}><span title={section.name} data-library-count={`${String(section.count).padStart(2, "0")} 项`} className={`catalog-section-title${current === section.id && top > 0 ? " library-floating-surface" : ""}`}>{section.name}</span>{!section.count && emptySection && <span className="connected-empty-section">{emptySection(section.id)}</span>}</h3>}
      {visible.filter(block => block.section === index).map(block => {
        const local = cache.current.get(block.key);
        // Paint warm session pages immediately after local eviction. The pump
        // will restore them to the bounded local cache and update measurements.
        const snapshot = local ? undefined : catalogCache.peek<Omit<Page, "revision">>(`${pagePrefix}${block.key}`);
        const raw = snapshot && catalogCache.fresh(snapshot) ? { ...snapshot.value, revision: snapshot.revision } : local;
        const failed = errors.current.get(block.key);
        const error = failed?.revision === catalogCache.revision(colorFiltered, section.collection) ? failed.message : null;
        const page = raw && visiblePage(raw, pendingDeletion.size > 0);
        const geometry = page ? masonryGeometry(page.assets, viewport.width, width, block.columnTops) : null;
        return <div key={block.key} data-catalog-page={block.key} data-columns={geometry?.columns} className="folder-masonry catalog-virtual-page" style={{ position: "absolute", top: block.top - logicalTop + top - layout.groups[index].top * scale, height: block.height, pointerEvents: "none" }}
          onFocusCapture={() => setFocused(block.key)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setFocused(null); }}>
          {error && <p className="catalog-error" role="alert" style={{ position: "relative", zIndex: 1, width: "fit-content", background: "var(--lt-screen)", pointerEvents: "auto" }}>{userErrorMessage(error, "素材列表暂时无法读取，请重试。")}<button onClick={() => { errors.current.delete(block.key); setTick(v => v + 1); }}>重试</button></p>}
          {!page && !error && <p className="catalog-hint" role="status">正在读取素材…</p>}
          {page?.assets.map((asset, index) => {
            const cell = geometry!.cells[index];
            const sourceIndex = page.sourceIndices?.[index] ?? index;
            // Cull inside a page too: tall portraits must not multiply DOM work.
            const y = block.top + cell.top;
            if (y + cell.height < logicalTop - 500 || y > logicalTop + viewport.height + 500) {
              if (focused !== block.key) return null;
            }
            if (renderItem) return renderItem(asset, { width: cell.width, height: cell.height, transform: `translate3d(${cell.left}px,${cell.top}px,0)`, pointerEvents: "auto" }, cell.ratio, { section: section.id, index: block.offset + sourceIndex }, page.revision);
            const locationOf = (shown: Asset): CatalogLocation => ({ section: section.id, index: block.offset + sourceIndex, assetId: shown.id });
            return <CatalogAssetCard key={section.projectId ? `${section.id}:${itemKey(asset)}` : itemKey(asset)} asset={asset} projectSection={section.projectId} group={page.groups[asset.id]} style={{ width: cell.width, height: cell.height, transform: `translate3d(${cell.left}px,${cell.top}px,0)`, pointerEvents: "auto" }}
              ratio={cell.ratio} selected={selected} revision={revision} onBrowseGroup={onBrowseGroup}
              onSelect={(shown, additive, range) => onSelect(shown, additive, range, locationOf(shown))}
              onActivate={onActivate ? shown => onActivate(shown, locationOf(shown)) : undefined}
              onOpen={shown => onOpen(shown, locationOf(shown))} onContextMenu={(shown,x,y) => onContextMenu(shown,x,y,locationOf(shown))}/>;
          })}
        </div>;
      })}
    </section>)}
  </div>;
}
