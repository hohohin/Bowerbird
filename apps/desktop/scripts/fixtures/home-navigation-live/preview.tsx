// Reuse the established closed IPC/App bootstrap; override only data and failures
// needed by the home navigation regression. No native/user data is accessed.
import '../canvas-reference/preview';
import { useStore } from '../../../src/store';
import { useLocalFileMode } from '../../../src/lib/localFileMode';

const w = window as any;
const baseInvoke = w.__TAURI_INTERNALS__.invoke;
const assets = useStore.getState().assets;
const originalProject = useStore.getState().projects[0];
const now = Math.floor(Date.now() / 1000);
const names = ['山野品牌', '秋日海报', '旅行分镜', '咖啡包装', '空间灵感', '品牌摄影'];
const projects = Array.from({ length: 18 }, (_, i) => ({ ...originalProject, id: i === 0 ? 'p' : `home-project-${i}`,
  name: `${names[i % names.length]} ${i + 1}`, workspace_path: `blank:${i}`, asset_count: 3,
  created_at: now - 86400, updated_at: now - i * 3600, provisional: false }));
const memberships = projects.flatMap((p, index) => assets.slice(index * 3, index * 3 + 3).map(asset => ({ projectId: p.id, assetId: asset.id })));
const tags = [{ id: 'brand', name: 'A 品牌', count: assets.length, projectCount: 0, description: '' }];
w.mode = useLocalFileMode;
w.homeProjects = projects;
w.homeCovers = Object.fromEntries(projects.map((p, index) => [p.id, {
  asset_count: 3, paths: assets.slice(index * 3, index * 3 + 3).map(a => a.thumb_path ?? a.store_path),
}]));
w.__TAURI_INTERNALS__.invoke = async (command: string, args: any = {}) => {
  if (['list_projects', 'list_library_view', 'set_active_project', 'file_workspace_prepare', 'project_canvas_get'].includes(command)) w.calls.push({ command, args });
  if (command === 'list_projects') return projects;
  if (command === 'project_covers') {
    const covers = structuredClone(w.homeCovers);
    if (w.holdHomeCovers) await new Promise(resolve => { w.releaseHomeCovers = resolve; });
    return covers;
  }
  if (command === 'list_library_view') return { assets, memberships, total: assets.length };
  if (command === 'material_catalog') return { tags, prompts: [], collections: [], tag_asset_ids: { brand: assets.map(asset => asset.id) } };
  if (command === 'material_catalog_assets') return assets;
  if (command === 'folder_connections' || command === 'connection_entries') return [];
  if (command === 'external_files_media' && w.holdHomeMedia) {
    await new Promise(resolve => { w.releaseHomeMedia = resolve; });
  }
  if (command === 'set_active_project') {
    if (args.projectId && w.failHomeOpen) throw '无法打开项目，隔离验证';
    if (args.projectId && w.holdHomeOpen) await new Promise(resolve => { w.releaseHomeOpen = resolve; });
    w.nativeProject = args.projectId; return;
  }
  if (command === 'file_workspace_prepare' && w.failHomeCreate) throw '资料目录无法写入，隔离验证';
  if (command === 'project_canvas_get' && args.projectId !== 'p') return {
    canvas: { projectId: args.projectId, draftJson: '{}', createdAt: now, updatedAt: now },
    nodes: [], edges: [], groups: [], groupItems: [], threads: [], executionLinks: [], view: null,
  };
  return baseInvoke(command, args);
};
useStore.setState({ projects, projectsThumbnailWidth: 200 });
// Place the delay outside catalogPagingMock, which resolves known assets itself.
const catalogInvoke = w.__TAURI_INTERNALS__.invoke;
Object.defineProperty(w.__TAURI_INTERNALS__, 'invoke', { configurable: true, writable: true, value: async (command: string, args: any = {}) => {
  if (command === 'get_assets_by_ids' && w.holdHomeSelection)
    await new Promise(resolve => { w.releaseHomeSelection = resolve; });
  return catalogInvoke(command, args);
} });
