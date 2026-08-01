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
  generation_session_id?: string | null;
}

export interface Project {
  id: string;
  name: string;
  workspace_path: string;
  created_at: number;
  asset_count: number;
}

export interface ProjectCreateResult {
  project: Project;
  imported_count: number;
  member_count: number;
}

/** 删除项目时对独占素材的处理方式；共享素材永远保留在全局。 */
export type ProjectDeleteMode = "keep" | "move_out" | "delete_exclusive";

export interface ProjectDeleteResult {
  removed_members: number;
  deleted_assets: number;
  preserved_shared: number;
  moved_assets: number;
  failed_moves: string[];
}

/** 右键单素材删除三选项（与「删除项目」语义对齐）。 */
export type AssetDeleteMode = "keep" | "move_out" | "delete";

/** 右键单素材删除结果。 */
export interface AssetDeleteResult {
  deleted_assets: number;
  removed_members: number;
  moved_files: number;
  failed_moves: string[];
}

export type FolderKind = "folder" | "smart" | "collection";

export interface Folder {
  id: string;
  name: string;
  parent_id?: string | null;
  kind?: FolderKind | null;
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

/** 创作板「用途」：命名的预设 prompt 片段，发送 codex 时作为基底注入（不进编辑器）。 */
export interface Preset {
  id: string;
  name: string;
  body: string;
  created_at?: number | null;
  updated_at?: number | null;
}

/** 生成对话一轮：用户输入（首轮=编辑器 finalPrompt，后续=修改意见）+ 本轮产出图（asset 路径）。 */
export interface GenTurn {
  id: number;
  prompt: string;
  images: string[];
}

/** 「回看生成对话」：某生成图所在 codex 会话的完整时间线（后端 generation_history 返回）。 */
export interface GenerationHistoryTurn {
  prompt: string;
  images: string[]; // store_path
}

export interface GenerationHistory {
  session_id: string | null;
  turns: GenerationHistoryTurn[];
  references: Asset[]; // 首版参考图完整 asset：「复用到创作板」还原参考图 + 「新会话重新生成」派生 store_path
}

/** 应用设置（后端 settings.json 持久化） */
export interface AppSettings {
  auto_analyze_on_ingest: boolean;
  auto_analyze_prompt: string;
  library_root: string | null;
}

/** 素材库迁移进度（library://migrate-progress）。 */
export interface MigrateProgress {
  stage: string;
  done: number;
  total: number;
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
