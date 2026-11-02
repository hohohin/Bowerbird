import type { Asset } from "./types";

export function isTextPath(path?: string | null): boolean {
  return !!path && /\.(md|markdown|txt)(?:[?#].*)?$/i.test(path);
}

export function isTextAsset(asset: Pick<Asset, "store_path" | "ext">): boolean {
  return isTextPath(asset.store_path || (asset.ext ? `asset.${asset.ext}` : null));
}
