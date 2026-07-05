export interface Asset {
  id: string;
  name: string;
  ext?: string | null;
  origin_path?: string | null;
  store_path?: string | null;
  thumb_path?: string | null;
  size?: number | null;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  phash?: string | null;
  colors?: string | null;
  rating?: number | null;
  source?: string | null;
  source_url?: string | null;
  folder_id?: string | null;
  created_at?: number | null;
  file_mtime?: number | null;
}

export interface Folder {
  id: string;
  name: string;
  parent_id?: string | null;
  kind?: string | null;
  smart_query?: string | null;
}

export interface Prompt {
  id: string;
  title?: string | null;
  body: string;
  kind?: string | null;
  source_model?: string | null;
  created_at?: number | null;
  updated_at?: number | null;
}

export interface AssetPrompt {
  prompt: Prompt;
  role: string;
}

export interface Analysis {
  id: string;
  asset_id: string;
  kind: string; // caption | keywords | ocr | layout | inspiration_card
  payload: string; // JSON，如 {"text":"..."}
  provider?: string | null;
  created_at?: number | null;
}

export interface CreationPack {
  prompt: string;
  references: string[];
  asset_ids: string[];
}

export interface CodexRequest {
  instruction: string;
  reference_images?: string[];
  context_prompts?: string[];
  output_schema?: unknown;
}

export interface CodexResult {
  text: string;
  structured?: unknown;
  provider: string;
  elapsed_ms: number;
}

export type CodexChunk =
  | { kind: "delta"; text: string }
  | { kind: "done"; text: string; provider: string; elapsed_ms: number; structured?: unknown }
  | { kind: "error"; message: string };
