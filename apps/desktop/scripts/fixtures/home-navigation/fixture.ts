import { useStore } from '../../../src/store';
import { useLocalFileMode } from '../../../src/lib/localFileMode';
import { EMPTY_QUICK_TRANSFER } from '../../../src/lib/quickTransferState';
import { installCatalogPagingMock } from '../catalogPagingMock';

// Closed fixture: no user database, native filesystem, login or network writes.
const w = window as any;
const samples = Object.values(import.meta.glob('../../../src-tauri/resources/samples/preset-*.webp', { eager: true, query: '?url', import: 'default' })) as string[];
const assets = Array.from({ length: 96 }, (_, index) => ({
  id: `home-asset-${index}`, name: `灵感素材 ${index + 1}`, ext: 'webp', source: 'imported', width: 600, height: [600, 800, 450][index % 3],
  store_path: samples[index % samples.length], thumb_path: samples[index % samples.length], created_at: 1000 - index, generation_session_id: null,
}));
const names = ['山野护肤 · 品牌视觉', '秋日系列 · 电商海报', '山间徒步 · 视频分镜', '栖木咖啡 · 包装探索', '理想居所 · 空间灵感', '夏日光影 · 品牌摄影'];
const now = Math.floor(Date.now() / 1000);
const projects = Array.from({ length: 18 }, (_, index) => ({ id: `home-project-${index}`, name: names[index % names.length] + (index < 6 ? '' : ` ${Math.floor(index / 6) + 1}`),
  kind: 'blank', workspace_path: `blank:home-project-${index}`, created_at: now - 86400, updated_at: now - index * 3600, asset_count: index % 6 === 4 ? 0 : 12 + index }));
const memberships = projects.flatMap((p, index) => p.asset_count ? assets.slice(index * 3, index * 3 + 3).map(asset => ({ projectId: p.id, assetId: asset.id })) : []);
const tags = [{ id: 'a', name: 'A 品牌' }, { id: 'z', name: 'Z 灵感' }];
const catalog = { tags: tags.map(tag => ({ ...tag, count: 48, projectCount: 0, description: '' })), prompts: [], collections: [],
  tag_asset_ids: Object.fromEntries(tags.map((tag, index) => [tag.id, assets.slice(index * 48, index * 48 + 48).map(asset => asset.id)])) };
let callbackId = 0;
w.store = useStore; w.mode = useLocalFileMode; w.calls = [];
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
w.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } }, transformCallback: () => ++callbackId, convertFileSrc: (path: string) => path,
  invoke: async (command: string, args: any = {}) => {
    w.calls.push({ command, args });
    if (command === 'quick_transfer_status') return EMPTY_QUICK_TRANSFER;
    if (command === 'plugin:event|listen') return args.handler;
    if (command === 'plugin:event|unlisten' || command === 'set_setting' || command === 'refresh_folder_connections') return;
    if (command === 'material_catalog') return catalog;
    if (command === 'material_catalog_assets') return assets;
    if (command === 'get_assets_by_ids') return assets.filter(asset => args.assetIds.includes(asset.id));
    if (command === 'list_library_view') return { assets, memberships, total: assets.length };
    if (command === 'external_files_preview' || command === 'external_files_media') return args.path;
    if (command === 'file_colors') return ['blue'];
    if (command === 'get_projects' || command === 'list_projects') return useStore.getState().projects;
    if (['get_folders', 'get_collections', 'folder_connections', 'connection_entries'].includes(command)) return [];
    if (command === 'get_settings') return {};
    if (command.startsWith('plugin:dialog|')) return null;
    if (command === 'get_asset') return assets.find(asset => asset.id === args.id) ?? assets[0];
    if (command === 'rename_project') { useStore.setState(s => ({ projects: s.projects.map(p => p.id === args.id ? { ...p, name: args.name } : p) })); return; }
    if (command === 'file_workspace_status') return { config: { root: '/fixture', places: [], projects: {} }, proposed_root: '/fixture' };
    if (command === 'file_workspace_all') return { entries: [], unavailable: [] };
    if (command === 'global_classification_view') return { labels: [], pictures: [] };
    return null;
  },
};
installCatalogPagingMock(w);
useStore.setState({ activeProjectId: null, libraryThumbnailWidth: 180, projectsThumbnailWidth: 200, loading: false, projects: projects as any, assets: assets as any, mode: 'browse',
  enterProject: async id => { useStore.setState({ activeProjectId: id }); },
  cloudAuth: { logged_in: true, display_name: '预览用户', cloud_available: true } as any,
  cloudEntitlement: { tier: 'pro', balances: { daily: 0, sub: 0, topup: 1230 }, policy: { can_use_cloud: true, can_use_byo: true }, recent_transactions: [], generation_services: [], prompt_configs: [] } as any });
useLocalFileMode.setState({ mode: 'tags', views: { global: 'tags', project: 'tags' }, query: '' });

export function createPreviewProject() {
  const id = `preview-new-${useStore.getState().projects.length}`;
  useStore.setState(s => ({ projects: [...s.projects, { ...projects[0], id, name: '未命名项目', workspace_path: `blank:${id}`, asset_count: 0 } as any], activeProjectId: id }));
}
