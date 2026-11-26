// Page reads and mounted cards stay bounded; visited pages retain only aspect ratios.
import { isAudioPath } from "./audioMedia.ts";
import { isTextPath, TEXT_CARD_ASPECT_RATIO } from "./textMedia.ts";
import { MAX_THUMBNAIL_WIDTH } from "./thumbnailSize.ts";
export const CATALOG_PAGE_SIZE = 60;
export const CATALOG_CACHE_PAGES = 16;
export const CATALOG_GAP = 8;
// Browser scroll surfaces have finite pixel heights. Keep even a narrow 300k
// catalog below that limit while mapping the scrollbar to the full logical range.
export function catalogScrollScale(height: number, viewport: number) {
  return height <= 8_000_000 ? 1 : Math.max(1, 8_000_000 - viewport) / Math.max(1, height - viewport);
}
export interface CatalogSectionInfo { id: string; name: string; count: number; tagId: string | null; projectId?: string }
export interface CatalogBlock {
  key: string; section: number; page: number; offset: number; count: number; top: number; height: number;
  columnTops: number[]; maxBottom: number;
}
type Dimensions = { width?: number | null; height?: number | null; store_path?: string | null };

export function masonryRatios(items: readonly Dimensions[]) {
  return items.map(item => isTextPath(item.store_path) ? TEXT_CARD_ASPECT_RATIO : isAudioPath(item.store_path) ? 2 : item.width && item.height ? item.width / item.height : 1);
}

function masonryDimensions(available: number, target: number, responsive: boolean) {
  const content = available - 16;
  const columnsForPreference = Math.floor((content + CATALOG_GAP) / (target + CATALOG_GAP));
  const minimum = responsive && content >= 2 * 80 + CATALOG_GAP ? 2 : 1;
  const columnsForMaxWidth = responsive ? Math.ceil((content + CATALOG_GAP) / (MAX_THUMBNAIL_WIDTH + CATALOG_GAP)) : 1;
  const columns = Math.max(minimum, columnsForPreference, columnsForMaxWidth);
  const width = Math.max(1, (content - CATALOG_GAP * (columns - 1)) / columns);
  return { columns, width };
}
type Cell = { left: number; top: number; width: number; height: number; ratio: number };
// Unknown pages use square estimates without allocating per-asset layout objects.
// All pages in a section share the same column tails, including across cache eviction.
function placeMasonry(ratios: readonly number[] | undefined, count: number, width: number, heights: number[], cells?: Cell[]) {
  const top = Math.min(...heights);
  let bottom = top;
  for (let index = 0; index < count; index++) {
    if (!ratios && !cells && count - index >= heights.length &&
        Math.max(...heights) - Math.min(...heights) < width + CATALOG_GAP - 1e-7) {
      // All columns receive one square before any column can receive a second.
      const rounds = Math.floor((count - index) / heights.length);
      for (let i = 0; i < heights.length; i++) heights[i] += rounds * (width + CATALOG_GAP);
      bottom = Math.max(bottom, ...heights);
      index += rounds * heights.length - 1;
      continue;
    }
    let column = 0;
    // Keep ties deterministic when absolute column tails are translated into
    // page-local coordinates; sub-pixel rounding must not choose another column.
    for (let i = 1; i < heights.length; i++) if (heights[i] < heights[column] - 1e-7) column = i;
    const ratio = ratios?.[index] ?? 1;
    const height = width / ratio;
    cells?.push({ left: 8 + column * (width + CATALOG_GAP), top: heights[column], width, height, ratio });
    heights[column] += height + CATALOG_GAP;
    bottom = Math.max(bottom, heights[column]);
  }
  return { top, bottom };
}

export function masonryGeometry(items: readonly Dimensions[], available: number, target: number, initialTops?: readonly number[], responsive = false) {
  const { columns, width } = masonryDimensions(available, target, responsive);
  const heights = initialTops ? [...initialTops] : Array<number>(columns).fill(8);
  const cells: Cell[] = [];
  placeMasonry(masonryRatios(items), items.length, width, heights, cells);
  return { cells, height: Math.max(...heights), width, columns };
}

