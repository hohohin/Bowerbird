// Page reads and mounted cards stay bounded; visited pages retain only aspect ratios.
export const CATALOG_PAGE_SIZE = 60;
export const CATALOG_CACHE_PAGES = 16;
export const CATALOG_GAP = 8;
// Browser scroll surfaces have finite pixel heights. Keep even a narrow 300k
// catalog below that limit while mapping the scrollbar to the full logical range.
export function catalogScrollScale(height: number, viewport: number) {
  return height <= 8_000_000 ? 1 : Math.max(1, 8_000_000 - viewport) / Math.max(1, height - viewport);
}
export interface CatalogSectionInfo { id: string; name: string; count: number; tagId: string | null }
export interface CatalogBlock {
  key: string; section: number; page: number; offset: number; count: number; top: number; height: number;
  columnTops: number[]; maxBottom: number;
}
type Dimensions = { width?: number | null; height?: number | null };

export function masonryRatios(items: readonly Dimensions[]) {
  return items.map(item => item.width && item.height ? item.width / item.height : 1);
}

function masonryDimensions(available: number, target: number) {
  const columns = Math.max(1, Math.floor((available - 16 + CATALOG_GAP) / (target + CATALOG_GAP)));
  const width = Math.max(1, (available - 16 - CATALOG_GAP * (columns - 1)) / columns);
  return { columns, width };
}
type Cell = { left: number; top: number; width: number; height: number; ratio: number };
// Unknown pages use square estimates without allocating per-asset layout objects.
// All pages in a section share the same column tails, including across cache eviction.
function placeMasonry(ratios: readonly number[] | undefined, count: number, width: number, heights: number[], cells?: Cell[]) {
  const top = Math.min(...heights);
  let bottom = top;
  for (let index = 0; index < count; index++) {
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

export function masonryGeometry(items: readonly Dimensions[], available: number, target: number, initialTops?: readonly number[]) {
  const { columns, width } = masonryDimensions(available, target);
  const heights = initialTops ? [...initialTops] : Array<number>(columns).fill(8);
  const cells: Cell[] = [];
  placeMasonry(masonryRatios(items), items.length, width, heights, cells);
  return { cells, height: Math.max(...heights), width, columns };
}

export function catalogLayout(sections: CatalogSectionInfo[], available: number, target: number, measured: ReadonlyMap<string, readonly number[]>, headings: boolean) {
  const geometry = masonryDimensions(available, target);
  let top = 0, maxBottom = 0;
  const blocks: CatalogBlock[] = [];
  const groups = sections.map((section, index) => {
    const start = top;
    if (headings) top += 40;
    const heights = Array<number>(geometry.columns).fill(top + 8);
    for (let offset = 0; offset < section.count; offset += CATALOG_PAGE_SIZE) {
      const page = offset / CATALOG_PAGE_SIZE, key = `${section.id}:${page}`;
      const count = Math.min(CATALOG_PAGE_SIZE, section.count - offset);
      const initialTops = [...heights];
      const bounds = placeMasonry(measured.get(key), count, geometry.width, heights);
      maxBottom = Math.max(maxBottom, bounds.bottom);
      blocks.push({ key, section: index, page, offset, count, top: bounds.top, height: bounds.bottom - bounds.top,
        columnTops: initialTops.map(value => value - bounds.top), maxBottom });
    }
    if (section.count) top = Math.max(...heights);
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
