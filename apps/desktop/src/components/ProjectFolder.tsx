import { convertFileSrc } from "@tauri-apps/api/core";
import { Image, PanelsTopLeft } from "lucide-react";
import { useStore } from "../store";
import type { LibraryProjectGroup } from "../lib/libraryView";
import { useProjectAssetDrop } from "../lib/useProjectAssetDrop";

export function ProjectFolder({ group, onOpen }: { group: LibraryProjectGroup; onOpen: () => void }) {
  const projectDrop = useProjectAssetDrop();
  return <button type="button" className="library-project-folder" onClick={onOpen}
    {...projectDrop(group.project)}
    aria-label={`展开项目 ${group.project.name}，${group.assets.length} 张素材`} aria-expanded={false}
    onContextMenu={(event) => {
      event.preventDefault();
      event.stopPropagation();
      useStore.getState().openProjectContextMenu(event.clientX, event.clientY, group.project.id);
    }}>
    <div className="library-project-mosaic" aria-hidden="true">
      {Array.from({ length: 9 }, (_, index) => {
        const asset = group.assets[index];
        const path = asset?.thumb_path ?? asset?.store_path;
        return <span key={index}>{path ? <img src={convertFileSrc(path)} alt="" loading="lazy" draggable={false} /> : asset ? <Image size={18} /> : null}</span>;
      })}
    </div>
    <div className="library-project-folder-title"><PanelsTopLeft size={14} aria-hidden="true" /><strong>{group.project.name}</strong></div>
    <span className="library-project-count">{group.assets.length} 张素材</span>
  </button>;
}
