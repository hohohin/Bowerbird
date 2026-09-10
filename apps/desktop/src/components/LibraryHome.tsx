import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronUp, PanelsTopLeft, Pencil, Trash2 } from "lucide-react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { groupLibraryAssets, type LibraryProjectGroup } from "../lib/libraryView";
import { notifyError } from "../lib/notify";
import { MasonryGrid } from "./MasonryGrid";
import { ProjectFolder } from "./ProjectFolder";
import { useProjectDeletion } from "./useProjectDeletion";
import { useProjectAssetDrop } from "../lib/useProjectAssetDrop";

function ExpandedProject({ group, onCollapse, onDelete, deleting }: {
  group: LibraryProjectGroup;
  onCollapse: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(group.project.name);
  const [saving, setSaving] = useState(false);
  const cancelled = useRef(false);
  const savingRef = useRef(false);
  const projectRoutePending = useStore((s) => s.projectRoutePending);
  const projectDrop = useProjectAssetDrop();

  async function saveTitle() {
    if (cancelled.current || savingRef.current) return;
    const name = title.trim();
    if (!name || name === group.project.name) {
      setEditing(false);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      await api.projectCanvasRename(group.project.id, name);
      await useStore.getState().reloadProjects();
      setEditing(false);
    } catch (error) {
      notifyError(error, "重命名项目失败");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return <section className="library-project-frame" aria-label={`项目 ${group.project.name}`}
    {...projectDrop(group.project)}
    onContextMenu={(event) => {
      event.preventDefault();
      event.stopPropagation();
      useStore.getState().openProjectContextMenu(event.clientX, event.clientY, group.project.id);
    }}>
    <header>
      <PanelsTopLeft size={16} className="shrink-0" aria-hidden="true" />
      <h2>{editing ? <input autoFocus className="library-project-title-input" aria-label="项目名称"
        value={title} disabled={saving} onChange={(event) => setTitle(event.target.value)}
        onBlur={() => void saveTitle()}
        onContextMenu={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") { event.preventDefault(); void saveTitle(); }
          if (event.key === "Escape") {
            event.preventDefault(); event.stopPropagation();
            cancelled.current = true; setEditing(false);
          }
        }} /> : <button type="button" className="library-project-title-button"
        title="重命名项目" aria-label={`重命名项目 ${group.project.name}`}
        onClick={() => { cancelled.current = false; setTitle(group.project.name); setEditing(true); }}>
        <span>{group.project.name}</span><Pencil size={12} />
      </button>}</h2>
      <span>{group.assets.length} 张素材</span>
      <div className="library-project-actions">
        <button type="button" className="library-project-open" disabled={projectRoutePending}
          onClick={() => void useStore.getState().enterProject(group.project.id)
            .catch((error) => notifyError(error, "无法打开项目画板"))}>打开项目</button>
        <button type="button" title="收起项目" aria-label={`收起项目 ${group.project.name}`}
          aria-expanded={true} onClick={onCollapse}><ChevronUp size={15} /></button>
        <button type="button" className="library-project-delete" title="删除项目 · 素材保留"
          aria-label={`删除项目 ${group.project.name}`} disabled={deleting || saving} onClick={onDelete}><Trash2 size={15} /></button>
      </div>
    </header>
    <MasonryGrid embedded restrictGroupsToAssets assetsOverride={group.assets}
      totalOverride={group.assets.length} projectScopeId={group.project.id} />
  </section>;
}

export function LibraryHome() {
  const assets = useStore((s) => s.assets);
  const projects = useStore((s) => s.projects);
  const memberships = useStore((s) => s.libraryMemberships);
  const collapsed = useStore((s) => s.projectAssetsCollapsed);
  const viewRevision = useStore((s) => s.projectAssetsViewRevision);
  const total = useStore((s) => s.total);
  const focusAssetId = useStore((s) => s.focusAssetId);
  const handledFocusId = useRef<string | null>(null);
  const [overrides, setOverrides] = useState<{ revision: number; expanded: Record<string, boolean> }>({ revision: viewRevision, expanded: {} });
  const { busy: deleting, prepareDelete, confirmation } = useProjectDeletion();
  const { globalAssets, projectGroups } = useMemo(
    () => groupLibraryAssets(assets, projects, memberships), [assets, projects, memberships],
  );
  const expanded = overrides.revision === viewRevision ? overrides.expanded : {};
  function setExpanded(projectId: string, value: boolean) {
    setOverrides((current) => ({ revision: viewRevision, expanded: {
      ...(current.revision === viewRevision ? current.expanded : {}), [projectId]: value,
    } }));
  }
  // Remove local choices when a project disappears under deletion or filtering.
  useEffect(() => {
    const visible = new Set(projectGroups.map((group) => group.project.id));
    setOverrides((current) => {
      const entries = Object.entries(current.expanded).filter(([id]) => visible.has(id));
      return entries.length === Object.keys(current.expanded).length ? current
        : { ...current, expanded: Object.fromEntries(entries) };
    });
  }, [projectGroups]);
  useEffect(() => {
    if (!focusAssetId) { handledFocusId.current = null; return; }
    if (handledFocusId.current === focusAssetId) return;
    const group = projectGroups.find((item) => item.assets.some((asset) => asset.id === focusAssetId));
    if (group) {
      handledFocusId.current = focusAssetId;
      setExpanded(group.project.id, true);
    }
  }, [focusAssetId, projectGroups, viewRevision]);

  return <>
    {projectGroups.length === 0 ? <MasonryGrid restrictGroupsToAssets
      assetsOverride={globalAssets} totalOverride={total} projectScopeId={null} />
      : <div className="library-home-expanded library-scroller">
        <div className="library-project-collections">
          {projectGroups.map((group) => (expanded[group.project.id] ?? !collapsed)
            ? <ExpandedProject key={group.project.id} group={group} deleting={deleting}
              onCollapse={() => setExpanded(group.project.id, false)}
              onDelete={() => void prepareDelete(group.project.id)} />
            : <ProjectFolder key={group.project.id} group={group}
              onOpen={() => setExpanded(group.project.id, true)} />)}
        </div>
        {globalAssets.length > 0 && <section className="library-global-section" aria-label="全局素材">
          <h2>全局素材 <span>未归入项目 · {globalAssets.length} 张</span></h2>
          <MasonryGrid embedded restrictGroupsToAssets assetsOverride={globalAssets} totalOverride={globalAssets.length} projectScopeId={null} />
        </section>}
      </div>}
    {confirmation}
  </>;
}
