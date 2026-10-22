import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { materialCatalog, type CatalogFilter } from "../lib/materialCatalog";
import { catalogLayout, catalogScrollScale, masonryGeometry, visibleCatalogBlocks, CATALOG_CACHE_PAGES, CATALOG_PAGE_SIZE, type CatalogSectionInfo } from "../lib/catalogVirtualLayout";
import type { Asset } from "../lib/types";
import { setDragAssets } from "../lib/dragPayload";
import { FileMediaCard } from "./FileMediaCard";

export interface CatalogLocation { section: string; index: number }
type Page = { assets: Asset[]; revision: number };
// Retain only page heights across media/view switches so restoring a scroll
// position doesn't first lay out those pages using square-image estimates.
const layoutHistory = new Map<string, Map<string, number>>();
export function VirtualCatalog({ filter, sections, headings, width, revision, scroll, selected, jump, initialTop, onActive, onAssetsChange, onSelect, onActivate, onOpen, onContextMenu }: {
  filter: CatalogFilter; sections: CatalogSectionInfo[]; headings: boolean; width: number; revision: number;
  scroll: RefObject<HTMLDivElement>; selected: Set<string>; jump: { id: string; sequence: number } | null; initialTop?: number;
  onActive: (id: string | null) => void; onAssetsChange?: (assets: Asset[]) => void;
  onSelect: (asset: Asset, additive: boolean, range: boolean, location: CatalogLocation) => void;
  onActivate?: (asset: Asset) => void; onOpen: (asset: Asset) => void; onContextMenu: (asset: Asset, x: number, y: number) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: initialTop ?? 0, height: scroll.current?.clientHeight || 800, width: scroll.current?.clientWidth || 800 });
  const [tick, setTick] = useState(0);
  const cache = useRef(new Map<string, Page>());
  const measured = useRef(new Map<string, number>());
  const errors = useRef(new Map<string, string>());
  const pending = useRef(new Set<string>());
  const alive = useRef(true);
  const version = useRef(revision); version.current = revision;
  const anchor = useRef<{ key: string; delta: number } | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const geometryKey = JSON.stringify([filter, viewport.width, width]);
  const oldGeometry = useRef("");
  if (oldGeometry.current !== geometryKey) {
    measured.current = layoutHistory.get(geometryKey) ?? new Map();
    layoutHistory.delete(geometryKey); layoutHistory.set(geometryKey, measured.current);
    if (layoutHistory.size > 16) layoutHistory.delete(layoutHistory.keys().next().value!);
    oldGeometry.current = geometryKey;
  }
  const layout = useMemo(() => {
    for (const [key, page] of cache.current) measured.current.set(key, masonryGeometry(page.assets, viewport.width, width).height);
    const layout = catalogLayout(sections, viewport.width, width, measured.current, headings);
    const last = layout.groups[layout.groups.length - 1];
    if (headings && last) { last.height = Math.max(last.height, viewport.height); layout.height = last.top + last.height; }
    return layout;
  }, [sections, viewport.width, viewport.height, width, headings, tick]);
  const layoutRef = useRef(layout); layoutRef.current = layout;
  const scale = catalogScrollScale(layout.height + 100, viewport.height);
  const logicalTop = viewport.top / scale;
  const visible = visibleCatalogBlocks(layout.blocks, logicalTop, viewport.height);
  const focusBlock = focused ? layout.blocks.find(block => block.key === focused) : undefined;
  if (focusBlock && !visible.some(block => block.key === focused)) visible.push(focusBlock);
  const wanted = useRef(visible); wanted.current = visible;
  const pump = useRef<() => void>(() => {});
  function rememberAnchor() {
    const view = scroll.current;
    if (!view) return;
    const top = view.scrollTop / catalogScrollScale(layoutRef.current.height + 100, view.clientHeight);
    const block = visibleCatalogBlocks(layoutRef.current.blocks, top, 1, 0)[0];
    if (block) anchor.current = { key: block.key, delta: top - block.top };
  }
  pump.current = () => {
    if (!alive.current) return;
    for (const block of wanted.current) {
      if (pending.current.size >= 3) break;
      if (pending.current.has(block.key) || errors.current.has(block.key) || cache.current.get(block.key)?.revision === version.current) continue;
      pending.current.add(block.key);
      const requestedRevision = version.current;
      const section = sections[block.section];
      void materialCatalog.page({ ...filter, id: section.tagId ?? filter.id }, block.offset, CATALOG_PAGE_SIZE).then(assets => {
        if (!alive.current || version.current !== requestedRevision) return;
        rememberAnchor();
        cache.current.delete(block.key); cache.current.set(block.key, { assets, revision: requestedRevision });
        const keep = new Set(wanted.current.map(item => item.key));
        for (const key of cache.current.keys()) {
          if (cache.current.size <= CATALOG_CACHE_PAGES) break;
          if (!keep.has(key)) cache.current.delete(key);
        }
        setTick(v => v + 1);
      }).catch(error => {
        if (alive.current && version.current === requestedRevision) { errors.current.set(block.key, String(error)); setTick(v => v + 1); }
      }).finally(() => { pending.current.delete(block.key); pump.current(); });
    }
  };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { errors.current.clear(); pump.current(); }, [revision]);
  const wantedKey = visible.map(block => block.key).join("|");
  useEffect(() => { pump.current(); }, [wantedKey, revision, tick]);
  useEffect(() => { onAssetsChange?.([...new Map([...cache.current.values()].flatMap(page => page.assets).map(asset => [asset.id, asset])).values()]); }, [tick, onAssetsChange]);
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
    if (anchor.current && scroll.current) {
      const block = layout.blocks.find(item => item.key === anchor.current!.key);
      if (block) scroll.current.scrollTop = (block.top + Math.min(anchor.current.delta, Math.max(0, block.height - 1))) * scale;
      anchor.current = null;
    }
  }, [layout, scroll]);
  const restored = useRef(false);
  const jumped = useRef<typeof jump>(null);
  useLayoutEffect(() => {
    if (!restored.current && layout.blocks.length && scroll.current) { scroll.current.scrollTop = initialTop ?? 0; restored.current = true; }
  }, [layout, initialTop, scroll]);
  useLayoutEffect(() => {
    if (!jump || jumped.current === jump || !scroll.current) return;
    const index = sections.findIndex(section => section.id === jump.id);
    if (index >= 0) { jumped.current = jump; anchor.current = null; scroll.current.scrollTop = layout.groups[index].top * scale; }
  }, [jump, sections, scroll]);
  let current: string | null = headings ? sections[0]?.id ?? null : null;
  if (headings) sections.forEach((section, index) => { if (layout.groups[index].top <= logicalTop + 1) current = section.id; });
  useEffect(() => { onActive(current); }, [current, onActive]);
  return <div ref={root} className={`catalog-sections catalog-virtual${filter.kind === "tags" ? " catalog-tag-sections" : ""}`} aria-label="分类素材" style={{ height: Math.min(layout.height + 100, 8_000_000), position: "relative", overflow: "clip", overflowAnchor: "none" }} data-cached-pages={cache.current.size}>
    {sections.map((section, index) => <section key={section.id} data-catalog-section={section.id} data-tag-section={section.tagId ?? undefined}
      aria-label={headings ? `${section.name}${section.tagId ? "图片" : "素材"}` : undefined} style={{ position: "absolute", top: layout.groups[index].top * scale, height: layout.groups[index].height * scale, width: "100%" }}>
      {headings && (current === section.id || visible.some(block => block.section === index)) && <h3 style={{ position: "absolute", width: "100%", top: Math.min(Math.max(layout.groups[index].top, logicalTop), layout.groups[index].top + layout.groups[index].height - 40) - logicalTop + viewport.top - layout.groups[index].top * scale }} className={`catalog-section-heading${current === section.id && viewport.top > 0 ? " is-pinned" : ""}`}><span title={section.name} className={`catalog-section-title${current === section.id && viewport.top > 0 ? " library-floating-surface" : ""}`}>{section.name}</span></h3>}
      {visible.filter(block => block.section === index).map(block => {
        const page = cache.current.get(block.key), error = errors.current.get(block.key);
        const geometry = page ? masonryGeometry(page.assets, viewport.width, width) : null;
        return <div key={block.key} data-catalog-page={block.key} data-columns={geometry?.columns} className="folder-masonry catalog-virtual-page" style={{ position: "absolute", top: block.top - logicalTop + viewport.top - layout.groups[index].top * scale, height: block.height }}
          onFocusCapture={() => setFocused(block.key)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setFocused(null); }}>
          {error && <p className="catalog-error" role="alert">{error}<button onClick={() => { errors.current.delete(block.key); setTick(v => v + 1); }}>重试</button></p>}
          {!page && !error && <p className="catalog-hint" role="status">正在读取素材…</p>}
          {page?.assets.map((asset, index) => {
            const cell = geometry!.cells[index];
            // Cull inside a page too: tall portraits must not multiply DOM work.
            const y = block.top + cell.top;
            if (y + cell.height < logicalTop - 500 || y > logicalTop + viewport.height + 500) {
              if (focused !== block.key) return null;
            }
            return <FileMediaCard key={asset.id} style={{ width: cell.width, height: cell.height, transform: `translate3d(${cell.left}px,${cell.top}px,0)` }}
              entry={{ path: asset.store_path ?? "", name: asset.name, directory: false, preview: asset.thumb_path, version: `${asset.id}:${asset.file_mtime ?? 0}:${asset.thumb_path}` }}
              aspectRatio={cell.ratio} selected={selected.has(asset.id)} revision={revision} labels={[]} assetId={asset.id} generated={asset.generation_session_id != null}
              onSelect={(additive, range) => onSelect(asset, additive, range, { section: section.id, index: block.offset + index })}
              onActivate={onActivate ? () => onActivate(asset) : undefined} onOpen={() => onOpen(asset)} onContextMenu={(x,y) => onContextMenu(asset,x,y)}
              onDragStart={event => { const ids = selected.has(asset.id) ? [...selected] : [asset.id]; setDragAssets(ids); event.dataTransfer.effectAllowed = "copy"; event.dataTransfer.setData("text/plain", ids.join(",")); }} onDragEnd={() => setDragAssets(null)}/>;
          })}
        </div>;
      })}
    </section>)}
  </div>;
}
