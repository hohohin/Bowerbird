import React from 'react';
import { createRoot } from 'react-dom/client';
import { AssetDetail } from '../../../src/components/AssetDetail';
import { LibraryHome } from '../../../src/components/LibraryHome';
import { Toolbar } from '../../../src/components/Toolbar';
import { ToastViewport } from '../../../src/components/ToastViewport';
import { useStore } from '../../../src/store';
import { useLocalFileMode } from '../../../src/lib/localFileMode';
import '../../../src/styles.css';
import '../../../src/components/LocalFileWorkspace.css';
import '../../../src/components/IndustrialTheme.css';

const w = window as any;
const assets = [
  { id: 'md', name: '创作笔记', ext: 'md', store_path: '/fixture/创作笔记.md', size: 100, source: 'external', file_mtime: 1 },
  { id: 'txt', name: '原始文本', ext: 'txt', store_path: '/fixture/原始文本.txt', size: 90, source: 'external', file_mtime: 1 },
];
const snapshots = new Map(assets.map(asset => [asset.id, { assetId: asset.id, path: asset.store_path, text: asset.id === 'md' ? '# 创作笔记\n\n保持原来的布局。\n' : '普通文本 **不解释Markdown**\r\n第二行', version: 'v1', format: asset.ext === 'txt' ? 'text' : 'markdown' }]));
const media = [
  { id: 'image-reference', name: '参考图片', ext: 'png', store_path: '/fixture/reference.png', source: 'external' },
  { id: 'audio-reference', name: '参考音频', ext: 'wav', store_path: '/fixture/reference.wav', source: 'external', duration: 2 },
  { id: 'video-reference', name: '参考视频', ext: 'mp4', store_path: '/fixture/reference.mp4', source: 'external' },
];
w.calls = []; w.conflict = false; w.saveDelay = 0; w.store = useStore; w.mode = useLocalFileMode; w.snapshots = snapshots;
let callback = 0;
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
w.__TAURI_INTERNALS__ = { transformCallback: () => ++callback, convertFileSrc: (path: string) => path,
  invoke: async (command: string, args: any = {}) => {
    w.calls.push({ command, args });
    if (command === 'plugin:event|listen') return args.handler;
    if (['plugin:event|unlisten', 'set_setting', 'refresh_folder_connections'].includes(command)) return;
    if (command === 'read_text_document') return { ...snapshots.get(args.assetId) };
    if (command === 'save_text_document') {
      if (w.saveDelay) await new Promise(resolve => setTimeout(resolve, w.saveDelay));
      const old = snapshots.get(args.assetId)!;
      if (w.conflict || old.version !== args.expectedVersion) throw new Error('原文件已被其他应用修改，请重新读取后再保存。');
      const next = { ...old, text: args.text, version: `${old.version}-saved` }; snapshots.set(args.assetId, next); return next;
    }
    if (command === 'get_assets_by_ids') return [...assets, ...media].filter(asset => args.assetIds.includes(asset.id));
    if (command === 'import_files') return media;
    if (command === 'plugin:dialog|open') return media.map(asset => asset.store_path);
    if (command === 'audio_waveform') return { sourceVersion: 'wave-v1', duration: 2, sampleRate: 8000, channels: 1, totalFrames: 16000, framesPerPeak: 8000, peaks: [[-.4, .4], [-.8, .8]] };
    if (command === 'get_settings') return {};
    if (command === 'list_assets' || command === 'material_catalog_assets' || command === 'catalog_page') return assets;
    if (command === 'catalog_ids') return assets.map(asset => asset.id);
    if (command === 'catalog_overview') return { total: 2, untagged: 2, catalog: { tags: [], collections: [], prompts: [], tag_asset_ids: {} } };
    if (command === 'catalog_prepare_colors') return { after: null, more: false, updated: 0, failed: 0 };
    if (command === 'codex_health') return { ok: false, reason: '隔离测试' };
    if (command === 'generation_history') return { turns: [], references: [], products: [] };
    if (command === 'external_files_media' || command === 'external_files_preview') throw new Error('文本不得进入图片预览');
    if (command === 'text_document_media' || command === 'resolve_text_document_media') return [];
    if (command.startsWith('list_') || ['folder_connections', 'connection_entries', 'canvas_frequent_assets'].includes(command)) return command === 'canvas_frequent_assets' ? { frequent: [], pinned: [], threshold: 10 } : [];
    if (command.startsWith('plugin:dialog|')) return null;
    throw new Error(`Unexpected test IPC: ${command}`);
  } };
useStore.setState({ assets, activeProjectId: null, detailAssetId: 'md', libraryHomeView: 'library', projects: [], mode: 'browse', loading: false });
function Fixture() {
  const detail = useStore(state => state.detailAssetId);
  return <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
    <Toolbar localFilesOpen canvasMode={false} onCanvasModeChange={() => {}} onRefresh={async () => {}} onCreateCreative={() => {}} />
    <div style={{ flex: 1, minHeight: 0 }}>{detail ? <AssetDetail onExploreSource={() => {}} /> : <LibraryHome />}</div><ToastViewport />
  </div>;
}
document.documentElement.dataset.theme = 'dark';
createRoot(document.getElementById('root')!).render(<Fixture />);
