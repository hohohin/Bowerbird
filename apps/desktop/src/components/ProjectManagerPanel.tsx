import { useEffect, useMemo, useState } from "react";
import { Plus, Search } from "lucide-react";
import { api } from "../lib/api";
import type { LibraryView } from "../lib/libraryView";
import { useStore } from "../store";
import { useLocalFileMode } from "../lib/localFileMode";
import { useMasonryLayout } from "../lib/useMasonryLayout";
import { useThumbnailPinch } from "../lib/useThumbnailPinch";
import { ModalShell } from "./ModalShell";
import { ProjectFolder } from "./ProjectFolder";
import { ThumbnailSizeSlider } from "./ThumbnailSizeSlider";
import { OverlayScrollArea } from "./CollectionScrollArea";

export function ProjectManagerPanel({ onClose, onCreate }: { onClose: () => void; onCreate: () => void }) {
  const projects = useStore(s => s.projects);
  const [search, setSearch] = useState("");
  const [library, setLibrary] = useState<LibraryView | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [grid, setGrid] = useState<HTMLDivElement | null>(null);
  const width = useStore(s => s.projectsThumbnailWidth);
  const pinchRef = useThumbnailPinch("projects");
  const contextMenu = useStore(s => s.projectContextMenu);
  useEffect(() => {
    let current = true;
    setError("");
    void api.listLibraryView({}).then(value => { if (current) setLibrary(value); })
      .catch(e => { if (current) setError(String(e)); });
    return () => { current = false; };
  }, [revision, projects]);
  const groups = useMemo(() => {
    const byId = new Map(library?.assets.map(asset => [asset.id, asset]) ?? []);
    return projects.filter(p => !p.provisional && !p.archived_at && p.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
      .map(project => ({ project, assets: (library?.memberships ?? []).filter(m => m.projectId === project.id)
        .flatMap(m => { const asset = byId.get(m.assetId); return asset ? [asset] : []; }) }));
  }, [projects, library, search]);
  useMasonryLayout(grid, width, groups);
  return <ModalShell title="项目管理" width="lg" className="project-manager-panel" preventClose={!!contextMenu}
    onClose={() => { if (document.querySelectorAll('[role="dialog"]').length === 1) onClose(); }}
    headerActions={<button className="app-button-accent" onClick={() => { onClose(); onCreate(); }}><Plus size={15}/>新建项目</button>}>
    <div className="project-manager-search"><Search size={16}/><input data-modal-autofocus aria-label="搜索项目" placeholder="搜索项目…" value={search} onChange={e => setSearch(e.target.value)}/></div>
    {error && <p role="alert">项目封面加载失败 <button onClick={() => setRevision(r => r + 1)}>重试</button></p>}
    <div ref={pinchRef} className="project-manager-gallery">
      <OverlayScrollArea className="library-browser-scroll" viewportClassName="library-project-page">
        {groups.length ? <div ref={setGrid} className="masonry-layout library-project-grid">{groups.map(group => <div className="masonry-cell" key={group.project.id}>
          <ProjectFolder group={group} onOpen={() => { useStore.getState().setCanvasLibraryOpen(false); useLocalFileMode.getState().setOpen(false); onClose(); }}/>
        </div>)}</div> : <div className="library-page-empty">{search ? "没有匹配的项目" : "还没有项目，创建一个开始创作"}</div>}
      </OverlayScrollArea>
      <ThumbnailSizeSlider scope="projects"/>
    </div>
  </ModalShell>;
}
