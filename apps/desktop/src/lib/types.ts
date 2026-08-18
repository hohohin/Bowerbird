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
  kind: "user" | "builtin";
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
  /** 图片标注元数据（不入库插入创作板的临时素材携带；库内资产经 analyses kind=annotation 读取）。 */
  annotation?: AnnotationMeta | null;
}

/** 图片标注单个形状：坐标为火山 Seedream 交互编辑归一化整数（0-999，左上 0,0 / 右下 999,999）。
 *  token 即可注入 prompt 的坐标标记——rect `<bbox>x1 y1 x2 y2</bbox>`；
 *  arrow 火山无专用标记，用起终点两个 point 表达方向。 */
export interface AnnotationShape {
  type: "rect" | "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** 显示用样式快照（烧录像素与未来重渲染），不影响坐标语义。 */
  color: string;
  /** 线宽（烧录进输出图的像素，随导出图分辨率）。 */
  width: number;
  token: string;
}

/** 标注输出相对原图的变换序列（面板内按操作顺序记录；裁剪坐标为当时底图归一化 0-1）。
 *  shapes 的坐标 token 一律相对最终输出图（旋转/裁剪后的图），与发给模型的参考图一致。 */
export type AnnotationTransformOp =
  | { kind: "rotate"; dir: 1 | -1 }
  | { kind: "crop"; x1: number; y1: number; x2: number; y2: number };

/** analyses(kind=annotation) 的 payload：标注输出图尺寸 + 相对原图的形状列表（坐标同图 1:1）。 */
export interface AnnotationMeta {
  schema_version: 1;
  source_asset_id: string;
  source_store_path: string;
  image: { width: number; height: number };
  /** 裁剪/旋转过程（无变换时缺省）；供追溯与未来重编辑。 */
  transform?: AnnotationTransformOp[];
  shapes: AnnotationShape[];
}

export interface Analysis {
  id: string;
  asset_id: string;
  kind: string; // caption | generation_meta | annotation（图片标注坐标）| keywords | ocr | ...
  payload: string; // JSON，如 {"text":"..."}
  provider?: string | null;
  created_at?: number | null;
}

/** codex 可用性检测结果（反推按钮据此置灰，约定 7）。 */
export interface CodexHealth {
  ok: boolean;
  reason: string;
}

