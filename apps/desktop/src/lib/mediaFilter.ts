import type { Asset } from "./types";
import { isVideoPath } from "./videoGeneration";
import { isAudioAsset, isAudioPath } from "./audioMedia";
import { isTextAsset, isTextPath } from "./textMedia";

export type MediaFilter = "image" | "video" | "audio" | "text" | null;

export function mediaType(path?: string | null): Exclude<MediaFilter, null> {
  return isTextPath(path) ? "text" : isAudioPath(path) ? "audio" : isVideoPath(path) ? "video" : "image";
}

export function filterAssetsByMediaType(assets: Asset[], filter: MediaFilter): Asset[] {
  return filter === null ? assets : assets.filter(asset => (isTextAsset(asset) ? "text" : isAudioAsset(asset) ? "audio" : mediaType(asset.store_path)) === filter);
}
