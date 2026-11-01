import type { Asset } from "./types";
import { isVideoPath } from "./videoGeneration";
import { isAudioAsset, isAudioPath } from "./audioMedia";

export type MediaFilter = "image" | "video" | "audio" | null;

export function mediaType(path?: string | null): Exclude<MediaFilter, null> {
  return isAudioPath(path) ? "audio" : isVideoPath(path) ? "video" : "image";
}

export function filterAssetsByMediaType(assets: Asset[], filter: MediaFilter): Asset[] {
  return filter === null ? assets : assets.filter(asset => (isAudioAsset(asset) ? "audio" : mediaType(asset.store_path)) === filter);
}
