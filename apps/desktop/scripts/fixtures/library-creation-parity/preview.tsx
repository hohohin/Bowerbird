// Actual App + production creation paths. Only synthetic IPC/data is added.
import '../library-generation-live/preview';
import { useStore } from '../../../src/store';

const w = window as any;
const baseInvoke = w.__TAURI_INTERNALS__.invoke;
const assets = useStore.getState().assets;
const mediaFallbacks = new URLSearchParams(location.search).has('media-fallback')
  ? ['txt', 'mp3'].map(ext => ({ ...assets[0], id: `parity-missing-${ext}`, name: `无路径${ext === 'txt' ? '文本' : '音频'}`, ext, store_path: null, thumb_path: null })) : [];
const cacheMediaFallbacks = !new URLSearchParams(location.search).has('media-uncached');
if (mediaFallbacks.length && cacheMediaFallbacks) useStore.setState({ assets: [...assets, ...mediaFallbacks] });
// Later catalog pages intentionally never enter the legacy store asset cache.
const paged = Array.from({ length: 120 }, (_, index) => ({ ...assets[0], id: `parity-paged-${index}`, name: `分页素材 ${index}` }));
const catalog = [...mediaFallbacks, ...assets, ...paged];
const entries = assets.slice(0, 6).map((asset, index) => ({ id: `parity-entry-${index}`, folder_id: 'parity-root',
  asset_id: asset.id, asset, name: asset.name, path: asset.store_path, is_reference: false, available: true, created_at: 1 }));
w.parityPicks = []; w.parityCatalogPages = []; w.parityAssetReads = []; w.parityAssetReleases = {};
window.addEventListener('bowerbird://board-asset-picked', (event: Event) => w.parityPicks.push((event as CustomEvent).detail));
const invoke = async (command: string, args: any = {}) => {
  if (command === 'list_assets' && mediaFallbacks.length && cacheMediaFallbacks) return [...await baseInvoke(command, args), ...mediaFallbacks];
  if (command === 'catalog_overview') return { total: catalog.length, untagged: catalog.length,
    catalog: { tags: [], collections: [], prompts: [], tag_asset_ids: {} } };
  if (command === 'catalog_page' || command === 'catalog_ids') {
    w.parityCatalogPages.push({ command, offset: args.offset, limit: args.limit });
    const page = catalog.slice(args.offset, args.offset + args.limit);
    return command === 'catalog_ids' ? page.map(asset => asset.id) : page;
  }
  if (command === 'folder_connections') return [{ id: 'parity-root', root_id: 'parity-root', parent_id: null,
    name: '交互验证集合', path: '/synthetic/parity', available: true, count: entries.length, scanning: false, error: null }];
  if (command === 'connection_entries') return entries.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 100));
  if (command === 'connection_entry_ids') return entries.map(entry => entry.id);
  if (command === 'resolve_connection_entries') return entries.filter(entry => args.ids.includes(entry.id));
  if (command === 'generation_history') return { session_id: null, references: [], turns: [] };
  if (command === 'get_assets_by_ids') {
    w.parityAssetReads.push([...args.assetIds]);
    if (w.parityHoldAssets) await new Promise(resolve => {
      w.releaseParityAssets = resolve;
      w.parityAssetReleases[args.assetIds[0]] = resolve;
    });
    return catalog.filter(asset => args.assetIds.includes(asset.id));
  }
  if (command === 'get_asset') return catalog.find(asset => asset.id === args.id) ?? null;
  return baseInvoke(command, args);
};
// Install the explicit paging protocol without the legacy fixture's all-assets compatibility wrapper.
Object.defineProperty(w.__TAURI_INTERNALS__, 'invoke', { configurable: true, writable: true, value: invoke });
