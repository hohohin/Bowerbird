import { useId, useRef, useState, type RefCallback } from "react";
import { create } from "zustand";
import { ChevronDown, ChevronRight, Layers2, LayoutDashboard, PanelLeftClose, PanelLeftOpen, Settings2, Tags } from "lucide-react";
import { useLibraryModeStore } from "../lib/libraryPane";
import { useProjectAssetDrop } from "../lib/useProjectAssetDrop";
import { useStore } from "../store";
import type { Project } from "../lib/types";
import "./LibrarySidebar.css";

const widthKey = "bowerbird.catalog.sidebarWidth";
const useSidebarWidth = create<{ width: number; resize: (width: number) => void }>(set => {
  let width = 208;
  try {
    for (const key of [widthKey, "bowerbird.catalog.tagSidebarWidth.home-left", "bowerbird.catalog.tagSidebarWidth", "bowerbird.catalog.folderSidebarWidth.home-left", "bowerbird.catalog.folderSidebarWidth"]) {
      const saved = Number(localStorage.getItem(key));
      if (saved >= 120 && saved <= 320) { width = saved; break; }
    }
  } catch { /* Keep the default width without storage. */ }
  return { width, resize: value => {
    const next = Math.max(120, Math.min(320, Math.round(value)));
    set({ width: next });
    try { localStorage.setItem(widthKey, String(next)); } catch { /* Keep the session width. */ }
  } };
});

