import { convertFileSrc } from "@tauri-apps/api/core";
import { Image, Maximize2, PanelsTopLeft } from "lucide-react";
import { notifyError } from "../lib/notify";
import { useStore } from "../store";
import type { LibraryProjectGroup } from "../lib/libraryView";
import { useProjectAssetDrop } from "../lib/useProjectAssetDrop";

export function ProjectFolder({ group, onExpand }: { group: LibraryProjectGroup; onExpand: () => void }) {
  const projectDrop = useProjectAssetDrop();
  const projectRoutePending = useStore((s) => s.projectRoutePending);
  return <div className="library-project-folder"
    {...projectDrop(group.project)}
    onContextMenu={(event) => {
      event.preventDefault();
      event.stopPropagation();
      useStore.getState().openProjectContextMenu(event.clientX, event.clientY, group.project.id);
    }}>
    <button type="button" className="library-project-enter" disabled={projectRoutePending}
      aria-label={`打开项目 ${group.project.name}`}
      onClick={() => void useStore.getState().enterProject(group.project.id)
        .catch((error) => notifyError(error, "无法打开项目画板"))}>
      <div className="library-project-mosaic" aria-hidden="true">
        {Array.from({ length: 9 }, (_, index) => {
          const asset = group.assets[index];
          const path = asset?.thumb_path ?? asset?.store_path;
          return <span key={index}>{path ? <img src={convertFileSrc(path)} alt="" loading="lazy" draggable={false} /> : asset ? <Image size={18} /> : null}</span>;
        })}
      </div>
      <div className="library-project-folder-title"><PanelsTopLeft size={14} aria-hidden="true" /><strong>{group.project.name}</strong></div>
    </button>
    <button type="button" className="library-project-expand" title="展开项目"
      aria-label={`展开项目 ${group.project.name}`} aria-expanded={false} onClick={onExpand}>
      <Maximize2 size={15} aria-hidden="true" />
    </button>
  </div>;
}
