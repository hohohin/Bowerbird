import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { LayoutGrid, List, Plus, Search } from "lucide-react";
import { api } from "../lib/api";
import type { LibraryView } from "../lib/libraryView";
import { useStore } from "../store";
import { useLocalFileMode } from "../lib/localFileMode";
import { useThumbnailPinch } from "../lib/useThumbnailPinch";
import { ModalShell } from "./ModalShell";
import { ProjectFolder } from "./ProjectFolder";
import { ThumbnailSizeSlider } from "./ThumbnailSizeSlider";
import { OverlayScrollArea } from "./CollectionScrollArea";
import "./ProjectManagerPanel.css";

export function ProjectManagerPanel({ onClose, onCreate }: { onClose: () => void; onCreate: () => void }) {
  const projects = useStore(s => s.projects);
  const [search, setSearch] = useState("");
  const [library, setLibrary] = useState<LibraryView | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [view, setView] = useState<"grid" | "list">("grid");
  const [sort, setSort] = useState("recent");
  const width = useStore(s => s.projectsThumbnailWidth);
  const pinchRef = useThumbnailPinch("projects");
  const contextMenu = useStore(s => s.projectContextMenu);
  const visibleProjects = useMemo(() => projects.filter(p => !p.provisional && !p.archived_at), [projects]);
  useEffect(() => {
    let current = true;
    setError("");
    void api.listLibraryView({}).then(value => { if (current) setLibrary(value); })
      .catch(e => { if (current) setError(String(e)); });
    return () => { current = false; };
  }, [revision, projects]);
  const groups = useMemo(() => {
    const byId = new Map(library?.assets.map(asset => [asset.id, asset]) ?? []);
    return visibleProjects.filter(p => p.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
      .sort((a, b) => sort === "name" ? a.name.localeCompare(b.name, "zh-CN") : (b.updated_at ?? b.created_at) - (a.updated_at ?? a.created_at))
      .map(project => ({ project, assets: (library?.memberships ?? []).filter(m => m.projectId === project.id)
        .flatMap(m => { const asset = byId.get(m.assetId); return asset ? [asset] : []; }) }));
  }, [visibleProjects, library, search, sort]);
  return <ModalShell title="项目管理" width="lg" className="project-manager-panel" preventClose={!!contextMenu}
    description={<span className="project-manager-count">{visibleProjects.length} 个项目</span>}
    onClose={() => { if (document.querySelectorAll('[role="dialog"]').length === 1) onClose(); }}
    headerActions={<button className="app-button-accent" onClick={() => { onClose(); onCreate(); }}><Plus size={17} aria-hidden="true"/>新建项目</button>}
    footer={<><span className="project-manager-hint">点击项目进入画板</span><ThumbnailSizeSlider scope="projects" appearance="project-manager"/></>}>
    <div className="project-manager-toolbar">
      <div className="project-manager-search"><Search size={18} aria-hidden="true"/><input data-modal-autofocus aria-label="搜索项目" placeholder="搜索项目…" value={search} onChange={e => setSearch(e.target.value)}/></div>
      <select aria-label="项目排序" value={sort} onChange={e => setSort(e.target.value)}><option value="recent">最近更新</option><option value="name">项目名称</option></select>
      <div className="project-manager-views" role="group" aria-label="项目展示方式">
        <button type="button" aria-label="网格视图" title="网格视图" aria-pressed={view === "grid"} onClick={() => setView("grid")}><LayoutGrid size={18}/></button>
        <button type="button" aria-label="列表视图" title="列表视图" aria-pressed={view === "list"} onClick={() => setView("list")}><List size={18}/></button>
      </div>
    </div>
    {error && <p className="project-manager-error" role="alert">项目封面加载失败 <button onClick={() => setRevision(r => r + 1)}>重试</button></p>}
    <div ref={pinchRef} className="project-manager-gallery">
      <OverlayScrollArea className="library-browser-scroll" viewportClassName="library-project-page">
        {groups.length ? <div className={`project-manager-grid is-${view}`} style={{ "--project-card-width": `${width + 160}px` } as CSSProperties}>{groups.map(group =>
          <ProjectFolder key={group.project.id} group={group} detailed onOpen={() => { useStore.getState().setCanvasLibraryOpen(false); useLocalFileMode.getState().setOpen(false); onClose(); }}/>
        )}</div> : <div className="library-page-empty">{search ? "没有匹配的项目" : "还没有项目，创建一个开始创作"}</div>}
      </OverlayScrollArea>
    </div>
  </ModalShell>;
}
