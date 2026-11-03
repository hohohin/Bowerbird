import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TextWorkspace } from '../../../src/components/TextWorkspace';
import { useStore } from '../../../src/store';
import { useLocalFileMode } from '../../../src/lib/localFileMode';
import { workspaceCatalogResponse } from './catalogMock';
import { setupAgentMock, agentMock } from './agentMock';
import '../../../src/styles.css';
import '../../../src/components/IndustrialTheme.css';
const w = window as any;
const assets = [
  { id: 'img1', generation_session_id: new URLSearchParams(location.search).has('blocks') ? 'generated' : null, name: '画面参考', store_path: '/fixture/reference.png', thumb_path: '/fixture/reference.png', ext: 'png' },
  { id: 'video1', name: '视频参考', store_path: '/fixture/reference.mp4', ext: 'mp4' },
  { id: 'audio1', name: '声音参考', store_path: '/fixture/reference.wav', ext: 'wav' },
];
assets.push(...Array.from({ length: 140 }, (_, index) => ({ ...assets[0], id: `page-${index}`, name: `分镜 ${index + 1}` })));
w.store = useStore; w.backgroundMode = useLocalFileMode;
useLocalFileMode.setState({ source: 'global', mode: 'all', query: '背景搜索' });
useStore.setState({ activeProjectId: 'background-project', canvasLibraryOpen: false, detailAssetId: null, mode: 'manage', selectedIds: new Set(['img1', 'background-selected']) });
setupAgentMock();
let callbackId = 0;
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
w.calls = []; w.saveDelay = 0; w.mediaDelay = 0; w.saveError = false; w.mediaMissing = false; w.pinnedIds = [];
w.__TAURI_INTERNALS__ = { transformCallback: () => ++callbackId, convertFileSrc: (path: string) => path, invoke: async (command: string, args: any = {}) => {
  w.calls.push({ command, args });
  const agent = agentMock(command,args); if(agent!==undefined)return agent;
  if (command === 'generation_history' && new URLSearchParams(location.search).has('blocks')) return { turns: [{ prompt: '复用的提示词', prompt_raw: '复用的提示词' }], references: [], dimension_assets: [] };
  if (command === 'plugin:event|listen') return args.handler;
  if (command === 'plugin:event|unlisten') return;
  if (command === 'folder_connections') return [{ id: 'f', root_id: 'f', parent_id: null, name: '创作笔记', path: '/fixture/notes', available: true, count: 1, scanning: false, error: null }];
  if (command === 'list_projects') return [{ id: 'p', name: '秋日短片', workspace_path: '/fixture/project', kind: 'blank', created_at: 1, asset_count: 1 }];
  if (command === 'canvas_frequent_assets_pin') w.pinnedIds = [...new Set([...w.pinnedIds, ...args.assetIds])];
  if (command === 'canvas_frequent_assets_remove') w.pinnedIds = w.pinnedIds.filter((id: string) => id !== args.assetId);
  if (['canvas_frequent_assets', 'canvas_frequent_assets_pin', 'canvas_frequent_assets_remove'].includes(command)) return { threshold: 10, frequent: [assets[0]], pinned: assets.filter(asset => w.pinnedIds.includes(asset.id)) };
  const catalog = workspaceCatalogResponse(command, args, assets);
  if (catalog !== undefined) return catalog;
  if (command === 'get_assets_by_ids') { if (w.mediaDelay) await new Promise(resolve => setTimeout(resolve, w.mediaDelay)); return w.mediaMissing ? [] : assets.filter(asset => args.assetIds.includes(asset.id)); }
  if (command === 'create_text_document') {
    if (w.saveDelay) await new Promise(resolve => setTimeout(resolve, w.saveDelay));
    if (w.saveError) throw '目录暂时无法写入，请检查连接后重试';
    return args.input.destination.kind === 'project' ? { kind: 'project', nodeId: 'document-node' }
      : { kind: 'collection', assetId: 'saved', path: '/fixture/notes/saved.md', version: 'v1', text: args.input.text, format: 'markdown' };
  }
  throw Error(`Unexpected IPC ${command}`);
} };
function App() {
  const [opened, setOpened] = useState(true);
  const [draft, setDraft] = useState({ title: '剧本', markdown: '# 剧本\n\n窗外的光落在桌面上。\n\n第二段内容。\n' });
  return <><button onClick={() => setOpened(true)}>放大编辑</button>{opened && <TextWorkspace initialDocument={draft} projectId="p" onChange={next => { w.draft = next; setDraft(next); }} onClose={next => { setDraft(next); setOpened(false); }} onAddToComposer={next => { w.composer = next; setDraft(next); setOpened(false); }}/>}</>;
}
document.documentElement.dataset.theme = 'dark';
createRoot(document.getElementById('root')!).render(<App/>);
