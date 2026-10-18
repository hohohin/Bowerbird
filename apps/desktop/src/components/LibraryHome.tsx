import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { MasonryGrid } from "./MasonryGrid";
import { ProjectFolder } from "./ProjectFolder";
import { ThumbnailSizeSlider } from "./ThumbnailSizeSlider";
import { useThumbnailPinch } from "../lib/useThumbnailPinch";
import { OverlayScrollArea } from "./CollectionScrollArea";
import { LibraryViewSwitch } from "./LibraryViewSwitch";
import { LibraryTagBar } from "./LibraryTagBar";
import { LibraryFilterButton } from "./LibraryFilterButton";
import { LocalFileWorkspace } from "./LocalFileWorkspace";
import { PreservedWorkspace } from "./PreservedWorkspace";
import { useLocalFileMode } from "../lib/localFileMode";
import { useLibraryTabOrder, type LibraryTab } from "../lib/libraryTabOrder";
import { useMasonryLayout } from "../lib/useMasonryLayout";

export function LibraryHome({ onCreateProject, shortcutsEnabled = true }: { onCreateProject?: () => Promise<unknown>; shortcutsEnabled?: boolean } = {}) {
  const homeRef = useRef<HTMLDivElement>(null);
  const [projectGrid, setProjectGrid] = useState<HTMLDivElement | null>(null);
  const thumbnailWidth = useStore(s => s.libraryThumbnailWidth);
  const filesOpen = useLocalFileMode(s => s.open);
  useEffect(() => { if (useStore.getState().libraryHomeView === "library") useLocalFileMode.getState().setOpen(true); }, []);
  const setFilesOpen = useLocalFileMode(s => s.setOpen);
  const order = useLibraryTabOrder(s => s.order);
  const setOrder = useLibraryTabOrder(s => s.setOrder);
  const pinchRef = useThumbnailPinch("library");
  const assets = useStore(s => s.assets);
  const projects = useStore(s => s.projects);
  const memberships = useStore(s => s.libraryMemberships);
  const view = useStore(s => s.libraryHomeView);
  const setView = useStore(s => s.setLibraryHomeView);
  const search = useStore(s => s.searchQuery);
  const total = useStore(s => s.total);
  const groups = useMemo(() => {
    const byId = new Map(assets.map(asset => [asset.id, asset]));
    return projects.filter(project => !project.provisional && !project.archived_at
      && project.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).map(project => ({
      project,
      assets: memberships.filter(member => member.projectId === project.id)
        .flatMap(member => { const asset = byId.get(member.assetId); return asset ? [asset] : []; }),
    }));
  }, [assets, projects, memberships, search]);
  useMasonryLayout(projectGrid, thumbnailWidth, groups);
  function changeSource(value: string) {
    setFilesOpen(value === "files");
    if (value !== "files") setView(value === "project" ? "projects" : "library");
  }
  useEffect(() => {
    function cycleSource(event: KeyboardEvent) {
      const state = useStore.getState();
      if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey || event.repeat
        || event.defaultPrevented || !shortcutsEnabled || homeRef.current?.closest("[inert]")
        || state.projectRoutePending || state.contextMenu || state.projectContextMenu
        || document.querySelector('[role="dialog"], [role="menu"]')) return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || target?.closest('input, textarea, select')) return;
      event.preventDefault(); event.stopPropagation();
      const current = useLocalFileMode.getState().open ? "files" : view === "projects" ? "project" : "files";
      changeSource(order[(order.indexOf(current) + (event.shiftKey ? -1 : 1) + order.length) % order.length]);
      requestAnimationFrame(() => homeRef.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true }));
    }
    window.addEventListener("keydown", cycleSource, true);
    return () => window.removeEventListener("keydown", cycleSource, true);
  }, [shortcutsEnabled, view, order]);
  const navigation = <header className="library-browser-heading">
      <div className="library-floating-navigation">
      <LibraryViewSwitch value={filesOpen ? "files" : view === "projects" ? "project" : "files"} onChange={changeSource}
      onReorder={setOrder} label="主页视图" options={order.map(value => ({ value,
        label: ({ project: "项目管理", files: "文件" } satisfies Record<LibraryTab, string>)[value] }))} />
      {!filesOpen && view === "library" && <LibraryFilterButton />}
      </div>
    </header>;
  return <div ref={homeRef} className="library-home library-browser">
    {filesOpen && <LocalFileWorkspace navigation={navigation} onClose={() => setFilesOpen(false)} onCreateProject={onCreateProject} onLegacy={() => { setFilesOpen(false); setView("library"); }} />}
    <PreservedWorkspace suspended={filesOpen}>
    {view === "projects" ? <div ref={pinchRef} className="library-browser-grid">
      {navigation}
      <OverlayScrollArea className="library-browser-scroll" viewportClassName="library-project-page">
      {groups.length ? <div ref={setProjectGrid} className="masonry-layout library-project-grid">{groups.map(group => <div className="masonry-cell" key={group.project.id}><ProjectFolder group={group} /></div>)}</div>
        : <div className="library-page-empty">{search ? "没有匹配的项目" : "还没有项目，创建一个开始创作"}</div>}
      </OverlayScrollArea>
      <ThumbnailSizeSlider scope="library" />
    </div> : <>
      <div className="folder-scope-bar"><button onClick={() => setFilesOpen(true)}>返回文件浏览</button><span>历史素材 · 原有资料与创作关系保留</span></div>
      <LibraryTagBar />
      <div ref={pinchRef} className="library-browser-grid">
        {navigation}
        <MasonryGrid restrictGroupsToAssets assetsOverride={assets} totalOverride={total} projectScopeId={null} />
      </div>
      <ThumbnailSizeSlider scope="library" />
    </>}
    </PreservedWorkspace>
  </div>;
}
