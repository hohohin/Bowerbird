import { api } from "./api";
import { notifyError, notifySuccess } from "./notify";

export interface GalleryMerge { groupKey: string; previous: Record<string, string | null> }
export const GALLERY_MERGED_EVENT = "bowerbird://gallery-merged";
export function reportGalleryMerge(edit: GalleryMerge, projectId: string | null) {
  window.dispatchEvent(new CustomEvent(GALLERY_MERGED_EVENT, { detail: { edit, projectId } }));
  notifySuccess("已合为组图", { label: "撤销", onClick: () => {
    void api.undoGenerationGalleryMerge(edit).catch(error => notifyError(error, "合组撤销未完成"));
  } });
}
