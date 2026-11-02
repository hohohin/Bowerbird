import type { Asset } from "./types";

export interface DocumentText { text: string; [key: string]: unknown }
export interface DocumentBlock {
  id: string;
  type: string;
  children: (DocumentText | DocumentBlock)[];
  assetId?: string;
  sourcePath?: string;
  caption?: string;
  [key: string]: unknown;
}
export type DocumentValue = DocumentBlock[];
export interface DocumentMedia { asset: Asset; kind: "image" | "audio" | "video"; path: string; url: string }
export interface TextDocumentSnapshot {
  assetId: string;
  path: string;
  text: string;
  version: string;
  format: "markdown" | "text";
}
