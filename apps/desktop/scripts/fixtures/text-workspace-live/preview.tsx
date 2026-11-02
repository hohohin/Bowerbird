import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TextWorkspace } from '../../../src/components/TextWorkspace';
import '../../../src/styles.css';
import '../../../src/components/IndustrialTheme.css';
const w = window as any;
const assets = [
  { id: 'img1', name: '画面参考', store_path: '/fixture/reference.png', thumb_path: '/fixture/reference.png', ext: 'png' },
  { id: 'video1', name: '视频参考', store_path: '/fixture/reference.mp4', ext: 'mp4' },
  { id: 'audio1', name: '声音参考', store_path: '/fixture/reference.wav', ext: 'wav' },
];
w.calls = []; w.saveDelay = 0; w.mediaDelay = 0; w.saveError = false; w.mediaMissing = false;
w.__TAURI_INTERNALS__ = { convertFileSrc: (path: string) => path, invoke: async (command: string, args: any = {}) => {
  w.calls.push({ command, args });
  if (command === 'folder_connections') return [{ id: 'f', root_id: 'f', parent_id: null, name: '创作笔记', path: '/fixture/notes', available: true, count: 1, scanning: false, error: null }];
  if (command === 'list_projects') return [{ id: 'p', name: '秋日短片', workspace_path: '/fixture/project', kind: 'blank', created_at: 1, asset_count: 1 }];
  if (command === 'catalog_page') return args.offset ? [] : assets.filter(asset => asset.ext === ({ images: 'png', videos: 'mp4', audios: 'wav' } as Record<string, string>)[args.filter.media]);
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
