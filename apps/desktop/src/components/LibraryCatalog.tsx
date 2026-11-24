import { useState, type ComponentProps } from "react";
import { CategorizedLibrary } from "./CategorizedLibrary";
import { ConnectedCollections } from "./ConnectedCollections";
import { LibrarySidebar } from "./LibrarySidebar";
import { useLibraryModeStore } from "../lib/libraryPane";
import { useStore } from "../store";

type Props = Omit<ComponentProps<typeof CategorizedLibrary>, "kind" | "browseProjectId" | "projectScope" | "overviewProjects" | "sidebarBody">;

export function LibraryCatalog(props: Props) {
  const mode = useLibraryModeStore();
  const sidebarMode = mode(s => s.sidebarMode), target = mode(s => s.hierarchyTarget);
  const context = mode(s => s.contextProjectId);
  const projects = useStore(s => s.projects);
  const available = projects.filter(project => !project.archived_at && (!project.provisional || project.id === context));
  const [sidebarBody, setSidebarBody] = useState<HTMLDivElement | null>(null);
  const [foldersExpanded, setFoldersExpanded] = useState(true);
  const tags = sidebarMode === "tags";
  const folderView = !tags && target.kind === "folders";
  const projectView = !tags && target.kind === "projects";
  const project = projectView ? available.find(item => item.id === target.projectId) : undefined;
  return <div className="library-catalog library-tactical">
    <LibrarySidebar projects={available} bodyRef={setSidebarBody} contextProjectId={context}/>
    <div className="library-catalog-content">
      {!folderView && <CategorizedLibrary key={JSON.stringify([sidebarMode, projectView, project?.id, props.media])}
        {...props} kind={tags ? "tags" : "all"} browseProjectId={project?.id ?? null} projectScope={projectView}
        overviewProjects={projectView && !project ? available : undefined} sidebarBody={tags ? sidebarBody : null}/>}
      {!tags && <ConnectedCollections {...props} sidebarBody={sidebarBody} showGallery={folderView}
        foldersExpanded={foldersExpanded} onFoldersExpandedChange={setFoldersExpanded}
        selectedFolderId={target.kind === "folders" ? target.folderId : null} key={props.media}/>}
    </div>
  </div>;
}
