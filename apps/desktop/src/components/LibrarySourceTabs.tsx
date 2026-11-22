import { useLibraryModeStore } from "../lib/libraryPane";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Folders, Layers2, LayoutDashboard, LayoutGrid, Tags } from "lucide-react";
import { useStore } from "../store";
import { LibraryViewSwitch } from "./LibraryViewSwitch";
import { LibraryControlProjection } from "./LibraryControlProjection";
import { trackFocusVisibleWithin } from "../lib/focusVisibleWithin";
import { LIBRARY_SOURCES, type LibrarySource } from "../lib/localFileMode";
import { ContextMenu } from "./ContextMenu";
import "./LibrarySourceTabs.css";

/** Shared navigation in the homepage and project drawer. */
export function LibrarySourceTabs({ onSourceChange }: { onSourceChange?: (source: LibrarySource) => void }) {
  const mode = useLibraryModeStore();
  const source = mode(s => s.source);
  const lens = mode(s => s.lens);
  const projectId = mode(s => s.browseProjectId);
  const contextProjectId = mode(s => s.contextProjectId);
  const projects = useStore(s => s.projects);
  const available = projects.filter(p => !p.archived_at && (!p.provisional || p.id === contextProjectId));
  const projectName = available.find(p => p.id === projectId)?.name;
  const root = useRef<HTMLDivElement>(null);
  const [projectAnchor, setProjectAnchor] = useState<HTMLButtonElement | null>(null);
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
    heading.classList.add("has-source-navigation");
    const releaseHeadingFocus = trackFocusVisibleWithin(heading);
    const releaseNavFocus = trackFocusVisibleWithin(navigation);
    setProjectionHost(heading);
    const strip = navigation;
    const controls = heading.querySelector<HTMLElement>('.video-collection-controls');
    let anchor: { button: HTMLElement; x: number; fraction: number; width: number; opened: boolean } | undefined;
    let shift = 0;
    const reset = () => { anchor = undefined; shift = 0; heading.style.removeProperty('--library-hover-shift'); delete heading.dataset.hoverAnchored; };
    const isOpen = () => heading.hasAttribute("data-navigation-open") || heading.hasAttribute("data-keyboard-focus") || heading.hasAttribute("data-controls-open");
    const remember = (event: PointerEvent) => {
      if (isOpen()) return;
      const button = (event.target as Element).closest<HTMLButtonElement>('button');
      if (!button || button.disabled || (!strip.contains(button) && !controls?.contains(button))) return;
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
      const right = strip.getBoundingClientRect().right - shift + (controls ? 72 : 0);
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
      heading.classList.remove("has-source-navigation");
      releaseHeadingFocus(); releaseNavFocus();
      observer.disconnect(); reset();
      heading.removeEventListener('pointerenter', entered); heading.removeEventListener('pointermove', remember); heading.removeEventListener('pointerleave', left);
    };
  }, []);
  useLayoutEffect(() => {
    if (!projectionHost) return;
    projectionHost.toggleAttribute("data-navigation-open", revealed || !!projectAnchor);
    return () => projectionHost.removeAttribute("data-navigation-open");
  }, [projectionHost, revealed, projectAnchor]);
  useEffect(() => {
    if (!projectAnchor) return;
    const dismissHiddenMenu = () => {
      if (projectAnchor.closest('[inert], [aria-hidden="true"]')) setProjectAnchor(null);
    };
    const observer = new MutationObserver(dismissHiddenMenu);
    for (let element: HTMLElement | null = projectAnchor; element; element = element.parentElement) {
      observer.observe(element, { attributes: true, attributeFilter: ["inert", "aria-hidden"] });
    }
    dismissHiddenMenu();
    return () => observer.disconnect();
  }, [projectAnchor]);
  const projectLabel = source === "project" ? projectName ? `项目 · ${projectName}` : "选择项目" : "项目";
  const viewOptions = {
    global: { label: "全部素材", icon: <Layers2 size={13} aria-hidden="true"/>, shortcut: "Q" },
    project: { label: projectLabel, icon: <LayoutDashboard size={13} aria-hidden="true"/>, shortcut: "E",
      title: projectLabel, expanded: source === "project" ? !!projectAnchor : undefined,
      trailing: source === "project" ? <ChevronDown size={11} aria-hidden="true"/> : undefined,
      onActivate: source === "project" && available.length ? (button: HTMLButtonElement) => setProjectAnchor(current => current ? null : button) : undefined },
    folders: { label: "文件夹", icon: <Folders size={13} aria-hidden="true"/>, shortcut: "F" },
  };
  return <div ref={root} className="library-source-navigation" data-revealed={revealed || undefined}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) deferRetract(); }}
    onFocus={event => { if (event.target.matches(":focus-visible")) reveal(); }}>
    {projectionHost && createPortal(<LibraryControlProjection/>, projectionHost)}
    <LibraryViewSwitch value={source} label="素材库来源" onChange={onSourceChange ?? mode.getState().openSource}
      options={LIBRARY_SOURCES.map(value => ({ value, ...viewOptions[value] }))}/>
    {source !== "folders" && <LibraryViewSwitch value={lens} label="素材库视角" hint="Tab 切换视角" onChange={mode.getState().setLens}
      options={[{ value: "flow", label: "平铺", icon: <LayoutGrid size={13} aria-hidden="true"/> },
        { value: "tags", label: "标签", icon: <Tags size={13} aria-hidden="true"/> }]}/>}
    {source === "project" && projectAnchor && <ContextMenu anchor={projectAnchor} label="选择浏览项目"
      onClose={() => setProjectAnchor(null)}>
      {available.map(project => <button key={project.id} type="button" role="menuitemradio" aria-checked={project.id === projectId}
        className="app-context-item" title={project.name} onClick={() => {
          const catalogHost = projectAnchor.closest(".library-catalog-transition")?.parentElement;
          setProjectAnchor(null);
          mode.getState().selectProject(project.id);
          requestAnimationFrame(() => catalogHost?.querySelector<HTMLButtonElement>('.library-catalog-layer:not([data-outgoing]) [data-tab-value="project"]')?.focus({ preventScroll: true }));
        }}>{project.name}</button>)}
    </ContextMenu>}
  </div>;
}
