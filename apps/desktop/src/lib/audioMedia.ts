import type { Asset } from "./types";

export function isAudioPath(path?: string | null): boolean {
  return !!path && /\.(wav|mp3|flac|m4a|ogg)(?:[?#].*)?$/i.test(path);
}

export function isAudioAsset(asset: Pick<Asset, "store_path" | "ext">): boolean {
  return isAudioPath(asset.store_path || (asset.ext ? `asset.${asset.ext}` : null));
}
