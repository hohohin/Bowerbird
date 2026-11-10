import { useLibraryModeStore } from "../lib/libraryPane";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Folders, Layers2, LayoutDashboard, Tags } from "lucide-react";
import { useStore } from "../store";
import { LibraryViewSwitch } from "./LibraryViewSwitch";
import { LibraryControlProjection } from "./LibraryControlProjection";
import { LIBRARY_VIEW_ORDER, type LibrarySource, type LibraryView } from "../lib/localFileMode";
import "./LibrarySourceTabs.css";

/** Shared navigation in the homepage and project drawer. */
export function LibrarySourceTabs({ onChange, project = false, tabShortcut = true }: { value: string; onChange: (value: string) => void; project?: boolean; tabShortcut?: boolean }) {
  const mode = useLibraryModeStore();
  const view = mode(s => s.view);
  const source = mode(s => s.source);
  const expanded = mode(s => s.scopeMenuOpen && (s.view === "tags" || s.view === "project"));
  const projectId = mode(s => s.browseProjectId);
  const projectName = useStore(s => s.projects.find(p => p.id === projectId)?.name);
  const root = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const scopeId = useId();
  const enter = useRef<ReturnType<typeof setTimeout>>();
  const [revealed, setRevealed] = useState(false);
  const [projectionHost, setProjectionHost] = useState<HTMLElement | null>(null);
  const retract = useRef<ReturnType<typeof setTimeout>>();
  const reveal = () => { clearTimeout(enter.current); clearTimeout(retract.current); setRevealed(true); };
  const deferRetract = () => { clearTimeout(enter.current); clearTimeout(retract.current); retract.current = setTimeout(() => setRevealed(false), 2000); };
  useEffect(() => () => { clearTimeout(enter.current); clearTimeout(retract.current); }, []);
  useLayoutEffect(() => {
    const navigation = root.current!;
    const heading = navigation.closest<HTMLElement>('.file-view-heading');
    if (!heading) return;
    setProjectionHost(heading);
    const strip = navigation.querySelector<HTMLElement>('.library-view-switch')!;
    const controls = heading.querySelector<HTMLElement>('.library-controls-host');
    let anchor: { button: HTMLElement; x: number; fraction: number; width: number; opened: boolean } | undefined;
    let shift = 0;
    const reset = () => { anchor = undefined; shift = 0; heading.style.removeProperty('--library-hover-shift'); delete heading.dataset.hoverAnchored; };
    const isOpen = () => heading.matches(':has(.library-source-navigation:is([data-revealed],[data-scope-expanded]), :focus-visible, .library-controls-host.is-open)');
    const remember = (event: PointerEvent) => {
      if (isOpen()) return;
      const button = (event.target as Element).closest<HTMLButtonElement>('button');
      if (!button || button.disabled || (button.parentElement !== strip && !controls?.contains(button))) return;
      const box = button.getBoundingClientRect();
      anchor = { button, x: event.clientX, fraction: (event.clientX - box.left) / box.width, width: strip.offsetWidth, opened: false };
      heading.dataset.hoverAnchored = 'true';
    };
    const align = () => {
      if (!anchor) return;
      anchor.opened ||= isOpen();
      const tab = anchor.button.getBoundingClientRect(), bounds = heading.getBoundingClientRect();
      const left = strip.getBoundingClientRect().left - shift;
      // At the edge, leave room for the overflow trigger instead of moving the target.
      const right = strip.getBoundingClientRect().right - shift + (controls ? 44 : 0);
      const desired = shift + anchor.x - (tab.left + tab.width * anchor.fraction);
      shift = Math.max(bounds.left - left, Math.min(bounds.right - right, desired));
      // Align every interactive control before paint; the optical field stays centered.
      heading.style.setProperty('--library-hover-shift', `${shift}px`);
      if (anchor.opened && !isOpen() && Math.abs(strip.offsetWidth - anchor.width) < 1) {
        reset();
      }
    };
    const entered = (event: PointerEvent) => { remember(event); clearTimeout(retract.current); enter.current = setTimeout(reveal, 120); };
    const left = () => { deferRetract(); if (!anchor?.opened && !isOpen()) reset(); };
    const observer = new ResizeObserver(align);
    observer.observe(strip); observer.observe(heading);
    if (controls) observer.observe(controls);
    heading.addEventListener('pointerenter', entered);
    heading.addEventListener('pointermove', remember);
    heading.addEventListener('pointerleave', left);
    return () => {
      observer.disconnect(); reset();
      heading.removeEventListener('pointerenter', entered); heading.removeEventListener('pointermove', remember); heading.removeEventListener('pointerleave', left);
    };
  }, []);
  function close() {
    if (root.current?.querySelector('.library-tag-scope')?.contains(document.activeElement)) {
      root.current.querySelector<HTMLButtonElement>(`[data-tab-value="${view}"]`)?.focus();
    }
    mode.getState().setScopeMenuOpen(false);
  }
  function keepOpen() {
    clearTimeout(timer.current);
    if (mode.getState().scopeMenuOpen) timer.current = setTimeout(close, 3000);
  }
  useEffect(() => {
    if (!expanded) return;
    keepOpen();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(); };
    document.addEventListener('pointerdown', outside);
    return () => { clearTimeout(timer.current); document.removeEventListener('pointerdown', outside); };
  }, [expanded, mode, view]);
  const viewOptions = {
    collections: { label: "文件夹", icon: <Folders size={13} aria-hidden="true"/> },
    project: { label: "项目素材", icon: <LayoutDashboard size={13} aria-hidden="true"/>, shortcut: project ? "E" : undefined, expanded: expanded && view === "project", controls: scopeId, title: projectName ?? "选择项目" },
    tags: { label: "标签分类", icon: <Tags size={13} aria-hidden="true"/>, expanded: expanded && view === "tags", controls: scopeId },
    global: { label: "全部素材", icon: <Layers2 size={13} aria-hidden="true"/>, shortcut: project ? "Q" : undefined },
  };
  return <div ref={root} className="library-source-navigation" data-revealed={revealed || undefined} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) deferRetract(); }} data-scope-expanded={expanded || undefined}
    onPointerMove={keepOpen} onPointerDown={keepOpen} onFocus={event => { if (event.target.matches(":focus-visible")) reveal(); keepOpen(); }} onKeyDown={event => {
      keepOpen();
      if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key === 'ArrowDown' && expanded && (event.target as HTMLElement).dataset.tabValue === view) {
        event.preventDefault(); root.current?.querySelector<HTMLButtonElement>('.library-tag-scope [aria-selected="true"]')?.focus();
      }
    }}>
    {projectionHost && createPortal(<LibraryControlProjection/>, projectionHost)}
    <LibraryViewSwitch value={view} label="素材视图切换条" hint={tabShortcut ? "Tab 切换视图" : undefined}
      onChange={value => {
        if (value === "global" || value === "project") onChange(value);
        else mode.getState().setView(value as LibraryView);
        if (value === "tags" || value === "project") { mode.getState().setScopeMenuOpen(true); keepOpen(); }
      }} options={LIBRARY_VIEW_ORDER.map(value => ({ value, ...viewOptions[value] }))}/>
    {expanded && <div id={scopeId} className={`library-tag-scope${view === "project" ? " library-project-scope" : ""}`}>
      {view === "project" ? <LibraryViewSwitch value="current" label="当前项目" onChange={() => { close(); mode.getState().setProjectPickerOpen(true); }} options={[{ value: "current", label: projectName ?? "选择项目", title: "选择项目", icon: <LayoutDashboard size={12} aria-hidden="true"/> }]}/> : <>
      <LibraryViewSwitch value={source} label="标签素材范围" onChange={value => {
        if (value === "project" && source === "project") mode.getState().setProjectPickerOpen(true);
        else mode.getState().setTagSource(value as LibrarySource);
        keepOpen();
      }} options={[{ value: "global", label: "全部素材" }, { value: "project", label: "项目素材", title: projectName ? `${projectName} · 再次点击选择项目` : "选择要查看素材库的项目" }]}/>
      </>}
    </div>}
  </div>;
}
