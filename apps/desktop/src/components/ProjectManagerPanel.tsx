import { TacticalSelect } from "./TacticalSelect";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { LayoutGrid, List, Plus, Search } from "lucide-react";
import { api } from "../lib/api";
import type { LibraryView } from "../lib/libraryView";
import { useStore } from "../store";
import { useThumbnailPinch } from "../lib/useThumbnailPinch";
import { ProjectFolder } from "./ProjectFolder";
import { ThumbnailSizeSlider } from "./ThumbnailSizeSlider";
import { OverlayScrollArea } from "./CollectionScrollArea";
import { ProjectManagerBackdrop } from "./ProjectManagerBackdrop";
import "./ProjectManagerPanel.css";

export function ProjectManagerPanel({ active, onCreate, onOpen }: { active: boolean; onCreate: () => void; onOpen?: () => void }) {
  const projects = useStore(s => s.projects);
  const projectRoutePending = useStore(s => s.projectRoutePending);
  const [search, setSearch] = useState("");
  const [library, setLibrary] = useState<LibraryView | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [view, setView] = useState<"grid" | "list">("grid");
  const [sort, setSort] = useState("recent");
  const width = useStore(s => s.projectsThumbnailWidth);
  const pinchRef = useThumbnailPinch("projects");
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
  return <section aria-label="项目管理" className="project-manager-panel home-projects-page">
    {active && <ProjectManagerBackdrop />}
    <aside className="project-manager-index" aria-label="项目目录">
      <span className="project-manager-count" aria-label={`${visibleProjects.length} 个项目`}>{String(visibleProjects.length).padStart(2, "0")}</span>
      <span className="project-manager-index-caption">个项目</span>
      <div className="project-manager-views" role="group" aria-label="项目展示方式">
        <button type="button" aria-label="网格视图" title="网格视图" aria-pressed={view === "grid"} onClick={() => setView("grid")}><LayoutGrid size={16} aria-hidden="true"/><span>网格浏览</span></button>
        <button type="button" aria-label="列表视图" title="列表视图" aria-pressed={view === "list"} onClick={() => setView("list")}><List size={16} aria-hidden="true"/><span>列表浏览</span></button>
      </div>
    </aside>
    <div className="project-manager-main"><div className="project-manager-toolbar">
      <div className="project-manager-search"><Search size={18} aria-hidden="true"/><input aria-label="搜索项目" placeholder="搜索项目…" value={search} onChange={e => setSearch(e.target.value)}/></div>
      <TacticalSelect aria-label="项目排序" value={sort} disabled={!active || projectRoutePending} onValueChange={value => setSort(value)}><option value="recent">最近更新</option><option value="name">项目名称</option></TacticalSelect>
      <button type="button" className="project-manager-create" disabled={projectRoutePending} onClick={onCreate}><Plus size={17} aria-hidden="true"/>新建项目</button>
    </div>
    {error && <p className="project-manager-error" role="alert">项目封面加载失败 <button type="button" onClick={() => setRevision(r => r + 1)}>重试</button></p>}
    <div ref={pinchRef} className="project-manager-gallery">
      <OverlayScrollArea className="library-browser-scroll" viewportClassName="library-project-page" label="项目滚动条">
        {groups.length ? <div className={`project-manager-grid is-${view}`} style={{ "--project-card-width": `${width + 100}px` } as CSSProperties}>{groups.map((group, index) =>
          <div key={group.project.id} className="project-manager-slot" onPointerMove={event => {
            if (event.pointerType !== "mouse") return;
            const slot = event.currentTarget, bounds = slot.getBoundingClientRect();
            const x = (event.clientX - bounds.left) / bounds.width, y = (event.clientY - bounds.top) / bounds.height;
            slot.style.setProperty("--pm-tilt-x", `${((.5 - y) * 7).toFixed(2)}deg`);
            slot.style.setProperty("--pm-tilt-y", `${((x - .5) * 7).toFixed(2)}deg`);
            slot.style.setProperty("--pm-pointer-x", `${x * 100}%`);
            slot.style.setProperty("--pm-pointer-y", `${y * 100}%`);
          }} onPointerLeave={event => event.currentTarget.removeAttribute("style")}>
            <ProjectFolder group={group} detailed serial={index + 1} onOpen={onOpen}/>
          </div>
        )}</div> : <div className="library-page-empty">{search ? "没有匹配的项目" : "还没有项目，创建一个开始创作"}</div>}
      </OverlayScrollArea>
    </div>
    <footer className="home-projects-footer"><ThumbnailSizeSlider scope="projects" appearance="project-manager"/></footer>
    </div>
  </section>;
}
