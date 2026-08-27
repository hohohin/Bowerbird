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
  /** 被创作板当参考图调用的次数（详情页信息区展示；0 不显示）。 */
  reference_count?: number;
}

export interface Project {
  id: string;
  name: string;
  workspace_path: string;
  created_at: number;
  asset_count: number;
  kind: "user" | "builtin" | "blank";
}

export interface ProjectCreateResult {
  project: Project;
  imported_count: number;
  member_count: number;
}

/** 「更新项目文件」结果：本次新加入项目的素材数（0 = 文件夹没有新素材）。 */
export interface ProjectRefreshResult {
  added_count: number;
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
  /** 车牌：维度稳定身份（后端反推签发 / 编辑保号）。维度 chip 与复用 sidecar 按它取「当下」
   *  title/body（改名/改正文跟随）；旧数据无 id，回退「图 + 标题」寻址。 */
  id?: string | null;
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
  /** 当时真正提交给 provider 的最终指令（含视觉设定注入与 provider 包装）。 */
  appliedPrompt?: string | null;
  // 未铺开的编辑框原文（会话用户气泡显示它，与右键「复用生成提示词」同一数据）；
  // prompt 则是实际发给 AI 的完整文本（用途注入等），收进「thinking」式折叠。旧数据 / 续轮为 null。
  promptRaw?: string | null;
  images: string[];
  // 本轮实际下发的参考图 store_path（started 事件回填；续轮含后端合并的上一轮产出图）。
  // 气泡上方「附件」缩略图用；首轮展示走 refAssets（完整 asset 带名称），不依赖它。
  refs?: string[];
  // 本轮组稿时挑选的参考图完整 asset（内存态，不入库；chip 气泡 ReadonlyPrompt 用——
  // 与首轮对齐；恢复/回看的会话由历史重建的 GenerationHistoryTurn.ref_assets 填充）。
  refAssets?: Asset[];
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
  // 首轮借用维度源图（图 chip 被删、只借维度的资产，含带车牌的 sections）：
  // 复用生成提示词时随 refs 一起还原，维度 chip 据此回绑车牌取最新反推内容。
  dimAssets?: PromptedAsset[];
  lastRatio: string | null;
  provider: string;
  projectId: string | null; // 首轮项目快照；续轮不随当前项目切换漂移
  /** 首轮冻结的已确认视觉设定；续轮/恢复始终使用同一 profile id/version/hash。 */
  visualProfile?: VisualProfileCapsule | null;
  /** 新任务在后端返回完整胶囊前保存选择；恢复后与 visualProfile.profileId 一致。 */
  visualProfileId?: string | null;
  createdAt: number;
  running: boolean;
  // 即梦 submit_id（Chunk::Submit 回填，恢复续查用）；codex job 为 null。
  submitId?: string | null;
  // 远端任务状态（恢复 worker 回填，展示「远端仍在排队」等）；非恢复 job 为 null。
  remoteStatus?: "querying" | "success" | "fail" | null;
}

/** 即梦远端孤儿任务（启动 `list_task` 比对本地 job 表后，本地无记录的在跑/未取回任务）。 */
export interface JimengOrphanTask {
  submit_id: string;
  prompt: string;
  gen_task_type: string;
  gen_status: string; // querying | success
}

/** 「回看生成对话」：某生成图所在 codex 会话的完整时间线（后端 generation_history 返回）。 */
export interface GenerationHistoryTurn {
  prompt: string;
  applied_prompt?: string | null;
  prompt_raw?: string | null; // 未铺开的原始编辑框文本（复用优先用它还原 chip）；旧 meta 为 null → 回退 prompt
  images: string[]; // store_path
  /** 本轮实际下发的参考图（续轮含上一轮产出图）；旧 meta / 空参考为空。 */
  references?: string[];
  /** 同一批参考图反查的完整 asset（各轮 chip 气泡 ReadonlyPrompt 用）。 */
  ref_assets?: PromptedAsset[];
}

export interface GenerationHistory {
  session_id: string | null;
  turns: GenerationHistoryTurn[];
  /** 首版参考图完整 asset：「复用到创作板」还原参考图 + 「新会话重新生成」派生 store_path。
   *  不入库标注图由 <库根>/annotations/ 缓存合成（含「标注」维度 sections）。 */
  references: PromptedAsset[];
  /** 首版借用维度源图（图 chip 被删、只借维度的资产，含带车牌的 sections）：复用时回绑
   *  车牌取最新反推内容；旧 meta 无此字段为空，前端退化为 prompt_raw 内联正文回绑。 */
  dimension_assets?: PromptedAsset[];
  /** 首版 generation_meta 的 provider：回看重建的 job 用它定续轮坞 provider 初值（即梦会话
   *  不再默认落到 codex）；旧 meta 无此字段为 null。 */
  provider?: string | null;
  /** 该会话启动时冻结的视觉设定；旧记录为 null。 */
  visual_profile?: VisualProfileCapsule | null;
}

