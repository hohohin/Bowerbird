import { useLibraryModeStore } from "../lib/libraryPane";
import { useEffect, useId, useRef } from "react";
import { Folder, Folders, Layers2, Tags } from "lucide-react";
import { useStore } from "../store";
import { LibraryViewSwitch } from "./LibraryViewSwitch";
import { LibraryControlProjection } from "./LibraryControlProjection";
import type { LibrarySource, LibraryView } from "../lib/localFileMode";
import "./LibrarySourceTabs.css";

/** Shared navigation in the homepage and project drawer. */
export function LibrarySourceTabs({ onChange, project = false, tabShortcut = true }: { value: string; onChange: (value: string) => void; project?: boolean; tabShortcut?: boolean }) {
  const mode = useLibraryModeStore();
  const view = mode(s => s.view);
  const source = mode(s => s.source);
  const expanded = mode(s => s.tagMenuOpen && s.view === "tags");
  const projectId = mode(s => s.browseProjectId);
  const projectName = useStore(s => s.projects.find(p => p.id === projectId)?.name);
  const root = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const scopeId = useId();
  function close() {
    if (root.current?.querySelector('.library-tag-scope')?.contains(document.activeElement)) {
      root.current.querySelector<HTMLButtonElement>('[data-tab-value="tags"]')?.focus();
    }
    mode.getState().setTagMenuOpen(false);
  }
  function keepOpen() {
    clearTimeout(timer.current);
    if (mode.getState().tagMenuOpen) timer.current = setTimeout(close, 3000);
  }
  useEffect(() => {
    if (!expanded) return;
    keepOpen();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(); };
    document.addEventListener('pointerdown', outside);
    return () => { clearTimeout(timer.current); document.removeEventListener('pointerdown', outside); };
  }, [expanded, mode]);
  return <div ref={root} className="library-source-navigation" data-scope-expanded={expanded || undefined}
    onPointerMove={keepOpen} onPointerDown={keepOpen} onFocus={keepOpen} onKeyDown={event => {
      keepOpen();
      if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key === 'ArrowDown' && expanded && (event.target as HTMLElement).dataset.tabValue === 'tags') {
        event.preventDefault(); root.current?.querySelector<HTMLButtonElement>('.library-tag-scope [aria-selected="true"]')?.focus();
      }
    }}>
    <LibraryControlProjection/>
    <LibraryViewSwitch value={view} label="素材视图切换条" hint={tabShortcut ? "Tab 切换视图" : undefined}
      onChange={value => {
        if (value === "project" && view === "project") mode.getState().setProjectPickerOpen(true);
        else if (value === "global" || value === "project") onChange(value);
        else mode.getState().setView(value as LibraryView);
        if (value === "tags") { mode.getState().setTagMenuOpen(true); keepOpen(); }
      }} options={[
        { value: "global", label: "全部素材", icon: <Layers2 size={13} aria-hidden="true"/>, shortcut: project ? "Q" : undefined },
        { value: "project", label: "项目素材", icon: <Folder size={13} aria-hidden="true"/>, shortcut: project ? "E" : undefined, title: projectName ? `${projectName} · 再次点击选择项目` : "选择要查看素材库的项目" },
        { value: "collections", label: "集合视图", icon: <Folders size={13} aria-hidden="true"/> },
        { value: "tags", label: "标签视图", icon: <Tags size={13} aria-hidden="true"/>, expanded, controls: scopeId },
      ]}/>
    {expanded && <div id={scopeId} className="library-tag-scope">
      <LibraryViewSwitch value={source} label="标签素材范围" onChange={value => {
        if (value === "project" && source === "project") mode.getState().setProjectPickerOpen(true);
        else mode.getState().setTagSource(value as LibrarySource);
        keepOpen();
      }} options={[{ value: "global", label: "全部素材" }, { value: "project", label: "项目素材", title: projectName ? `${projectName} · 再次点击选择项目` : "选择要查看素材库的项目" }]}/>
    </div>}
  </div>;
}
