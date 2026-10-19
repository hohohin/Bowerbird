import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { MasonryGrid } from "./MasonryGrid";
import { ThumbnailSizeSlider } from "./ThumbnailSizeSlider";
import { useThumbnailPinch } from "../lib/useThumbnailPinch";
import { LibraryViewSwitch } from "./LibraryViewSwitch";
import { LibraryTagFilter } from "./LibraryTagFilter";
import { LibraryTagBar } from "./LibraryTagBar";
import { LibraryFilterButton } from "./LibraryFilterButton";
import { LocalFileWorkspace } from "./LocalFileWorkspace";
import { PreservedWorkspace } from "./PreservedWorkspace";
import { useLocalFileMode } from "../lib/localFileMode";
import { useLibraryTabOrder, type LibraryTab } from "../lib/libraryTabOrder";

export function LibraryHome({ onCreateProject, shortcutsEnabled = true }: { onCreateProject?: () => Promise<unknown>; shortcutsEnabled?: boolean } = {}) {
  const homeRef = useRef<HTMLDivElement>(null);
  const filesOpen = useLocalFileMode(s => s.open);
  const fileMode = useLocalFileMode(s => s.mode);
  useEffect(() => { useStore.getState().setLibraryHomeView("library"); useLocalFileMode.getState().setOpen(true); }, []);
  const setFilesOpen = useLocalFileMode(s => s.setOpen);
  const order = useLibraryTabOrder(s => s.order);
  const setOrder = useLibraryTabOrder(s => s.setOrder);
  const pinchRef = useThumbnailPinch("library");
  const assets = useStore(s => s.assets);
  const setView = useStore(s => s.setLibraryHomeView);
  const total = useStore(s => s.total);
  const smartFilter = useStore(s => s.smartFilter);
  function changeSource(value: string) {
    if (value === "files") useLocalFileMode.getState().openBrowser();
    else useLocalFileMode.getState().openGlobal();
  }
  useEffect(() => {
    function cycleSource(event: KeyboardEvent) {
      const state = useStore.getState();
      if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey || event.repeat
        || event.defaultPrevented || !shortcutsEnabled || homeRef.current?.closest("[inert]")
        || state.projectRoutePending || state.contextMenu || state.projectContextMenu
        || document.querySelector('[role="dialog"], [role="menu"]')) return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || target?.closest('input, textarea, select, .app-topbar')) return;
      event.preventDefault(); event.stopPropagation();
      const current = useLocalFileMode.getState().mode;
      changeSource(order[(order.indexOf(current) + (event.shiftKey ? -1 : 1) + order.length) % order.length]);
      requestAnimationFrame(() => homeRef.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true }));
    }
    window.addEventListener("keydown", cycleSource, true);
    return () => window.removeEventListener("keydown", cycleSource, true);
  }, [shortcutsEnabled, order]);
  const navigation = <header className="library-browser-heading">
      <div className="library-floating-navigation">
      <LibraryViewSwitch value={fileMode} onChange={changeSource}
      onReorder={setOrder} label="素材视图切换条" options={order.map(value => ({ value,
        label: ({ global: "全局素材", files: "文件浏览器" } satisfies Record<LibraryTab, string>)[value] }))} />
      {!filesOpen && <div className="library-navigation-actions">
        {smartFilter?.startsWith("tag:") && <LibraryTagFilter name={smartFilter.slice(4)} onClear={() => { useStore.getState().setSmartFilter(null); useStore.getState().clearSelect(); }} />}
        <LibraryFilterButton />
      </div>}
      </div>
    </header>;
  return <div ref={homeRef} className="library-home library-browser">
    {filesOpen && <LocalFileWorkspace navigation={navigation} onClose={() => setFilesOpen(false)} onCreateProject={onCreateProject} onLegacy={() => { setFilesOpen(false); setView("library"); }} />}
    <PreservedWorkspace suspended={filesOpen}>
      <div className="folder-scope-bar"><button onClick={() => setFilesOpen(true)}>返回文件浏览</button><span>历史素材 · 原有资料与创作关系保留</span></div>
      <LibraryTagBar />
      <div ref={pinchRef} className="library-browser-grid">
        {navigation}
        <MasonryGrid layoutInset={4} restrictGroupsToAssets assetsOverride={assets} totalOverride={total} projectScopeId={null} />
      </div>
      <ThumbnailSizeSlider scope="library" />
    </PreservedWorkspace>
  </div>;
}
