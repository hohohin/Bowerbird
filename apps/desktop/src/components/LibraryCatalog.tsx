import { useCallback, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { CategorizedLibrary, type CatalogPreview } from "./CategorizedLibrary";
import { ConnectedCollections } from "./ConnectedCollections";
import { LibrarySidebar } from "./LibrarySidebar";
import { LocalClassificationDialog } from "./LocalClassificationDialog";
import type { CatalogJump } from "./VirtualCatalog";
import { useLibraryModeStore } from "../lib/libraryPane";
import { invalidateCatalog } from "../lib/useCatalogRevision";
import { useStore } from "../store";

type Props = Omit<ComponentProps<typeof CategorizedLibrary>, "kind" | "browseProjectId" | "projectScope" | "overviewProjects" | "sidebarBody" | "labelToLocate" | "onLabelLocated" | "onManageTags" | "catalogPreview"> & {
  explore?: {
    middleOpen: boolean;
    directoryOpen: boolean;
    onCloseDirectory: () => void;
    onOpenProject?: (id: string) => void;
    heading: CatalogPreview["heading"];
    captureReceipts?: CatalogPreview["captureReceipts"];
    previewTag?: string;
    onSelectTag: (id: string) => void;
  };
};
type LabelAction = ComponentProps<typeof LocalClassificationDialog>["initialLabelAction"];

export function LibraryCatalog({ explore, ...props }: Props) {
  const mode = useLibraryModeStore();
  const sidebarMode = mode(s => s.sidebarMode), target = mode(s => s.hierarchyTarget);
  const context = mode(s => s.contextProjectId);
  const projects = useStore(s => s.projects);
  const available = projects.filter(project => !project.archived_at && (!project.provisional || project.id === context));
  const [sidebarBody, setSidebarBody] = useState<HTMLDivElement | null>(null);
  const [foldersExpanded, setFoldersExpanded] = useState(true);
  const [tagsExpanded, setTagsExpanded] = useState(true);
  const [manager, setManager] = useState<{ projectId?: string; labelAction?: LabelAction } | null>(null);
  const [labelToLocate, setLabelToLocate] = useState<CatalogJump | null>(null);
  const middle = useRef<HTMLDivElement>(null);
  const middleOpen = explore?.middleOpen;
  useLayoutEffect(() => {
    if (middle.current && middleOpen !== undefined) middle.current.inert = !middleOpen;
  }, [middleOpen]);
  const clearLabelToLocate = useCallback((located: CatalogJump) => {
    setLabelToLocate(current => current === located ? null : current);
  }, []);
  const tags = sidebarMode === "tags";
  const folderView = !tags && target.kind === "folders";
  const projectView = !tags && target.kind === "projects";
  const project = projectView ? available.find(item => item.id === target.projectId) : undefined;
  const preview = explore ? { show: explore.middleOpen, heading: explore.heading, captureReceipts: explore.captureReceipts,
    tagId: explore.previewTag, onSelectTag: explore.onSelectTag } : undefined;
  function openTagManager(labelAction?: LabelAction) {
    setManager({ projectId: project?.id, labelAction });
  }
  return <div className="library-catalog library-tactical">
    <LibrarySidebar projects={available} bodyRef={setSidebarBody} contextProjectId={context}
      explore={explore ? { open: explore.directoryOpen, onClose: explore.onCloseDirectory, onOpenProject: explore.onOpenProject } : undefined}
      tagsExpanded={tagsExpanded} onToggleTags={() => setTagsExpanded(expanded => !expanded)} onManageTags={openTagManager}/>
    <div ref={middle} id={explore ? "explore-material-stream" : undefined} className="library-catalog-content"
      data-explore-middle={explore ? "" : undefined} data-explore-middle-open={middleOpen} aria-hidden={middleOpen === false || undefined}>
      {!folderView && <CategorizedLibrary key={JSON.stringify([sidebarMode, projectView, project?.id, props.media])}
        {...props} kind={tags ? "tags" : "all"} browseProjectId={project?.id ?? null} projectScope={projectView}
        overviewProjects={projectView && !project ? available : undefined} sidebarBody={tags ? sidebarBody : null}
        labelToLocate={labelToLocate} onLabelLocated={clearLabelToLocate} onManageTags={openTagManager} catalogPreview={preview}/>}
      {!tags && <ConnectedCollections {...props} sidebarBody={sidebarBody} showGallery={folderView}
        catalogPreview={preview}
        foldersExpanded={foldersExpanded} onFoldersExpandedChange={setFoldersExpanded}
        selectedFolderId={target.kind === "folders" ? target.folderId : null} key={props.media}/>}
    </div>
    {manager && <LocalClassificationDialog initialView="labels" projectId={manager.projectId} initialLabelAction={manager.labelAction}
      onNavigateToLabel={({ id }) => {
        const actions = mode.getState();
        actions.setSidebarMode("tags");
        actions.setQuery("");
        actions.setSidebarCollapsed(false);
        setTagsExpanded(true);
        if (explore) explore.onSelectTag(id); else setLabelToLocate({ id });
      }}
      onClose={() => { setManager(null); invalidateCatalog(); }}/>}
  </div>;
}
