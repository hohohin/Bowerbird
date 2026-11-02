import './fixture';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowLeft, Compass, Images, LayoutDashboard, Link2 } from 'lucide-react';
import { LibraryHome } from '../../../src/components/LibraryHome';
import { SidebarAccount } from '../../../src/components/SidebarAccount';
import { ProjectContextMenu } from '../../../src/components/ProjectContextMenu';
import { PreservedWorkspace } from '../../../src/components/PreservedWorkspace';
import { useStore } from '../../../src/store';
import { createPreviewProject } from './fixture';
import { ProjectsPreview } from './ProjectsPreview';
import '../../../src/styles.css';
import '../../../src/components/LocalFileWorkspace.css';
import '../../../src/components/LibraryTactical.css';
import '../../../src/components/IndustrialTheme.css';
import '../../../src/components/IndustrialMenus.css';
import './preview.css';

function Preview() {
  const [view, setView] = useState<'library' | 'projects'>('library');
  const [visitedProjects, setVisitedProjects] = useState(false);
  const [canvas, setCanvas] = useState(false);
  const project = useStore(s => s.projects.find(p => p.id === s.activeProjectId));
  function navigate(next: typeof view) {
    useStore.getState().closeContextMenu(); useStore.getState().closeProjectContextMenu();
    setView(next); if (next === 'projects') setVisitedProjects(true);
  }
  return <div className="app-shell home-navigation-preview flex h-full w-full flex-col">
    <header className="app-topbar is-search-hidden is-library library-tactical is-global-materials">
      <div className="app-topbar-leading">
        {canvas && <button className="app-button-dark" aria-label="返回主页" onClick={() => setCanvas(false)}><ArrowLeft size={15}/><span>返回主页</span></button>}
        {!canvas && view === 'library' && <div className="home-library-actions">
          <button className="app-button-dark" title="预览中的文件选择已隔离" onClick={() => {}}><Link2 size={15}/><span>建立连接</span></button>
          <button className="app-button-dark" title="预览不连接外部网站" onClick={() => {}}><Compass size={15}/><span>探索</span></button>
        </div>}
      </div>
      {!canvas && <nav aria-label="首页" className="home-page-navigation">
        <button type="button" aria-current={view === 'library' ? 'page' : undefined} onClick={() => navigate('library')}><Images size={15}/><span>素材库</span></button>
        <button type="button" aria-current={view === 'projects' ? 'page' : undefined} onClick={() => navigate('projects')}><LayoutDashboard size={15}/><span>项目</span></button>
      </nav>}
      <div className="app-topbar-actions"><SidebarAccount placement="topbar"/></div>
    </header>
    <main className="app-workspace relative flex min-h-0 flex-1 flex-col overflow-hidden bg-canvas">
      <div className="home-preview-surface" data-suspended={canvas || view !== 'library'}><PreservedWorkspace suspended={canvas || view !== 'library'}><LibraryHome shortcutsEnabled={!canvas && view === 'library'}/></PreservedWorkspace></div>
      {visitedProjects && <div className="home-preview-surface" data-suspended={canvas || view !== 'projects'}><PreservedWorkspace suspended={canvas || view !== 'projects'}><ProjectsPreview active={!canvas && view === 'projects'} onCreate={() => { createPreviewProject(); setCanvas(true); }} onOpen={() => setCanvas(true)}/></PreservedWorkspace></div>}
      {canvas && <section aria-label="项目画布预览" className="home-canvas-preview"><h1>{project?.name}</h1><p>项目画布预览</p></section>}
    </main>
    <ProjectContextMenu/>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
