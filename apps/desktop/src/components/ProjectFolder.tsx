import { convertFileSrc } from "@tauri-apps/api/core";
import { ArrowUpRight, Image, ImagePlus, Maximize2, MoreHorizontal, PanelsTopLeft } from "lucide-react";
import { notifyError } from "../lib/notify";
import { useStore } from "../store";
import type { LibraryProjectGroup } from "../lib/libraryView";
import { useProjectAssetDrop } from "../lib/useProjectAssetDrop";

function projectUpdatedLabel(timestamp: number) {
  const date = new Date(timestamp * 1000);
  const minutes = Math.floor(Math.max(0, Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return "刚刚更新";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "numeric", day: "numeric" });
}

export function ProjectFolder({ group, onExpand, onOpen, detailed = false, serial }: { group: LibraryProjectGroup; onExpand?: () => void; onOpen?: () => void; detailed?: boolean; serial?: number }) {
  const projectDrop = useProjectAssetDrop();
  const projectRoutePending = useStore((s) => s.projectRoutePending);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const selected = detailed && activeProjectId === group.project.id;
  const updatedAt = group.project.updated_at ?? group.project.created_at;
  const openProject = () => void useStore.getState().enterProject(group.project.id)
    .then(() => onOpen?.())
    .catch((error) => notifyError(error, "无法打开项目画板"));
  const menuButton = <button type="button" className={detailed ? "project-manager-menu" : "library-project-expand"} title="项目操作"
    aria-label={`项目操作 ${group.project.name}`} aria-haspopup="menu" onClick={event => {
      const bounds = event.currentTarget.getBoundingClientRect();
      useStore.getState().openProjectContextMenu(bounds.left, bounds.bottom, group.project.id);
    }}><MoreHorizontal size={15} aria-hidden="true" /></button>;
  const content = <>
    {detailed && <div className="project-manager-card-head"><span>PRJ / {String(serial ?? 1).padStart(3, "0")}</span>{selected && <span className="project-manager-selected" aria-hidden="true">CURRENT / ✓</span>}</div>}
    <div className="library-project-mosaic" data-count={Math.min(group.assets.length, detailed ? 3 : 6)} aria-hidden="true">
      {detailed && !group.assets.length ? <div className="project-manager-empty-cover"><ImagePlus size={40} strokeWidth={1}/><span>{group.project.asset_count ? "暂无素材预览" : "开始你的创作"}</span></div> : Array.from({ length: detailed ? Math.min(group.assets.length, 3) : 9 }, (_, index) => {
        const asset = group.assets[index];
        const path = asset?.thumb_path ?? asset?.store_path;
        return <span key={index}>{path ? <img src={convertFileSrc(path)} alt="" loading="lazy" draggable={false} /> : asset ? <Image size={18} /> : null}</span>;
      })}
    </div>
    <div className="project-folder-info">
      {detailed && <span className="project-manager-card-kind">{activeProjectId === group.project.id ? "当前项目" : "项目画板"}</span>}
      <div className="library-project-folder-title">{!detailed && <PanelsTopLeft size={14} aria-hidden="true" />}<strong title={group.project.name}>{group.project.name}</strong>{detailed && menuButton}</div>
      {detailed && <div className="project-manager-meta"><span>{group.project.asset_count ? `${group.project.asset_count} 个素材` : "暂无素材"}</span><span aria-hidden="true">·</span><time dateTime={new Date(updatedAt * 1000).toISOString()}>{projectUpdatedLabel(updatedAt)}</time></div>}
    </div>
  </>;
  return <div className={`library-project-folder${detailed ? " project-manager-card" : ""}`}
    data-active={detailed && selected ? true : undefined}
    {...projectDrop(group.project)}
    onContextMenu={(event) => {
      event.preventDefault();
      event.stopPropagation();
      useStore.getState().openProjectContextMenu(event.clientX, event.clientY, group.project.id);
    }}>
    <button type="button" className={detailed ? "project-manager-activate" : "library-project-enter"} disabled={projectRoutePending}
      aria-label={`打开项目 ${group.project.name}`}
      aria-current={detailed && activeProjectId === group.project.id ? true : undefined}
      onClick={openProject}>
      {!detailed && content}
    </button>
    {detailed && <><div className="library-project-enter">{content}</div><span className="project-manager-open" aria-hidden="true"><ArrowUpRight size={17}/></span></>}
    {!detailed && (onExpand ? <button type="button" className="library-project-expand" title="展开项目"
      aria-label={`展开项目 ${group.project.name}`} aria-expanded={false} onClick={onExpand}>
      <Maximize2 size={15} aria-hidden="true" />
    </button> : menuButton)}
  </div>;
}
