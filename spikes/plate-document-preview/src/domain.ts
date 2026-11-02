export type MediaKind = "image" | "audio" | "video";

export interface PreviewAsset {
  id: string;
  name: string;
  kind: MediaKind;
  url: string;
  thumbnail?: string;
  duration?: number;
}

export interface DocumentText {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  code?: boolean;
  [key: string]: unknown;
}

/** Plate nodes remain the editor's single document representation. */
export interface DocumentBlock {
  id: string;
  type: string;
  children: (DocumentText | DocumentBlock)[];
  assetId?: string;
  url?: string;
  caption?: string;
  listStyleType?: string;
  indent?: number;
  listStart?: number;
  [key: string]: unknown;
}

export type DocumentValue = DocumentBlock[];
export type DraftTarget = "chat" | "agent" | "image" | "video";

export const TARGET_LABELS: Record<DraftTarget, string> = {
  chat: "对话框",
  agent: "Agent 卡片",
  image: "生图卡片",
  video: "视频卡片",
};
