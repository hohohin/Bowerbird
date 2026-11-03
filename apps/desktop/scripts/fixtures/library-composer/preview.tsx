import '../home-navigation/fixture';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LibraryHome } from '../../../src/components/LibraryHome';
import { LibraryComposer } from '../../../src/components/LibraryComposer';
import { LibraryGenerationActivity } from '../../../src/components/LibraryGenerationActivity';
import { ToastViewport } from '../../../src/components/ToastViewport';
import { useStore } from '../../../src/store';
import '../../../src/styles.css';
import '../../../src/components/LocalFileWorkspace.css';
import '../../../src/components/LibraryTactical.css';
import '../../../src/components/TacticalMenus.css';
import '../../../src/components/IndustrialTheme.css';
import '../../../src/components/IndustrialCanvas.css';
import '../../../src/components/IndustrialMenus.css';
import './preview.css';

const w = window as any;
w.prepared = []; w.started = []; w.threads = []; w.chats = []; w.historyProjects = []; w.workspacePrepared = 0;
const originalInvoke = w.__TAURI_INTERNALS__.invoke;
w.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
  if (command === 'prepare_library_generation_project') {
    const id = args.projectId || 'quick';
    w.prepared.push(id);
    if (w.requireRoot) { w.requireRoot = false; throw new Error('FILE_ROOT_REQUIRED: fixture'); }
    if (w.holdPrepare) await new Promise(resolve => { w.releasePrepare = resolve; });
    if (!args.projectId && !useStore.getState().projects.some(project => project.id === id)) {
      useStore.setState(state => ({ projects: [...state.projects, { ...state.projects[0], id, name: '快速生成' }] }));
    }
    const project = useStore.getState().projects.find(project => project.id === id);
    if (!project) throw new Error('项目已不可用，请重新选择');
    return project;
  }
  if (command === 'project_thread_create') { w.threads.push(args.value); return { ...args.value, createdAt: Date.now(), updatedAt: Date.now(), archivedAt: null }; }
  if (command === 'file_workspace_prepare') { w.workspacePrepared++; return '/fixture/library'; }
  if (command === 'project_canvas_get') return { nodes: [], canvas: { id: args.projectId, draftJson: '' } };
  if (command === 'local_chat_send') {
    w.chats.push(args.input);
    if (w.holdChat) await new Promise(resolve => { w.releaseChat = resolve; });
    return { id: `chat-${w.chats.length}`, projectId: args.input.projectId, threadId: `chat-thread-${w.chats.length}`, nodeId: `chat-node-${w.chats.length}`,
      title: args.input.text, preview: args.input.text, provider: 'codex-local', status: 'idle', turnCount: 1, revision: 1, updatedAt: Date.now(), createdAt: Date.now(), error: null, messages: [], turns: [] };
  }
  if (command === 'local_chat_list') { w.historyProjects.push(args.projectId); return []; }
  return originalInvoke(command, args);
};
useStore.setState({ boardOpen: false, activeGenProvider: 'codex', defaultProvider: 'codex', settings: {} as any,
  codexHealth: { ok: true, logged_in: true } as any,
  cloudEntitlement: { tier: 'pro', offline_state: 'fresh', policy: { can_use_byo: true, max_parallel_jobs: 10 }, balances: { sub: 1200 } } as any,
  startGeneration: async (...args: any[]) => { w.started.push(args); return { accepted: true, jobId: 'preview-job' }; },
  genJobs: { 'sample-running': { id: 'sample-running', projectId: 'home-project-0', threadId: 'sample-thread', running: true, createdAt: Date.now(), lastPrompt: '山野护肤系列海报', turns: [{ id: 1, turnKey: 'sample-turn', prompt: '山野护肤系列海报', images: [], startedAt: Date.now() }] } } as any,
});
function Preview() {
  const [revision, setRevision] = useState(0);
  w.remountComposer = () => setRevision(value => value + 1);
  return <div className="app-shell preview-shell">
    <header className="app-topbar"><span>Bowerbird</span><nav><button>素材库</button><button>项目</button></nav><button onClick={() => document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'}>切换外观</button></header>
    <main className="preview-main"><LibraryHome/><LibraryComposer key={revision}/><LibraryGenerationActivity/></main><ToastViewport/>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