type PagePlacement = {
  ratios: readonly number[]; width: number; count: number;
  initial: number[]; tails: number[]; top: number; bottom: number;
};
export type CatalogPlacementCache = Map<string, PagePlacement>;

export function catalogLayout(sections: CatalogSectionInfo[], available: number, target: number, measured: ReadonlyMap<string, readonly number[]>, headings: boolean, placements?: CatalogPlacementCache, responsive = false) {
  const geometry = masonryDimensions(available, target, responsive);
  let top = 0, maxBottom = 0;
  const blocks: CatalogBlock[] = [];
  const groups = sections.map((section, index) => {
    const start = top;
    if (headings) top += 40;
    const heights = Array<number>(geometry.columns).fill(top + 8);
    const firstTop = top + 8, step = geometry.width + CATALOG_GAP;
    let allSquares = true;
    for (let offset = 0; offset < section.count; offset += CATALOG_PAGE_SIZE) {
      const page = offset / CATALOG_PAGE_SIZE, key = `${section.id}:${page}`;
      const count = Math.min(CATALOG_PAGE_SIZE, section.count - offset);
      const ratios = measured.get(key);
      if (allSquares && !ratios) {
        const firstRow = Math.floor(offset / geometry.columns);
        const lastRow = Math.ceil((offset + count) / geometry.columns);
        const pageTop = firstTop + firstRow * step;
        const bottom = firstTop + lastRow * step;
        maxBottom = Math.max(maxBottom, bottom);
        const remainder = offset % geometry.columns;
        blocks.push({ key, section: index, page, offset, count, top: pageTop, height: bottom - pageTop,
          columnTops: heights.map((_, column) => column < remainder ? step : 0), maxBottom });
        continue;
      }
      if (allSquares) {
        for (let i = 0; i < heights.length; i++) heights[i] = firstTop + Math.ceil((offset - i) / geometry.columns) * step;
        allSquares = false;
      }
      const initialTops = [...heights];
      const cached = ratios && placements?.get(key);
      let bounds;
      if (cached && cached.ratios === ratios && cached.count === count && cached.width === geometry.width &&
          cached.initial.length === heights.length && heights.every((value, i) => value === cached.initial[i])) {
        bounds = cached;
        heights.splice(0, heights.length, ...cached.tails);
      } else {
        bounds = placeMasonry(ratios, count, geometry.width, heights);
        if (ratios) placements?.set(key, { ratios, width: geometry.width, count, initial: initialTops, tails: [...heights], ...bounds });
      }
      maxBottom = Math.max(maxBottom, bounds.bottom);
      blocks.push({ key, section: index, page, offset, count, top: bounds.top, height: bounds.bottom - bounds.top,
        columnTops: initialTops.map(value => value - bounds.top), maxBottom });
    }
    if (section.count) top = allSquares ? firstTop + Math.ceil(section.count / geometry.columns) * step : Math.max(...heights);
    if (headings) top += 16;
    return { top: start, height: top - start };
  });
  return { blocks, groups, height: top };
}

export function visibleCatalogBlocks(blocks: CatalogBlock[], top: number, height: number, overscan = 500) {
  let low = 0, high = blocks.length;
  const start = top - overscan, end = top + height + overscan;
  // Page bounds can overlap: an early page's portrait may extend past several
  // later pages. Search monotonic prefix bounds, then test each page's own bound.
  while (low < high) { const mid = (low + high) >>> 1; if (blocks[mid].maxBottom < start) low = mid + 1; else high = mid; }
  const result: CatalogBlock[] = [];
  for (let i = low; i < blocks.length && blocks[i].top <= end; i++) {
    if (blocks[i].top + blocks[i].height >= start) result.push(blocks[i]);
  }
  return result;
}
