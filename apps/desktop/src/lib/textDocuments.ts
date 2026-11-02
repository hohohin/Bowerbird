import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { Asset } from "./types";
import type { DocumentMedia, DocumentValue, TextDocumentSnapshot } from "./documentTypes";
import { isAudioAsset } from "./audioMedia";
import { isVideoPath } from "./videoGeneration";

export const textDocuments = {
  read: (assetId: string) => invoke<TextDocumentSnapshot>("read_text_document", { assetId }),
  save: (assetId: string, expectedVersion: string, text: string) => invoke<TextDocumentSnapshot>("save_text_document", { assetId, expectedVersion, text }),
};

export function documentMedia(asset: Asset): DocumentMedia | null {
  const path = asset.store_path || asset.origin_path;
  if (!path) return null;
  const kind = isAudioAsset(asset) ? "audio" : isVideoPath(path) ? "video"
    : /\.(png|jpe?g|webp|gif|avif|bmp|tiff?|heic)(?:[?#].*)?$/i.test(path) ? "image" : null;
  return kind ? { asset, path, kind, url: convertFileSrc(path) } : null;
}

export function documentReferenceIds(value: DocumentValue): string[] {
  const ids = new Set<string>();
  const visit = (nodes: DocumentValue) => nodes.forEach(node => {
    if (node.assetId) ids.add(node.assetId);
    visit(node.children.filter((child): child is DocumentValue[number] => typeof child.type === "string" && Array.isArray(child.children)));
  });
  visit(value); return [...ids];
}