/** `dreamina login --headless` 的 OAuth Device Flow 字段（app 内自动登录用）。 */
export interface DreaminaDeviceFlow {
  verification_uri: string;
  user_code: string;
  device_code: string;
  poll_interval_secs?: number | null;
  expires_at?: string | null;
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

/** 生成对话一轮：用户输入（首轮=编辑器组稿，后续=修改意见）+ 本轮产出图（asset 路径）。 */
export interface GenTurn {
  id: number;
  prompt: string;
  // 未铺开的编辑框原文（会话用户气泡显示它，与右键「复用生成提示词」同一数据）；
  // prompt 则是实际发给 AI 的完整文本（用途注入等），收进「thinking」式折叠。旧数据 / 续轮为 null。
  promptRaw?: string | null;
  images: string[];
  // 本轮用的 provider（done 事件回填，"codex-cli"/"jimeng"）；TurnView 角标「via ...」。
  provider?: string;
  // 本轮开始时间戳与完成耗时（done/error 回填 durationMs；恢复的 job 无 startedAt → 不显示用时）。
  startedAt?: number;
  durationMs?: number | null;
  // 失败轮的原始错误文本（codex 退出码/stderr 等）；undefined/null=非失败轮。纯 UI，不入库
  // （失败轮无 done → 无 ingest → 无 DB，error 只活在内存）。
  error?: string | null;
}

/**
 * 一个生成会话（多 job 模型）：首轮创建，续轮（resume 同一 codex/dreamina session）追加 turn。
 * id 由前端 `crypto.randomUUID()` 生成并传后端（chunk 事件按 id 路由无 race；续轮复用同 id，
 * 后端 task_queue upsert）。`running` = 该 job 当前有一个 turn 在跑（用于派生全局 generating）。
 */
export interface GenJob {
  id: string;
  // 会话分组：「重新编辑 / 重试」发送产生的新 job 归入源会话（= 根 job 的 id），
  // 同组 job 在会话面板用 ←/→ 切换编辑前后的版本（agent 应用式分支）。
  // 普通发送 = 自身 id；随 job 落库（generation_conversations），重启后瀑布流分组不丢。
  conversationId?: string;
  turns: GenTurn[];
  sessionId: string | null;
  streaming: string;
  lastPrompt: string; // 首轮发送 prompt（新会话重生成 + 复用到创作板 + 登记用途）
  lastRefs: string[]; // 首轮发送参考图 store_path
  refAssets: Asset[]; // 首轮参考图完整 asset（复用还原）
  lastRatio: string | null;
  provider: string;
  projectId: string | null; // 首轮项目快照；续轮不随当前项目切换漂移
  createdAt: number;
  running: boolean;
  // 即梦 submit_id（Chunk::Submit 回填，恢复续查用）；codex job 为 null。
  submitId?: string | null;
  // 远端任务状态（恢复 worker 回填，展示「远端仍在排队」等）；非恢复 job 为 null。
  remoteStatus?: "querying" | "success" | "fail" | null;
}

/** 「回看生成对话」：某生成图所在 codex 会话的完整时间线（后端 generation_history 返回）。 */
export interface GenerationHistoryTurn {
  prompt: string;
  prompt_raw?: string | null; // 未铺开的原始编辑框文本（复用优先用它还原 chip）；旧 meta 为 null → 回退 prompt
  images: string[]; // store_path
}

export interface GenerationHistory {
  session_id: string | null;
  turns: GenerationHistoryTurn[];
  /** 首版参考图完整 asset：「复用到创作板」还原参考图 + 「新会话重新生成」派生 store_path。
   *  不入库标注图由 <库根>/annotations/ 缓存合成（含「标注」维度 sections）。 */
  references: PromptedAsset[];
}

/** 应用设置（后端 settings.json 持久化） */
export interface AppSettings {
  auto_analyze_on_ingest: boolean;
  auto_analyze_prompt: string;
  library_root: string | null;
  cloud_auto_understand: boolean;
  board_shift_pick: boolean;
  hide_project_assets: boolean;
}

export interface AuthSnapshot {
  cloud_available: boolean;
  logged_in: boolean;
  user_id: string | null;
  email: string | null;
  access_expires_at: string | null;
  reason: string | null;
}

export interface FeaturePolicy {
  can_use_byo: boolean;
  can_use_cloud: boolean;
  max_parallel_jobs: number;
  understand_daily_limit: number | null;
  can_use_priority_queue: boolean;
  can_hd_export: boolean;
}

export interface CreditTransaction {
  kind: string;
  amount: number;
  service: string | null;
  created_at: string;
}

/** 云端动态生图档位（entitlement Edge 从 service_costs 带 label 的行返回）。 */
export interface GenerationService {
  service: string;
  label: string;
  credits: number;
}

export interface EntitlementSnapshot {
  user_id: string;
  tier: "free" | "pro" | "studio";
  balances: { daily: number; sub: number; topup: number };
  policy: FeaturePolicy;
  recent_transactions: CreditTransaction[];
  /** 缺失/为空时前端用内置兜底档位（genProviders.DEFAULT_CLOUD_PROVIDERS）。 */
  generation_services?: GenerationService[];
  issued_at: string;
  refresh_after: string;
  grace_until: string;
  entitlement_version: number;
  signature_version: number;
  signature: string | null;
  offline_state: "fresh" | "grace" | "expired" | "invalid" | null;
}

/** 素材库迁移进度（library://migrate-progress）。 */
export interface MigrateProgress {
  stage: string;
  done: number;
  total: number;
}

/** 未完成生成 job 摘要（list_gen_jobs 命令返回，前端启动重建 genJobs 用）。字段对齐后端 GenJobSummary。 */
export interface GenJobSummary {
  id: string;
  media: string;
  provider: string;
  status: string;
  prompt: string;
  submit_id: string | null;
  session_id: string | null;
  conversation_id: string | null;
  project_id: string | null;
  ratio: string | null;
  references: string[];
  created_at: number;
  running: boolean;
}

export interface LocalAgentPendingApproval {
  kind: "refine_plan";
  action: "submit_refine_plan";
  arguments: { changes?: string; estimatedAdditionalCredits?: number };
  planHash: string;
}

export interface LocalAgentPendingTool {
  callId: string;
  phase: string;
  action: "refine_once" | "inspect_generated_image";
  arguments: {
    prompt?: string;
    referenceAssetIds?: string[];
    ratio?: string;
    artifactCallId?: string;
  };
}

export interface LocalAgentRecord {
  callId: string;
  phase: string;
  action: string;
  arguments: Record<string, unknown>;
  result: unknown;
  cost: number;
  providerUsage: Record<string, unknown>;
}

export interface LocalAgentCheckpoint {
  schemaVersion: 1;
  runId: string;
  input: { targetAssetId: string; goal: string; caption?: string | null };
  phase: string;
  status: string;
  records: LocalAgentRecord[];
  modelTurnCount: number;
  generateAttemptCount: number;
  spentCredits: number;
  approval?: LocalAgentPendingApproval;
  pendingTool?: LocalAgentPendingTool;
  errorCode?: string;
}

export interface LocalAgentRun {
  id: string;
  skill_id: string;
  target_asset_id: string;
  status: string;
  phase: string;
  checkpoint: LocalAgentCheckpoint;
  created_at: number;
  updated_at: number;
}

export interface AgentPromptDimensionInput {
  key: string;
  label: string;
  raw: string;
}

export interface AgentPromptInput {
  originalPrompt: string;
  /**
   * 方案 B（skill 审查修复）：模板展开后的完整 prompt（= 直接发送时的 finalPrompt）。
   * 提供该字段时 CLI 走审查修复路线；缺省走方案 A（子句挑选）。
   */
  expandedPrompt?: string;
  references: Array<{
    assetId: string;
    name?: string;
    dimensions: AgentPromptDimensionInput[];
  }>;
  output?: {
    kind?: string;
    ratio?: string;
  };
}

export interface AgentPromptResult {
  prompt: string;
  attempts: number;
}

export type CodexChunk =
  | { kind: "started"; job_id: string }
  | { kind: "delta"; text: string; job_id?: string }
  | { kind: "submit"; submit_id: string; job_id?: string }
  | {
      kind: "done";
      text: string;
      provider: string;
      elapsed_ms: number;
      images?: string[];
      session_id?: string | null;
      job_id?: string;
    }
  | { kind: "recover_started"; job_id: string; prompt: string; provider: string }
  | { kind: "recover_polling"; job_id: string; message: string }
  | { kind: "error"; message: string; job_id?: string };
