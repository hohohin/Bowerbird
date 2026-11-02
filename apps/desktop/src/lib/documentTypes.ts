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

export interface TextWorkspaceDocument { title: string; markdown: string }
export type TextDocumentDestination = { kind: "collection"; folderId: string } | { kind: "project"; projectId: string };
export interface CreateTextDocumentInput { requestId: string; title: string; text: string; destination: TextDocumentDestination }
export type CreatedTextDocument = ({ kind: "collection" } & TextDocumentSnapshot) | { kind: "project"; nodeId: string };
