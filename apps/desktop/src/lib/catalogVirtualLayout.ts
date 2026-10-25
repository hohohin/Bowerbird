// Pages bound metadata and DOM work independently of the library's total size.
export const CATALOG_PAGE_SIZE = 60;
export const CATALOG_CACHE_PAGES = 16;
export const CATALOG_GAP = 8;
// Browser scroll surfaces have finite pixel heights. Keep even a narrow 300k
// catalog below that limit while mapping the scrollbar to the full logical range.
export function catalogScrollScale(height: number, viewport: number) {
  return height <= 8_000_000 ? 1 : Math.max(1, 8_000_000 - viewport) / Math.max(1, height - viewport);
}
export interface CatalogSectionInfo { id: string; name: string; count: number; tagId: string | null }
export interface CatalogBlock { key: string; section: number; page: number; offset: number; count: number; top: number; height: number }

export function masonryGeometry(items: readonly { width?: number | null; height?: number | null }[], available: number, target: number) {
  const columns = Math.max(1, Math.floor((available - 16 + CATALOG_GAP) / (target + CATALOG_GAP)));
  const width = Math.max(1, (available - 16 - CATALOG_GAP * (columns - 1)) / columns);
  const heights = Array<number>(columns).fill(8);
  const cells = items.map(item => {
    let column = 0;
    for (let i = 1; i < columns; i++) if (heights[i] < heights[column]) column = i;
    const ratio = item.width && item.height ? item.width / item.height : 1;
    const height = width / ratio;
    const cell = { left: 8 + column * (width + CATALOG_GAP), top: heights[column], width, height, ratio };
    heights[column] += height + CATALOG_GAP;
    return cell;
  });
  return { cells, height: Math.max(...heights), width, columns };
}

export function catalogLayout(sections: CatalogSectionInfo[], available: number, target: number, measured: ReadonlyMap<string, number>, headings: boolean) {
  const geometry = masonryGeometry([], available, target);
  let top = 0;
  const blocks: CatalogBlock[] = [];
  const groups = sections.map((section, index) => {
    const start = top;
    if (headings) top += 40;
    for (let offset = 0; offset < section.count; offset += CATALOG_PAGE_SIZE) {
      const page = offset / CATALOG_PAGE_SIZE, key = `${section.id}:${page}`;
      const count = Math.min(CATALOG_PAGE_SIZE, section.count - offset);
      const height = measured.get(key) ?? 8 + Math.ceil(count / geometry.columns) * (geometry.width + CATALOG_GAP);
      blocks.push({ key, section: index, page, offset, count, top, height });
      top += height;
    }
    if (headings) top += 16;
    return { top: start, height: top - start };
  });
  return { blocks, groups, height: top };
}

export function visibleCatalogBlocks(blocks: CatalogBlock[], top: number, height: number, overscan = 500) {
  let low = 0, high = blocks.length;
  const start = top - overscan, end = top + height + overscan;
  while (low < high) { const mid = (low + high) >>> 1; if (blocks[mid].top + blocks[mid].height < start) low = mid + 1; else high = mid; }
  const result: CatalogBlock[] = [];
  for (let i = low; i < blocks.length && blocks[i].top <= end; i++) result.push(blocks[i]);
  return result;
}