/** 应用设置（后端 settings.json 持久化） */
export interface AppSettings {
  auto_analyze_on_ingest: boolean;
  auto_analyze_prompt: string;
  library_root: string | null;
  cloud_auto_understand: boolean;
  board_shift_pick: boolean;
  hide_project_assets: boolean;
  /** 即梦 dreamina CLI 出图模型版本（text2image: 3.0~5.0Pro；image2image 仅 4.0+） */
  dreamina_model_version: string;
  // —— 开发者选项（仅测试账号可见）：对话框 Agent 模式开关，默认只开正式 Agent，
  //    关闭的模式不在创作板 / 会话编辑坞对话框渲染。
  agent_mode_enabled: boolean;
  agent_a_mode_enabled: boolean;
  agent_b_mode_enabled: boolean;
  agent_z_mode_enabled: boolean;
  agent_g_mode_enabled: boolean;
  agent_ds_mode_enabled: boolean;
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
  can_use_agent_runs: boolean;
  max_parallel_agent_runs: number;
  allowed_agent_skills: string[];
  agent_budget_options: string[];
  can_use_visual_profiles: boolean;
}

export type PreferenceFactCategory =
  | "style"
  | "subject"
  | "palette"
  | "composition"
  | "medium"
  | "workflow"
  | "avoid";

export interface PreferenceFact {
  category: PreferenceFactCategory;
  value: string;
  confidence: number;
  evidenceCount: number;
  explicit: boolean;
}

/** Agent 只读偏好胶囊：桌面只发送与本次任务相关的显式/项目级少量事实。 */
export interface PreferenceCapsule {
  schemaVersion: 1;
  scope: { projectId?: string };
  preferred: PreferenceFact[];
  avoid: PreferenceFact[];
  workflow: PreferenceFact[];
  generatedAt: string;
  expiresAt: string;
}

export interface CreditTransaction {
  kind: string;
  amount: number;
  service: string | null;
  meta?: {
    entity_type: "agent_run";
    run_id: string;
    skill_id: string;
    final_status: string;
    actual_credits: number;
  };
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
  /** 测试账号标记（bowerbird_test）：只决定「设置 · 开发者选项」可见性，不参与付费门控。 */
  is_test_account?: boolean;
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
  applied_prompt: string | null;
  submit_id: string | null;
  session_id: string | null;
  conversation_id: string | null;
  project_id: string | null;
  ratio: string | null;
  visual_profile: VisualProfileCapsule | null;
  references: string[];
  created_at: number;
  running: boolean;
}

/** 会话面板历史恢复项（recent_gen_sessions 命令返回）：终态（done/failed）生成 job +
 * 从 generation_meta 重建的各轮时间线（含产出图）。status 取 task_queue 列（权威终态）。 */
