import type { Asset } from "./types";

export const VIDEO_COLLECTION_CANVAS_EVENT = "bowerbird:save-collected-video-to-canvas";
export const VIDEO_COLLECTION_PROJECT_EVENT = "bowerbird:prepare-video-collection-project";
export interface VideoCollectionProjectDetail { projectId: string; result?: Promise<void>; }
export interface VideoCollectionCanvasDetail {
  asset: Asset; projectId: string; operationId: string; result?: Promise<void>;
}

export function saveCollectedVideoToCanvas(asset: Asset, projectId: string, operationId: string) {
  const detail: VideoCollectionCanvasDetail = { asset, projectId, operationId };
  window.dispatchEvent(new CustomEvent(VIDEO_COLLECTION_CANVAS_EVENT, { detail }));
  return detail.result ?? Promise.reject(new Error("目标画板尚未就绪，请返回画板后重试"));
}

export function prepareVideoCollectionProject(projectId: string) {
  const detail: VideoCollectionProjectDetail = { projectId };
  window.dispatchEvent(new CustomEvent(VIDEO_COLLECTION_PROJECT_EVENT, { detail }));
  return detail.result ?? Promise.reject(new Error("目标项目尚未就绪，请返回画板后重试"));
}
