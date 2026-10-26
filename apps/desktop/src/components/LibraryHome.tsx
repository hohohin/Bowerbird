import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Columns2, X } from "lucide-react";
import { useStore } from "../store";
import { LibrarySourceTabs } from "./LibrarySourceTabs";
import { LibraryCatalogTransition } from "./LibraryCatalogTransition";
import { LocalFileWorkspace } from "./LocalFileWorkspace";
import { useLocalFileMode } from "../lib/localFileMode";
import { copyLibraryPane, createLibraryPane, LibraryPaneContext, registerLibraryPane, useActiveLibraryPane, type LibraryPaneState } from "../lib/libraryPane";
import "./LibrarySplit.css";
import "./LibraryTactical.css";

export function LibraryHome({ onCreateProject, shortcutsEnabled = true }: { onCreateProject?: (assetIds?: string[]) => Promise<unknown>; shortcutsEnabled?: boolean } = {}) {
  const [panes, setPanes] = useState(() => [{ pane: createLibraryPane("home-left", useLocalFileMode), weight: 1 }]);
  const body = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);
  const focusPane = useRef<string | null>(null);
  useEffect(() => {
    useStore.getState().setLibraryHomeView("library");
    useLocalFileMode.getState().openSource("global");
    useActiveLibraryPane.getState().activate(panes[0].pane);
    return () => useActiveLibraryPane.getState().activate(null);
  }, []);
  useLayoutEffect(() => {
    if (!focusPane.current) return;
    const element = body.current?.querySelector<HTMLElement>(`[data-library-pane="${focusPane.current}"]`);
    element?.focus({ preventScroll: true });
    element?.scrollIntoView({ block: "nearest", inline: "nearest" });
    focusPane.current = null;
  }, [panes]);
  function splitPane(source: LibraryPaneState) {
    const pane = copyLibraryPane(`home-pane-${nextId.current++}`, source);
    focusPane.current = pane.id;
    setPanes(current => current.flatMap(item => item.pane === source ? [{ ...item, weight: item.weight / 2 }, { pane, weight: item.weight / 2 }] : [item]));
    useActiveLibraryPane.getState().activate(pane);
  }
  function closePane(pane: LibraryPaneState) {
    if (panes.length === 1) return;
    const index = panes.findIndex(item => item.pane === pane);
    const neighbour = panes[index + 1] ?? panes[index - 1];
    focusPane.current = neighbour.pane.id;
    setPanes(current => current.filter(item => item.pane !== pane).map(item => item === neighbour ? { ...item, weight: item.weight + panes[index].weight } : item));
    useActiveLibraryPane.getState().activate(neighbour.pane);
  }
  function resizePair(left: LibraryPaneState, right: LibraryPaneState, ratio: number) {
    setPanes(current => {
      const total = current.filter(item => item.pane === left || item.pane === right).reduce((sum, item) => sum + item.weight, 0);
      return current.map(item => item.pane === left ? { ...item, weight: total * ratio } : item.pane === right ? { ...item, weight: total * (1 - ratio) } : item);
    });
  }
  return <div className="library-home library-browser library-tactical">
    <div ref={body} className={`library-split-body${panes.length > 1 ? " is-split" : ""}`}>
      {panes.map(({ pane, weight }, index) => <Fragment key={pane.id}>
        {index > 0 && <PaneDivider index={index} ratio={panes[index - 1].weight / (panes[index - 1].weight + weight)} onResize={ratio => resizePair(panes[index - 1].pane, pane, ratio)}/>}
        <div className="library-split-pane" style={{ flexGrow: weight }} aria-label={`素材库第 ${index + 1} 栏`}>
          <LibraryPaneContext.Provider value={pane}><HomePane pane={pane} split={panes.length > 1} onSplit={() => splitPane(pane)} onClose={() => closePane(pane)} onCreateProject={onCreateProject} shortcutsEnabled={shortcutsEnabled}/></LibraryPaneContext.Provider>
        </div>
      </Fragment>)}
    </div>
  </div>;
}