export interface RecentGenSession {
  id: string;
  provider: string;
  status: string; // "done" | "failed"
  prompt: string;
  error: string | null;
  session_id: string | null;
  conversation_id: string | null;
  project_id: string | null;
  ratio: string | null;
  visual_profile: VisualProfileCapsule | null;
  references: string[];
  created_at: number;
  turns: GenerationHistoryTurn[];
  /** 首版参考图完整 asset（面板缩略图 / 复用还原；不入库标注图由缓存合成）。 */
  ref_assets: PromptedAsset[];
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
  input: { targetAssetId: string; goal: string; caption?: string | null; visualProfileCapsule?: VisualProfileCapsule | null };
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

export interface CloudAgentPlanStep {
  id: string;
  kind: "direct_generate" | "generate_control_reference" | "edit_from_previous";
  goal: string;
  inputs: Array<{ type: "reference"; referenceId: string } | { type: "step"; stepId: string }>;
  modifies: string[];
  preserves: string[];
  excludes: string[];
  outputRole: "control_reference" | "stage_result" | "final_result";
  rationale: string;
  estimatedUsage: { generateCalls: number; understandCalls: number };
}

export interface CloudAgentPlan {
  schemaVersion: 1;
  intentAnalysisHash: string;
  intentSummary: string;
  strategy: "direct" | "controlled" | "staged_controlled";
  referenceRoles: Array<{
    referenceId: string;
    role: string;
    mustPreserve: string[];
    mustTransfer: string[];
    mustExclude: string[];
  }>;
  assumptions: string[];
  steps: CloudAgentPlanStep[];
}

export interface CloudAgentApproval {
  id: string;
  kind: "controlled_image_edit_plan" | "controlled_image_edit_revision";
  status: "pending" | "approved" | "rejected" | "expired";
  proposal_hash: string;
  planned_tool_count: number;
  requested_at: string;
  expires_at: string;
  estimated_additional_credits: number;
  proposal?: CloudAgentPlan;
}

export interface CloudAgentClarification {
  id: string;
  question_key: string;
  context_hash: string;
  status: "pending" | "answered" | "expired" | "cancelled";
  asked_at: string;
  answered_at?: string | null;
  expires_at: string;
  contentExpired?: boolean;
  question?: {
    questionKey: string;
    contextHash: string;
    question: string;
    recommendedAnswer: string;
    options: string[];
    affectedIntentFields: string[];
    rationale: string;
  };
}

export interface CloudAgentArtifact {
  id: string;
  conversation_id: string;
  kind: string;
  role: "input" | "control_reference" | "stage_result" | "final_result" | "plan";
  step_id?: string | null;
  parent_artifact_id?: string | null;
  mime: string;
  bytes: number;
  sha256: string;
  user_visible: boolean;
  expires_at: string;
  downloaded_at?: string | null;
}

export interface CloudAgentSnapshot {
  conversationId: string;
  run: {
    id: string;
    conversation_id: string;
    status: string;
    current_step?: string | null;
    progress?: number | null;
    skill_id: string;
    skill_version: string;
    planned_tool_count?: number | null;
    budget_credits: number;
    actual_credits?: number | null;
    result_feedback_action?: "accept" | "retry" | null;
    visual_profile_id?: string | null;
    visual_profile_version?: number | null;
    visual_profile_hash?: string | null;
    error_code?: string | null;
    safe_message?: string | null;
  };
  events: Array<{
    seq: number;
    type: string;
    step?: string | null;
    progress?: number | null;
    display_payload?: Record<string, unknown>;
    created_at: string;
  }>;
  approvals: CloudAgentApproval[];
  clarifications?: CloudAgentClarification[];
  artifacts: CloudAgentArtifact[];
  /** 本地 CLI Run 停车 awaiting_local_task 时云端下发的待执行生图任务（其他时刻缺省）。 */
  pendingLocalTask?: {
    callId: string;
    provider: "jimeng" | "codex";
    stepId: string;
    prompt: string;
    ratio?: string | null;
    inputs: Array<{ artifactId: string; role: string; stepId?: string | null; ordinal: number }>;
    expiresAt: string;
  };
}

export interface CloudAgentRunRecord {
  runId: string;
  conversationId: string;
  skillId: string;
  status: string;
  intentPrompt: string;
  referenceAssetIds: string[];
  projectId?: string | null;
  snapshot: CloudAgentSnapshot;
  feedbackAction?: "accept" | "retry" | null;
  finalAssetId?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CloudAgentPreview {
  runId: string;
  artifactId: string;
  path: string;
  mime: string;
  sha256: string;
}

export type CodexChunk =
  | {
      kind: "started";
      job_id: string;
      references?: string[];
      ratio?: string | null;
      applied_prompt?: string | null;
      visual_profile?: VisualProfileCapsule | null;
    }
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

// —— 项目视觉设定 V1（AGENT-RUNTIME-PLAN §8/V1；Rust core/visual_profile.rs 为权威）——

export interface VisualProfileMissingAsset {
  assetId: string;
  name: string;
  /** no_caption | not_parseable */
  reason: string;
}

export interface VisualProfileScopePreview {
  folderId: string;
  folderName: string;
  inFolder: number;
  effective: number;
  missing: VisualProfileMissingAsset[];
  minRequired: number;
}

export interface VisualProfileDraftRule {
  category: string;
  value: string;
  polarity: "must" | "prefer" | "avoid";
  confidence: number;
  supportingAssetIds: string[];
  opposingAssetIds: string[];
  confirmedByUser: boolean;
}

export interface VisualProfileContentTheme {
  value: string;
  supportingAssetIds: string[];
  coverage: number;
  confidence: number;
}

export interface VisualProfileConflict {
  description: string;
  sideA: { value: string; assetIds: string[] };
  sideB: { value: string; assetIds: string[] };
}

export interface VisualProfileCandidateDirection {
  label: string;
  summary: string;
  supportingAssetIds: string[];
  opposingAssetIds: string[];
}

export interface VisualProfileSummary {
  id: string;
  projectId: string;
  folderId: string;
  name: string;
  version: number;
  status: "draft" | "confirmed" | "archived";
  /** local_baseline | cloud_model */
  extractor: string;
  summary: string;
  sourceCount: number;
  ruleCount: number;
  createdAt: number;
  confirmedAt: number | null;
}

export interface VisualProfileDetail extends VisualProfileSummary {
  sourceScopeHash: string;
  rules: VisualProfileDraftRule[];
  contentThemes: VisualProfileContentTheme[];
  conflicts: VisualProfileConflict[];
  candidateDirections: VisualProfileCandidateDirection[];
}

export interface VisualProfileRuleEdit {
  category: string;
  value: string;
  polarity: "must" | "prefer" | "avoid";
  confidence: number;
  supportingAssetIds: string[];
  opposingAssetIds: string[];
  confirmedByUser: boolean;
}

export interface VisualProfileRuleValue {
  category: string;
  value: string;
  polarity: "must" | "prefer" | "avoid";
}

/** 已确认项目视觉设定的只读、版本化快照；生成/Agent 只能读取，不能回写。 */
export interface VisualProfileCapsule {
  schemaVersion: 1;
  profileId: string;
  version: number;
  sourceScopeHash: string;
  summary: string;
  must: VisualProfileRuleValue[];
  prefer: VisualProfileRuleValue[];
  avoid: VisualProfileRuleValue[];
  contentThemes: string[];
  hash: string;
}
