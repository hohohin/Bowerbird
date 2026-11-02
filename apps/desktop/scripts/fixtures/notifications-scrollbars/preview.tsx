import '../home-navigation/fixture';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Toolbar } from '../../../src/components/Toolbar';
import { LibraryHome } from '../../../src/components/LibraryHome';
import { LibraryComposer } from '../../../src/components/LibraryComposer';
import { ProjectManagerPanel } from '../../../src/components/ProjectManagerPanel';
import { useStore } from '../../../src/store';
import { notify } from '../../../src/lib/notify';
import { emitPreviewGenerationNotice, PreviewToastViewport } from './notification-preview';
import { PreviewScrollbars } from './PreviewScrollbars';
import '../../../src/styles.css';
import '../../../src/components/LocalFileWorkspace.css';
import '../../../src/components/LibraryTactical.css';
import '../../../src/components/TacticalMenus.css';
import '../../../src/components/IndustrialTheme.css';
import '../../../src/components/IndustrialCanvas.css';
import '../../../src/components/IndustrialMenus.css';
import '../../../src/components/ToastViewport.css';
import './preview.css';

const w = window as any;
const quickProject = { ...useStore.getState().projects[0], id: 'preview-quick', name: '快速生成' };
const taskTitles = ['山野护肤系列海报', '秋日暖色产品图', '咖啡包装纸张纹理', '晨光中的玻璃器皿', '旅行封面排版', '花园系列主视觉'];
const previewJobs = Object.fromEntries(Array.from({ length: 12 }, (_, index) => {
  const id = `preview-job-${index}`, prompt = taskTitles[index % taskTitles.length];
  return [id, { id, projectId: index < 2 ? quickProject.id : `home-project-${index % 6}`, threadId: `preview-thread-${index}`, running: index === 0,
    createdAt: Date.now() - index * 3600000, lastPrompt: prompt,
    turns: [{ id: 1, turnKey: `preview-turn-${index}`, prompt, images: index === 0 ? [] : ['preview-result.webp'], startedAt: Date.now() - index * 3600000 }] }];
}));
useStore.setState({ boardOpen: false, activeGenProvider: 'codex', defaultProvider: 'codex', settings: { generation_completion_popup: true, generation_completion_sound: false } as any,
  projects: [...useStore.getState().projects, quickProject],
  codexHealth: { ok: true, logged_in: true } as any,
  cloudEntitlement: { ...useStore.getState().cloudEntitlement!, offline_state: 'fresh' } as any,
  genJobs: previewJobs as any,
});

function completePreviewGeneration() {
  useStore.setState(state => ({ genJobs: { ...state.genJobs, 'preview-job-0': { ...state.genJobs['preview-job-0'], running: false,
    turns: state.genJobs['preview-job-0'].turns.map(turn => ({ ...turn, images: ['preview-result.webp'] })) } } }));
  void emitPreviewGenerationNotice({ onOpen: () => { w.openedPreviewTask = 'preview-job-0'; } });
}

export function ScrollbarGallery({ onClose }: { onClose: () => void }) {
  return <section className="preview-scroll-gallery" aria-label="滚动条演示">
    <header><span>滚动条演示</span><button onClick={onClose} aria-label="关闭滚动条演示">×</button></header>
    <div className="preview-scroll-columns">
      <div className="preview-scroll-list" tabIndex={0} aria-label="纵向滚动区域">
        {Array.from({ length: 32 }, (_, index) => <div key={index}><span>{String(index + 1).padStart(2, '0')}</span><span>{['山野品牌 / 视觉方向', '旅行分镜 / 山间清晨', '咖啡包装 / 纸张与油墨', '秋日海报 / 色彩提案'][index % 4]}</span></div>)}
      </div>
      <div className="preview-scroll-mixed">
        <div className="preview-scroll-grid" tabIndex={0} aria-label="双向滚动区域"><div>{Array.from({ length: 80 }, (_, index) => <span key={index}>{String(index + 1).padStart(2, '0')}</span>)}</div></div>
        <textarea aria-label="文本滚动区域" defaultValue={Array.from({ length: 20 }, (_, index) => `镜头 ${index + 1}：午后的光落在纸张上，保留自然纹理与柔和的阴影。`).join('\n')}/>
      </div>
    </div>
  </section>;
}

function Preview() {
  const view = useStore(state => state.libraryHomeView);
  const [gallery, setGallery] = useState(false);
  const [theme, setTheme] = useState('dark');
  const changeTheme = () => { const next = theme === 'dark' ? 'light' : 'dark'; setTheme(next); document.documentElement.dataset.theme = next; };
  w.openScrollbarGallery = () => setGallery(true);
  w.emitPreviewGenerationNotice = emitPreviewGenerationNotice;
  return <div className="notifications-preview-shell">
    <div className="app-shell notifications-preview-app">
      <Toolbar canvasMode={false} localFilesOpen onRefresh={async () => {}} onCanvasModeChange={() => {}} onExplore={() => {}}/>
      <main className="notifications-preview-main">
        {view === 'library' ? <><LibraryHome/><LibraryComposer/></> : <ProjectManagerPanel active onCreate={() => {}}/>}
        {gallery && <ScrollbarGallery onClose={() => setGallery(false)}/>}
      </main>
    </div>
    <footer className="notifications-preview-controls" data-preview-controls>
      <button onClick={completePreviewGeneration}>模拟完成</button>
      <button onClick={() => notify('素材已复制', 'success')}>普通提示</button>
      <button onClick={changeTheme}>{theme === 'dark' ? '切换浅色' : '切换深色'}</button>
      <button aria-pressed={gallery} onClick={() => setGallery(value => !value)}>滚动演示</button>
    </footer>
    <PreviewToastViewport/>
    <PreviewScrollbars/>
  </div>;
}

createRoot(document.getElementById('root')!).render(<Preview/>);
