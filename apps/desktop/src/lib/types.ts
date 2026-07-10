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

/** 自动归类侧栏聚合：tag + 资产计数（count>0）。 */
export interface TagCount {
  id: string;
  name: string;
  count: number;
}

/** 某资产的 tag（name + source）。source: auto(codex) | manual(用户)。 */
export interface AssetTag {
  name: string;
  source: string;
}

/** 色板聚合：颜色桶 + 资产数 + 桶代表 hex（hex 由后端注入，消除双源）。 */
export interface ColorBucket {
  key: string;
  count: number;
  hex: string;
}

export interface CaptionSection {
  title: string;
  body: string;
}

/** 创作板用：有 caption（反推）的资产 + 最新 caption 正文与结构化维度。 */
export interface PromptedAsset extends Asset {
  caption?: string | null;
  sections?: CaptionSection[] | null;
  dimensions?: Record<string, string> | null;
  parse_status?: string | null;
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

/** codex 可用性检测结果（反推按钮据此置灰，约定 7）。 */
export interface CodexHealth {
  ok: boolean;
  reason: string;
}

export interface CreationPack {
  prompt: string;
  references: string[];
  asset_ids: string[];
}

/** 生成对话一轮：用户输入（首轮=编辑器 finalPrompt，后续=修改意见）+ 本轮产出图（asset 路径）。 */
export interface GenTurn {
  id: number;
  prompt: string;
  images: string[];
}

export type CodexChunk =
  | { kind: "delta"; text: string }
  | {
      kind: "done";
      text: string;
      provider: string;
      elapsed_ms: number;
      images?: string[];
      session_id?: string | null;
    }
  | { kind: "error"; message: string };
