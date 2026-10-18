import type { Asset } from "./types";
import { isVideoPath } from "./videoGeneration";

export type MediaFilter = "image" | "video" | null;

export function filterAssetsByMediaType(assets: Asset[], filter: MediaFilter): Asset[] {
  return filter === null ? assets : assets.filter(asset => isVideoPath(asset.store_path) === (filter === "video"));
}
