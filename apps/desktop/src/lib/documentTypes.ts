import type { Asset } from "./types";
import type { Value } from 'platejs';

export interface DocumentText { text: string; [key: string]: unknown }
export interface DocumentBlock {
  id: string;
  type: string;
  children: (DocumentText | DocumentBlock)[];
  assetId?: string;
  sourcePath?: string;
  caption?: string | DocumentText[];
  [key: string]: unknown;
}
export interface DocumentComment {
  id: string;
  contentRich: Value;
  createdAt: Date;
  discussionId: string;
  isEdited: boolean;
  userId: string;
}
export interface DocumentDiscussion {
  id: string;
  comments: DocumentComment[];
  createdAt: Date;
  isResolved: boolean;
  userId: string;
  documentContent?: string;
}
/** Editor blocks plus document-level annotations, serialized explicitly by documentState. */
export type DocumentValue = DocumentBlock[] & { discussions?: DocumentDiscussion[] };
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
