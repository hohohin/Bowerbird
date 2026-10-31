import type { Asset } from "./types";

export function videoSourceKey(asset?: Asset): string | undefined {
  return asset ? `${asset.id}:${asset.file_mtime ?? ""}:${asset.size ?? ""}:${asset.thumb_path ?? ""}` : undefined;
}
