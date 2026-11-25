import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { createLibraryPane, LibraryPaneContext, libraryHasOverlay, registerLibraryPane, useActiveLibraryPane } from "../lib/libraryPane";
import { libraryShortcutMode } from "../lib/localFileMode";
import { notifyError } from "../lib/notify";
import type { ExploreCaptureReceipt } from "../lib/exploreCaptureOrder";
import { useStore } from "../store";
import { LibraryCatalog } from "./LibraryCatalog";
import "./ExploreLibrary.css";

export function ExploreLibrary({ active = true, middleOpen, sidebarOpen, dockOpen, onCloseMiddle, onToggleSidebar, onOpenProject, onCreateProject, captureReceipts }: {
  active?: boolean;
  middleOpen: boolean;
  sidebarOpen: boolean;
  dockOpen: boolean;
  onCloseMiddle: () => void;
  onToggleSidebar: () => void;
  onOpenProject?: (id: string) => void | Promise<unknown>;
  onCreateProject?: (ids?: string[]) => Promise<unknown>;
  captureReceipts?: readonly ExploreCaptureReceipt[];
}) {
  const [pane] = useState(() => createLibraryPane("explore"));
  const [previewTag, setPreviewTag] = useState<string>();
  useEffect(() => {
    if (!active) return;
    const unregister = registerLibraryPane(pane);
    useActiveLibraryPane.getState().activate(pane);
    return () => {
      unregister();
      if (useActiveLibraryPane.getState().pane === pane) useActiveLibraryPane.getState().activate(null);
    };
  }, [active, pane]);
  async function openProject(id: string) {
    if (!active || useStore.getState().projectRoutePending) return;
    try { await onOpenProject?.(id); }
    catch (error) { notifyError(error, "无法打开项目，请重试"); }
  }
  return <div className="explore-library library-browser library-tactical" data-explore-library data-library-pane={pane.id} hidden={!active}
    onKeyDownCapture={event => {
      const mode = libraryShortcutMode(event.key), target = event.target as HTMLElement;
      if (!active || !mode || event.defaultPrevented || event.repeat || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey
        || event.nativeEvent.isComposing || target.isContentEditable || target.closest('input,textarea,select,[role="combobox"]')
        || libraryHasOverlay(event.currentTarget) || useStore.getState().projectRoutePending) return;
      event.preventDefault(); event.stopPropagation(); pane.mode.getState().setSidebarMode(mode);
    }}>
    <LibraryPaneContext.Provider value={pane}>
      {active && <LibraryCatalog media="all" positionId={pane.id} onClose={onCloseMiddle} onCreateProject={onCreateProject}
        explore={{ middleOpen, directoryOpen: sidebarOpen || dockOpen, onCloseDirectory: onToggleSidebar,
          onOpenProject: onOpenProject ? id => void openProject(id) : undefined, captureReceipts, previewTag, onSelectTag: setPreviewTag,
          heading: (name, count, projectId) => <div className="explore-library-heading">
            <div className="explore-library-scope"><strong title={name}>{name}</strong><span aria-label={`${count} 项`}>{count}</span></div>
            {projectId && onOpenProject && <button type="button" onClick={() => void openProject(projectId)}>进画板</button>}
            <button type="button" onClick={onCloseMiddle} title="关闭素材流" aria-label="关闭素材流"><X size={15} aria-hidden="true"/></button>
          </div> }} />}
    </LibraryPaneContext.Provider>
  </div>;
}
