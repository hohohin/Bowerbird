import { invoke } from "@tauri-apps/api/core";
import type { Asset } from "./types";

export interface VideoCollectionTask {
  id: string;
  projectId: string;
  kind: "direct" | "douyin";
  state: "starting" | "waiting" | "downloading" | "needs_login" | "failed" | "cancelled" | "interrupted" | "ready";
  message?: string;
  sourceUrl: string;
  shareText: string;
  downloadedBytes?: number;
  totalBytes?: number | null;
  assetId?: string;
  reference?: { id: string; name: string; duration: number };
}

export const collectionRunning = (task: VideoCollectionTask) => ["starting", "waiting", "downloading"].includes(task.state);
export const collectVideo = <T = VideoCollectionTask>(projectId: string | null, action: string, data: object = {}) =>
  invoke<T>("video_collection", { projectId, action, data });
export const saveCollectedVideo = (projectId: string | null, id: string) => collectVideo<Asset>(projectId, "save", { id });

export function collectionProgress(task: VideoCollectionTask): string {
  if (!task.downloadedBytes) return "";
  const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return task.totalBytes ? `${size(task.downloadedBytes)} / ${size(task.totalBytes)}` : size(task.downloadedBytes);
}
