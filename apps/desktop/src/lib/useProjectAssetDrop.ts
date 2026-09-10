import { useRef, useState, type DragEvent } from "react";
import { api } from "./api";
import { getDragAssets, setDragAssets } from "./dragPayload";
import { notify, notifyError } from "./notify";
import type { Project } from "./types";

/** Share the existing asset drag payload across project cards and sidebar entries. */
export function useProjectAssetDrop() {
  const [over, setOver] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const pending = useRef(false);
  return (project: Project) => {
    const accepts = () => !project.provisional && !project.archived_at && !!getDragAssets()?.length;
    const accept = (event: DragEvent<HTMLElement>) => {
      if (!accepts()) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = pending.current ? "none" : "copy";
      if (!pending.current) setOver(project.id);
    };
    return {
      "data-project-drop-id": project.id,
      "data-project-drop-state": busy === project.id ? "busy" : over === project.id ? "over" : undefined,
      onDragEnterCapture: accept,
      onDragOverCapture: accept,
      onDragLeaveCapture: (event: DragEvent<HTMLElement>) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setOver(null);
      },
      onDropCapture: (event: DragEvent<HTMLElement>) => {
        if (!accepts()) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(null);
        if (pending.current) return;
        const ids = [...new Set(getDragAssets()!)];
        setDragAssets(null);
        pending.current = true;
        setBusy(project.id);
        void api.addAssetsToProject(project.id, ids).then((added) => {
          notify(added > 0 ? `已向「${project.name}」添加 ${added} 张素材` : `所选素材已在「${project.name}」中`, added > 0 ? "success" : "info");
        }).catch((error) => notifyError(error, "添加到项目失败，请重试"))
          .finally(() => { pending.current = false; setBusy(null); });
      },
    };
  };
}