function PaneDivider({ index, ratio, onResize }: { index: number; ratio: number; onResize: (ratio: number) => void }) {
  const drag = useRef<{ x: number; left: number; total: number } | null>(null);
  function bounds(element: HTMLElement) {
    const left = element.previousElementSibling!.getBoundingClientRect().width;
    return { left, total: left + element.nextElementSibling!.getBoundingClientRect().width };
  }
  function resize(value: number, total: number) {
    const min = Math.min(.5, 400 / total);
    onResize(Math.max(min, Math.min(1 - min, value)));
  }
  return <div className="library-split-divider" role="separator" aria-label={`调整第 ${index}、${index + 1} 栏宽度`} aria-orientation="vertical" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)} tabIndex={0}
    onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); drag.current = { x: event.clientX, ...bounds(event.currentTarget) }; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={event => { const start = drag.current; if (start) resize((start.left + event.clientX - start.x) / start.total, start.total); }}
    onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
    onDoubleClick={() => onResize(.5)} onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
      event.preventDefault(); const { left, total } = bounds(event.currentTarget);
      resize(event.key === "Home" ? .5 : (left + (event.key === "ArrowLeft" ? -24 : 24)) / total, total);
    }}/>;
}

function HomePane({ pane, split, onSplit, onClose, onCreateProject, shortcutsEnabled }: {
  pane: LibraryPaneState; split: boolean; onSplit: () => void; onClose: () => void;
  onCreateProject?: (assetIds?: string[]) => Promise<unknown>; shortcutsEnabled: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => registerLibraryPane(pane), [pane]);
  const mode = pane.mode(s => s.mode);
  const media = pane.mode(s => s.media);
  const active = useActiveLibraryPane(s => s.pane === pane);
  const actions = <button className="library-filter-trigger" type="button" aria-label="向右分栏" title="向右复制当前素材库" onClick={onSplit}><Columns2 size={14} aria-hidden="true"/></button>;
  const navigation = <header className="library-browser-heading"><div className="library-floating-navigation">
    <LibrarySourceTabs value="global" onChange={() => pane.mode.getState().openSource("global")}/>
  </div></header>;
  return <div ref={root} className="library-pane-content" data-library-pane={pane.id} data-active={active || undefined} tabIndex={-1}
    onPointerDownCapture={() => useActiveLibraryPane.getState().activate(pane)} onFocusCapture={() => useActiveLibraryPane.getState().activate(pane)}
    onKeyDownCapture={event => {
      const state = useStore.getState(), target = event.target as HTMLElement;
      if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.nativeEvent.isComposing || event.defaultPrevented
        || !shortcutsEnabled || root.current?.closest("[inert]") || state.projectRoutePending || state.contextMenu || state.projectContextMenu
        || document.querySelector('[role="dialog"], [role="menu"]') || target.isContentEditable || target.closest('input, textarea, select')) return;
      event.preventDefault(); event.stopPropagation(); pane.mode.getState().toggleCatalog(); root.current?.focus({ preventScroll: true });
    }}>
    <button type="button" className="library-pane-close library-filter-trigger" aria-label="关闭此栏" title={split ? "关闭此栏" : "至少保留一个素材库"} disabled={!split} onClick={onClose}><X size={15} aria-hidden="true"/></button>
    {mode === "all" || mode === "tags" || mode === "collections"
      ? <LibraryCatalogTransition key={media} kind={mode} media={media} positionId={pane.id} showEmptyTags={split} dropPreview={split} toolbarActions={actions} navigation={navigation}
          onClose={() => pane.mode.getState().setOpen(false)} onCreateProject={onCreateProject}/>
      : <LocalFileWorkspace toolbarActions={actions} navigation={navigation} onClose={() => pane.mode.getState().closeBrowser()} onCreateProject={onCreateProject}/>}
  </div>;
}
