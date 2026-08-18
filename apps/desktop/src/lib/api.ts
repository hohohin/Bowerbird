import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  Analysis,
  AgentPromptInput,
  AgentPromptResult,
  AppSettings,
  AuthSnapshot,
  Asset,
  AssetDeleteMode,
  AssetDeleteResult,
  AssetTag,
  CaptionSection,
  ColorBucket,
  CodexHealth,
  CreationPack,
  DreaminaDeviceFlow,
  EntitlementSnapshot,
  Folder,
  GenerationHistory,
  GenJobSummary,
  LocalAgentRun,
  Preset,
  Project,
  ProjectCreateResult,
  ProjectDeleteMode,
  ProjectDeleteResult,
  PromptedAsset,
  TagCount,
} from "./types";

const IMAGE_EXT = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff", "tif"];

export const api = {
  // 健康检查
  ping: (name: string) => invoke<string>("ping", { name }),
  dbHealth: () => invoke<string>("db_health"),
  localAgentHealth: () => invoke<boolean>("local_agent_health"),
  localAgentStart: (assetId: string, goal: string) =>
    invoke<LocalAgentRun>("local_agent_start", { assetId, goal }),
  localAgentCompilePrompt: (input: AgentPromptInput) =>
    invoke<AgentPromptResult>("local_agent_compile_prompt", { input }),
  localAgentLatest: (assetId: string) =>
    invoke<LocalAgentRun | null>("local_agent_latest", { assetId }),
  localAgentResume: (
    runId: string,
    options: { approval?: boolean; toolResult?: { callId: string; result: unknown } }
  ) =>
    invoke<LocalAgentRun>("local_agent_resume", {
      runId,
      approval: options.approval,
      toolResult: options.toolResult,
    }),
  localAgentFindAssetId: (storePath: string) =>
    invoke<string | null>("local_agent_find_asset_id", { storePath }),

  // 项目 workspace
  createProject: (workspacePath: string) =>
    invoke<ProjectCreateResult>("create_project", { workspacePath }),
  listProjects: () => invoke<Project[]>("list_projects"),
  setActiveProject: (projectId?: string | null) =>
    invoke<void>("set_active_project", { projectId: projectId ?? null }),
  addAssetsToProject: (projectId: string, assetIds: string[]) =>
    invoke<number>("add_assets_to_project", { projectId, assetIds }),
  removeAssetsFromProject: (projectId: string, assetIds: string[]) =>
    invoke<number>("remove_assets_from_project", { projectId, assetIds }),
  deleteProject: (projectId: string, mode: ProjectDeleteMode) =>
    invoke<ProjectDeleteResult>("delete_project", { projectId, mode }),

  // 导入
  importFiles: (sources: string[], projectId?: string | null) =>
    invoke<Asset[]>("import_files", { sources, projectId: projectId ?? null }),
  importFolder: (path: string, projectId?: string | null) =>
    invoke<number>("import_folder", { path, projectId: projectId ?? null }),
  // 拖拽（source=imported）/ 剪切板粘贴（source=clipboard）图片入库：data URL（base64）传后端解码。
  importImageBytes: (req: {
    dataUrl: string;
    fileName?: string | null;
    projectId?: string | null;
    source: string;
  }) =>
    invoke<Asset>("import_image_bytes", {
      dataUrl: req.dataUrl,
      fileName: req.fileName ?? null,
      projectId: req.projectId ?? null,
      source: req.source,
    }),

  // 浏览
  listAssets: (folderId?: string, projectId?: string | null, limit = 500, offset = 0) =>
    invoke<Asset[]>("list_assets", { folderId, projectId: projectId ?? null, limit, offset }),
  searchAssets: (query: string, projectId?: string | null, limit = 500) =>
    invoke<Asset[]>("search_assets", { query, projectId: projectId ?? null, limit }),
  listAssetsSmart: (query: string, projectId?: string | null) =>
    invoke<Asset[]>("list_assets_smart", { query, projectId: projectId ?? null }),
  countAssets: (projectId?: string | null) =>
    invoke<number>("count_assets", { projectId: projectId ?? null }),
  deleteAsset: (id: string) => invoke<void>("delete_asset", { id }),
  /** 右键单素材删除（三选项，与「删除项目」对齐）：keep=仅移出当前项目；move_out=移出园丁鸟；delete=全局物理删除。 */
  deleteAssetWithMode: (
    id: string,
    mode: AssetDeleteMode,
    projectId?: string | null
  ) => invoke<AssetDeleteResult>("delete_asset_with_mode", { id, mode, projectId: projectId ?? null }),
  /** 右键「打开所在文件夹」：原始位置优先，失效回退素材库内位置。 */
  revealAssetFolder: (id: string) => invoke<void>("reveal_asset_folder", { id }),
  moveAssetsToFolder: (assetIds: string[], folderId: string) =>
    invoke<void>("move_assets_to_folder", { assetIds, folderId }),
  // 右键菜单：在资源管理器中定位 / 用默认程序打开（store_path 由前端传，后端直接 spawn，不经 shell scope）。
  revealInFolder: (path: string) => invoke<void>("reveal_path_in_explorer", { path }),
  openWithSystem: (path: string) => invoke<void>("open_path_with_system", { path }),

  // 整理
  listFolders: () => invoke<Folder[]>("list_folders"),
  createFolder: (name: string, parentId?: string) =>
    invoke<string>("create_folder", { name, parentId }),
  createSmartFolder: (name: string, smartQuery: string) =>
    invoke<string>("create_smart_folder", { name, smartQuery }),
  createCollection: (name: string) =>
    invoke<string>("create_collection", { name }),
  listCollections: () => invoke<Folder[]>("list_collections"),
  listAssetCollections: (assetId: string) =>
    invoke<Folder[]>("list_asset_collections", { assetId }),
  addAssetToCollection: (assetId: string, collectionId: string) =>
    invoke<void>("add_asset_to_collection", { assetId, collectionId }),
  removeAssetFromCollection: (assetId: string, collectionId: string) =>
    invoke<void>("remove_asset_from_collection", { assetId, collectionId }),
  listAssetsByCollection: (
    collectionId: string,
    projectId?: string | null,
    limit = 500,
    offset = 0
  ) =>
    invoke<Asset[]>("list_assets_by_collection", {
      collectionId,
      projectId: projectId ?? null,
      limit,
      offset,
    }),
  renameFolder: (id: string, name: string) =>
    invoke<void>("rename_folder", { id, name }),
  deleteFolder: (id: string) => invoke<void>("delete_folder", { id }),

  // 创作板「用途」（preset）：命名 prompt 片段，发送时作为基底注入（类 CLAUDE.md 上下文）。
  createPreset: (name: string, body: string) =>
    invoke<string>("create_preset", { name, body }),
  listPresets: () => invoke<Preset[]>("list_presets"),
  updatePreset: (id: string, name: string, body: string) =>
    invoke<void>("update_preset", { id, name, body }),
  deletePreset: (id: string) => invoke<void>("delete_preset", { id }),

  // 文件选择对话框
  pickImageFiles: async (): Promise<string[]> => {
    const r = await open({
      multiple: true,
      filters: [{ name: "Images", extensions: IMAGE_EXT }],
    });
    if (!r) return [];
    return Array.isArray(r) ? r : [r];
  },
  pickFolder: async (defaultPath?: string): Promise<string | null> => {
    const r = await open({ directory: true, defaultPath });
    return (r as string | null) ?? null;
  },
  releasePresetPack: () => invoke<string>("release_preset_pack"),

  // 创作板（统一走 codex CLI）
  listPromptedAssets: (projectId?: string | null) =>
    invoke<PromptedAsset[]>("list_prompted_assets", { projectId: projectId ?? null }),
  // 有反推（caption）的资产 id 集合（轻量，瀑布流标 🏷️ 用，不带 caption 正文）。
  listCaptionedAssetIds: (projectId?: string | null) =>
    invoke<string[]>("list_captioned_asset_ids", { projectId: projectId ?? null }),
  // 手动重命名素材：同步重命名磁盘文件（store/thumb）+ DB name/store_path/thumb_path。
  renameAsset: (id: string, newName: string) =>
    invoke<void>("rename_asset", { id, newName }),
  // 生成图同流程合并：取某资产的整组过程图（详情轮播 / 批量取可见组）
  listGenerationGroup: (assetId: string, projectId?: string | null) =>
    invoke<Asset[]>("list_generation_group", { assetId, projectId: projectId ?? null }),
  listGenerationGroups: (assetIds: string[], projectId?: string | null) =>
    invoke<Record<string, Asset[]>>("list_generation_groups", {
      assetIds,
      projectId: projectId ?? null,
    }),
  // 「回看生成对话」：取某生成图所在会话的完整生成时间线（各轮 prompt + 产出图 store_path）。
  generationHistory: (assetId: string, projectId?: string | null) =>
    invoke<GenerationHistory>("generation_history", { assetId, projectId: projectId ?? null }),

  // 标签 / 自动归类（P2）
  listTags: (source?: string, projectId?: string | null) =>
    invoke<TagCount[]>("list_tags", { source: source ?? null, projectId: projectId ?? null }),
  listAssetTags: (assetId: string) =>
    invoke<AssetTag[]>("list_asset_tags", { assetId }),
  setAssetTags: (assetId: string, names: string[], source: string) =>
    invoke<void>("set_asset_tags", { assetId, names, source }),
  reclassifyAll: () => invoke<void>("reclassify_all"),

  // 颜色量化（P3）
  paletteOverview: (projectId?: string | null) =>
    invoke<ColorBucket[]>("palette_overview", { projectId: projectId ?? null }),
  listAssetsByColor: (bucket: string, folderId?: string, projectId?: string | null) =>
    invoke<Asset[]>("list_assets_by_color", {
      bucket,
      folderId: folderId ?? null,
      projectId: projectId ?? null,
    }),
  recomputeColors: () => invoke<void>("recompute_colors"),  assemblePack: (assetIds: string[]) =>
    invoke<CreationPack>("assemble_pack", { assetIds }),
  codexGeneratePromptForAsset: (assetId: string, role: string) =>
    invoke<string>("codex_generate_prompt_for_asset", { assetId, role }),
  // Phase 5：反推（codex CLI 描述图片）+ 分析结果
  describeAsset: (assetId: string, instruction?: string, provider?: string) =>
    invoke<string>("codex_describe_asset", { assetId, instruction, provider: provider ?? null }),
  listAnalysesByAsset: (assetId: string) =>
    invoke<Analysis[]>("list_analyses_by_asset", { assetId }),
  openCodexSession: (sessionId: string) =>
    invoke<void>("open_codex_session", { sessionId }),
  deleteAnalysis: (id: string) => invoke<void>("delete_analysis", { id }),
  /** 编辑反推维度内容：sections 整体替换，后端重算 text/dimensions 落库并广播 analyses://changed。 */
  updateCaptionSections: (id: string, sections: CaptionSection[]) =>
    invoke<void>("update_caption_sections", { id, sections }),
  cancelCodexDescribe: () => invoke<void>("cancel_codex_describe"),
  codexHealth: () => invoke<CodexHealth>("codex_health"),
  // 一键安装 codex CLI / OAuth 登录（让 CLI 对用户隐形，B 升级）。
  // 进度经 codex://setup-progress {stage:"install"|"login", line} 推；成功后端 emit codex://health-changed。
  codexInstall: () => invoke<CodexHealth>("codex_install"),
  codexLogin: () => invoke<CodexHealth>("codex_login"),
  cancelCodexSetup: () => invoke<void>("cancel_codex_setup"),
  // force=true 跳过后端 120s TTL 缓存强制重检（重新检测 / 安装 / 登录 / 登出后）。
  dreaminaHealth: (force = false) => invoke<CodexHealth>("dreamina_health", { force }),
  dreaminaLogin: () => invoke<void>("dreamina_login"),
  dreaminaCheckLogin: (deviceCode: string) =>
    invoke<CodexHealth>("dreamina_check_login", { deviceCode }),
  // 拉起系统终端跑 `dreamina login`（真 TTY；app 内 spawn 非 TTY 不写 token，见后端命令注释）。
  openDreaminaLogin: () => invoke<void>("open_dreamina_login"),
  // 一键安装 dreamina CLI（app 内 reqwest 下载二进制，绕过 curl|bash 在 Windows 的坑）。
  // 进度经 dreamina://setup-progress {stage:"install", line} 推；成功后端 emit dreamina://health-changed。
  dreaminaInstall: () => invoke<CodexHealth>("dreamina_install"),
  cancelDreaminaSetup: () => invoke<void>("cancel_dreamina_setup"),
  dreaminaLogout: () => invoke<void>("dreamina_logout"),
  // app 内自动登录（方案 B）：spawn `login --headless` 返回 device flow 字段，前端自动开浏览器 + 展示授权码 + checklogin 补完。
  dreaminaLoginHeadless: () => invoke<DreaminaDeviceFlow>("dreamina_login_headless"),
  // 创作板「生成」：把最终 prompt + 参考图发 codex（codex exec --image，同反推机制）出图。
  // 流式文本经 codex://chunk（Delta）回；生成图 copy 进 library/generations 后随 Done.images 回。
  // sessionId 非空 → codex exec resume 续接同一会话（多轮迭代修改，codex 记得上一张图）。
  // jobId 由前端 crypto.randomUUID 生成：多 job 路由 + per-job 取消引用；续轮复用同 id（后端 upsert）。
  // conversationId：会话级分组（「重新编辑 / 重试」版本分支归组），后端 done 入库时落
  // generation_conversations；anchorSessionId：源会话 session（根 session 补映射用）。
  codexCreateImage: (req: {
    prompt: string;
    referenceImages: string[];
    sessionId?: string | null;
    ratio?: string | null;
    provider?: string | null;
    projectId?: string | null;
    jobId: string;
    promptRaw?: string | null;
    conversationId?: string | null;
    anchorSessionId?: string | null;
  }) =>
    invoke<string>("codex_create_image", {
      prompt: req.prompt,
      referenceImages: req.referenceImages,
      sessionId: req.sessionId ?? null,
      ratio: req.ratio ?? null,
      provider: req.provider ?? null,
      projectId: req.projectId ?? null,
      jobId: req.jobId,
      promptRaw: req.promptRaw ?? null,
      conversationId: req.conversationId ?? null,
      anchorSessionId: req.anchorSessionId ?? null,
    }),
  cancelCodexCreate: (jobId: string) => invoke<void>("cancel_codex_create", { jobId }),
  // 启动恢复（Task 5）：列出未完成生成 job，前端挂载时拉取重建 genJobs（恢复中 job 可见）。
  listGenJobs: () => invoke<GenJobSummary[]>("list_gen_jobs"),
  // 扩展小白化：连接状态 + 扩展文件夹路径（引导「一键复制」用，不自动打开——Windows 上不稳）。
  extensionStatus: () => invoke<boolean>("extension_status"),
  extensionFolderPath: () => invoke<string>("extension_folder_path"),
  // 设置
  getSettings: () => invoke<AppSettings>("get_settings"),
  updateSettings: (settings: AppSettings) =>
    invoke<void>("update_settings", { settings }),
  libraryRoot: () => invoke<string>("library_root"),
  migrateLibraryRoot: (newRoot: string) =>
    invoke<void>("migrate_library_root", { newRoot }),
  restartApp: () => invoke<void>("restart_app"),
  // Bowerbird 账号（token 只留 Rust/keychain，前端仅看脱敏 snapshot）。
  cloudAuthSnapshot: () => invoke<AuthSnapshot>("cloud_auth_snapshot"),
  cloudStartEmailLogin: (email: string) =>
    invoke<void>("cloud_start_email_login", { email }),
  cloudRestoreSession: () => invoke<AuthSnapshot>("cloud_restore_session"),
  cloudLogout: () => invoke<AuthSnapshot>("cloud_logout"),
  cloudEntitlement: () => invoke<EntitlementSnapshot>("cloud_entitlement"),
  cloudSyncEntitlement: () =>
    invoke<EntitlementSnapshot>("cloud_sync_entitlement"),
};
