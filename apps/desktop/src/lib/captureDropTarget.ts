import { UNTAGGED_SECTION } from "./materialCatalogOrder";

type CaptureScope = {
  activeProjectId: string | null;
  projects: { id: string; name: string }[];
};

export type CaptureDropTarget = {
  projectId: string | null;
  element: HTMLElement | null;
  name: string;
} & (
  | { kind: "folder"; id: string; disabled: boolean }
  | { kind: "tag"; id: string; disabled: false }
  | { kind: "canvas" | "project" | "global"; id: string | null; disabled: false }
);

/** Resolve the concrete DOM hit. The folder selected by scroll position is only navigation state. */
export function resolveCaptureDropTarget(target: EventTarget | null, scope: CaptureScope): CaptureDropTarget {
  const hit = target instanceof Element ? target : null;
  const project = hit?.closest<HTMLElement>("[data-project-drop-id], [data-file-import-project-id]");
  const projectId = project ? (project.dataset.projectDropId ?? project.dataset.fileImportProjectId) || null : scope.activeProjectId;
  const folder = hit?.closest<HTMLElement>("[data-file-import-collection-id]");
  const folderId = folder?.dataset.fileImportCollectionId;
  if (folder && folderId) return {
    kind: "folder", id: folderId, projectId, element: folder,
    name: folder.dataset.fileImportCollectionName || "当前文件夹",
    disabled: folder.dataset.fileImportCollectionAvailable === "false",
  };

  const tag = hit?.closest<HTMLElement>(".is-tag-catalog [data-tag-id], .is-tag-catalog [data-tag-section]");
  const tagId = tag?.dataset.tagId ?? tag?.dataset.tagSection;
  if (tag && tagId && tagId !== UNTAGGED_SECTION) return {
    kind: "tag", id: tagId, projectId, element: tag,
    name: tag.dataset.tagName || "当前标签", disabled: false,
  };

  const canvas = hit?.closest<HTMLElement>("[data-canvas-stage]");
  return {
    kind: canvas ? "canvas" : projectId ? "project" : "global", id: projectId, projectId,
    element: canvas ?? project ?? null, disabled: false,
    name: projectId ? scope.projects.find(item => item.id === projectId)?.name || "当前项目" : "全局素材库",
  };
}

export function captureDropMessage(target: CaptureDropTarget, localOutsideLibrary = false) {
  if (target.kind === "folder") return target.disabled
    ? `文件夹【${target.name}】已离线，无法采集到此位置`
    : `素材即将采集到文件夹【${target.name}】中`;
  if (target.kind === "tag") return `素材即将采集到标签【${target.name}】中`;
  if (target.kind === "canvas") return "松开放到画布当前位置";
  if (localOutsideLibrary) return target.kind === "project" ? `松开添加到「${target.name}」素材库` : "松开添加到全局素材库";
  return `素材即将采集到【${target.name}】中`;
}
