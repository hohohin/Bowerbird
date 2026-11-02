import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { notifyError } from "../lib/notify";
import { LibraryHome } from "./LibraryHome";
import { ProjectManagerPanel } from "./ProjectManagerPanel";
import { PreservedWorkspace } from "./PreservedWorkspace";
import "./HomeWorkspace.css";
import { LibraryComposer } from "./LibraryComposer";
import { registerLibraryLocalVideo } from "../lib/libraryGenerationRuntime";
import "./LibraryHomeGeneration.css";

export function HomeWorkspace({ active = true, shortcutsEnabled = true, onCreateProject }: {
  active?: boolean; shortcutsEnabled?: boolean; onCreateProject: (assetIds?: string[]) => Promise<unknown>;
}) {
  const view = useStore(s => s.libraryHomeView);
  const [visitedProjects, setVisitedProjects] = useState(view === "projects");
  const creating = useRef(false);
  const libraryPage = useRef<HTMLDivElement>(null);
  useEffect(() => { if (active && view === "projects") setVisitedProjects(true); }, [active, view]);
  async function createProject() {
    if (creating.current || useStore.getState().projectRoutePending) return;
    creating.current = true;
    try { await onCreateProject(); }
    catch (error) { notifyError(error, "无法新建项目，请重试"); }
    finally { creating.current = false; }
  }
  const libraryActive = active && view === "library";
  const projectsActive = active && view === "projects";
  useEffect(() => {
    const page = libraryPage.current;
    const composer = page?.querySelector<HTMLElement>(".library-composer");
    if (!libraryActive || !page || !composer) return;
    const update = () => page.style.setProperty("--library-composer-height", `${Math.ceil(composer.getBoundingClientRect().height)}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(composer);
    return () => { observer.disconnect(); page.style.removeProperty("--library-composer-height"); };
  }, [libraryActive]);
  return <div className="home-workspace">
    <div ref={libraryPage} className="home-workspace-page library-generation-page" data-suspended={!libraryActive}>
      <PreservedWorkspace suspended={!libraryActive}>
        {active && <LibraryHome active={libraryActive} onCreateProject={onCreateProject} shortcutsEnabled={shortcutsEnabled}/>}
        {libraryActive && <LibraryComposer onLocalVideoStarted={registerLibraryLocalVideo}/>}
      </PreservedWorkspace>
    </div>
    {visitedProjects && <div className="home-workspace-page" data-suspended={!projectsActive}>
      <PreservedWorkspace suspended={!projectsActive}>
        <ProjectManagerPanel active={projectsActive && shortcutsEnabled} onCreate={() => void createProject()}/>
      </PreservedWorkspace>
    </div>}
  </div>;
}
