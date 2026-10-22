import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { LibrarySourceTabs } from "./LibrarySourceTabs";
import { LibraryCatalogTransition } from "./LibraryCatalogTransition";
import { LocalFileWorkspace } from "./LocalFileWorkspace";
import { useLocalFileMode } from "../lib/localFileMode";

export function LibraryHome({ onCreateProject, shortcutsEnabled = true }: { onCreateProject?: (assetIds?: string[]) => Promise<unknown>; shortcutsEnabled?: boolean } = {}) {
  const homeRef = useRef<HTMLDivElement>(null);
  const mode = useLocalFileMode(s => s.mode);
  const media = useLocalFileMode(s => s.media);
  useEffect(() => {
    useStore.getState().setLibraryHomeView("library");
    useLocalFileMode.getState().openSource("global");
  }, []);
  useEffect(() => {
    function cycleView(event: KeyboardEvent) {
      const state = useStore.getState();
      if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.isComposing
        || event.defaultPrevented || !shortcutsEnabled || homeRef.current?.closest("[inert]")
        || state.projectRoutePending || state.contextMenu || state.projectContextMenu
        || document.querySelector('[role="dialog"], [role="menu"]')) return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || target?.closest('input, textarea, select, .app-topbar')) return;
      event.preventDefault(); event.stopPropagation();
      useLocalFileMode.getState().toggleCatalog();
      requestAnimationFrame(() => homeRef.current?.focus({ preventScroll: true }));
    }
    window.addEventListener("keydown", cycleView, true);
    return () => window.removeEventListener("keydown", cycleView, true);
  }, [shortcutsEnabled]);
  const navigation = <header className="library-browser-heading"><div className="library-floating-navigation">
    <LibrarySourceTabs value="global" onChange={() => useLocalFileMode.getState().openSource("global")} />
  </div></header>;
  return <div ref={homeRef} tabIndex={-1} className="library-home library-browser">
    {mode === "all" || mode === "tags" || mode === "collections"
      ? <LibraryCatalogTransition key={media} kind={mode} media={media} navigation={navigation} onClose={() => useLocalFileMode.getState().setOpen(false)} onCreateProject={onCreateProject}/>
      : <LocalFileWorkspace navigation={navigation} onClose={() => useLocalFileMode.getState().closeBrowser()} onCreateProject={onCreateProject}/>}
  </div>;
}
