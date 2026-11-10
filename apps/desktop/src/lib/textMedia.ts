import type { Asset } from "./types";

export const TEXT_CARD_ASPECT_RATIO = 3 / 4;

export function isTextPath(path?: string | null): boolean {
  return !!path && /\.(md|markdown|txt|docx|xlsx|csv)(?:[?#].*)?$/i.test(path);
}

export function isSpreadsheetPath(path?: string | null): boolean {
  return !!path && /\.(xlsx|csv)(?:[?#].*)?$/i.test(path);
}

export function textFileFormat(path: string): string {
  const ext = path.split(/[?#]/)[0].split(".").pop()?.toLowerCase();
  return ext === "md" || ext === "markdown" ? "Markdown" : ext?.toUpperCase() ?? "";
}

export function isTextAsset(asset: Pick<Asset, "store_path" | "ext">): boolean {
  return isTextPath(asset.store_path || (asset.ext ? `asset.${asset.ext}` : null));
}