export function LibrarySidebar({ projects, bodyRef, contextProjectId, tagsExpanded, onToggleTags, onManageTags, explore }: {
  projects: Project[]; bodyRef: RefCallback<HTMLDivElement>; contextProjectId: string | null;
  tagsExpanded: boolean; onToggleTags: () => void; onManageTags: () => void;
  explore?: { open: boolean; onClose: () => void; onOpenProject?: (id: string) => void };
}) {
  const mode = useLibraryModeStore();
  const sidebarMode = mode(s => s.sidebarMode), savedCollapsed = mode(s => s.sidebarCollapsed), target = mode(s => s.hierarchyTarget);
  const collapsed = !explore && savedCollapsed;
  const { width, resize } = useSidebarWidth();
  const aside = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const projectListId = useId(), tagListId = useId();
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const drop = useProjectAssetDrop();
  const actions = mode.getState();
  const hierarchy = sidebarMode === "hierarchy";
  const ProjectChevron = projectsExpanded ? ChevronDown : ChevronRight;
  const TagChevron = tagsExpanded ? ChevronDown : ChevronRight;
  function setCollapsed(value: boolean) {
    if (explore) { if (value) explore.onClose(); return; }
    actions.setSidebarCollapsed(value);
    requestAnimationFrame(() => aside.current?.querySelector<HTMLButtonElement>(value ? "[data-sidebar-expand]" : "[data-sidebar-collapse]")?.focus());
  }
  return <aside ref={aside} className={`library-sidebar${explore && !hierarchy ? " is-tag-catalog" : ""}`} aria-label="素材库导航" data-collapsed={collapsed || undefined} data-tour="source-scope"
    data-explore-directory={explore ? "" : undefined} hidden={explore && !explore.open}
    style={{ width: explore ? `min(${width}px, var(--explore-sidebar-max, 320px))` : collapsed ? 44 : `min(${width}px, max(120px, 36cqi))` }}>
    <div className="library-sidebar-head">
      {collapsed ? <button type="button" className="library-sidebar-icon" data-sidebar-expand aria-label="展开侧栏" title="展开侧栏" aria-expanded={false} onClick={() => setCollapsed(false)}><PanelLeftOpen size={16}/></button>
        : <>
          <button type="button" className="library-sidebar-icon" aria-label="层级模式" title="层级模式 · Q" aria-keyshortcuts="Q" aria-pressed={hierarchy} onClick={() => actions.setSidebarMode("hierarchy")}><Layers2 size={15}/></button>
          <button type="button" className="library-sidebar-all" aria-current={hierarchy && target.kind === "all" || undefined} onClick={() => actions.selectHierarchy({ kind: "all" })}>全部素材</button>
          <button type="button" className="library-sidebar-icon library-sidebar-tags" aria-label="标签模式" aria-keyshortcuts="E" aria-pressed={!hierarchy} onClick={() => actions.setSidebarMode("tags")}>
            <Tags size={15}/><span aria-hidden="true"><Tags size={15}/>标签模式</span>
          </button>
        </>}
    </div>
    <div className="library-sidebar-tag-heading" data-mode={sidebarMode}>
      {!hierarchy && !collapsed && <button type="button" className="catalog-row library-sidebar-primary" aria-expanded={tagsExpanded} aria-controls={tagListId}
        onClick={onToggleTags}>拼音 A–Z
        <TagChevron size={14} className="library-sidebar-chevron" aria-hidden="true"/>
      </button>}
      <button type="button" className="library-sidebar-manage-tags" title="标签管理" aria-label="标签管理" aria-haspopup="dialog"
        onClick={event => {
          event.currentTarget.focus({ preventScroll: true });
          onManageTags();
        }}><Settings2 size={15} aria-hidden="true"/><span>标签管理</span></button>
    </div>
    <div className="library-sidebar-scroll" hidden={collapsed} data-mode={sidebarMode}>
      {hierarchy && <nav className="library-sidebar-projects" aria-label="项目">
        <button type="button" className="catalog-row library-sidebar-primary" aria-expanded={projectsExpanded} aria-controls={projectListId}
          onClick={() => setProjectsExpanded(value => !value)}><LayoutDashboard size={14} aria-hidden="true"/>项目
          <ProjectChevron size={14} className="library-sidebar-chevron" aria-hidden="true"/>
        </button>
        <div id={projectListId} hidden={!projectsExpanded}>
          <div className="library-sidebar-children">
            <button type="button" className="catalog-row"
              aria-current={target.kind === "projects" && (!target.projectId || !projects.some(project => project.id === target.projectId)) || undefined}
              onClick={() => actions.selectHierarchy({ kind: "projects", projectId: null })}>全部项目素材</button>
            {projects.map(project => <button type="button" key={project.id} className="catalog-row library-sidebar-project"
              aria-current={target.kind === "projects" && target.projectId === project.id || undefined}
              aria-label={project.name} title={project.name} {...drop(project)}
              onDoubleClick={explore?.onOpenProject ? () => explore.onOpenProject?.(project.id) : undefined}
              onContextMenu={event => {
                event.preventDefault();
                const bounds = event.currentTarget.getBoundingClientRect();
                useStore.getState().openProjectContextMenu(event.clientX || bounds.left, event.clientY || bounds.bottom, project.id);
              }}
              onClick={() => actions.selectHierarchy({ kind: "projects", projectId: project.id })}><span>{project.name}</span></button>)}
          </div>
          {contextProjectId && target.kind === "projects" && target.projectId && target.projectId !== contextProjectId && projects.some(project => project.id === contextProjectId) &&
            <button type="button" className="catalog-row library-sidebar-back" onClick={() => actions.selectHierarchy({ kind: "projects", projectId: contextProjectId })}>回到当前项目</button>}
        </div>
      </nav>}
      <div ref={hierarchy || tagsExpanded ? bodyRef : null} id={hierarchy ? undefined : tagListId}
        className="library-sidebar-slot" hidden={!hierarchy && !tagsExpanded}/>
    </div>
    {!collapsed && <>
      <footer className="library-sidebar-footer">
        <button type="button" data-sidebar-collapse aria-expanded onClick={() => setCollapsed(true)}><PanelLeftClose size={15}/>收起侧栏</button>
      </footer>
      <div className="catalog-sidebar-resize" role="separator" aria-label="调整素材库侧栏宽度" aria-orientation="vertical" aria-valuenow={width} aria-valuemin={120} aria-valuemax={320} tabIndex={0}
        onPointerDown={event => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, width: aside.current!.getBoundingClientRect().width };
        }}
        onPointerMove={event => { if (drag.current) resize(drag.current.width + event.clientX - drag.current.x); }}
        onLostPointerCapture={() => { drag.current = null; }}
        onDoubleClick={() => resize(208)}
        onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
          event.preventDefault();
          resize(event.key === "Home" ? 208 : (aside.current?.getBoundingClientRect().width ?? width) + (event.key === "ArrowLeft" ? -16 : 16));
        }}/>
    </>}
  </aside>;
}
