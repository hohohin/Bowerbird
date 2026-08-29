import { create } from "zustand";
import { api } from "./lib/api";
import {
  canStartAnotherJob,
  canUseByo,
  canUseGenerationProvider,
  understandProvider,
} from "./lib/entitlement";
import type {
  AppSettings,
  AuthSnapshot,
  Asset,
  CaptionSection,
  CloudAgentRunRecord,
  CodexChunk,
  CodexHealth,
  ColorBucket,
  EntitlementSnapshot,
  Folder,
  GenJob,
  GenTurn,
  JimengOrphanTask,
  Preset,
  Project,
  PromptedAsset,
  RecentGenSession,
  TagCount,
  VisualProfileSummary,
} from "./lib/types";
import { canonicalProviderKey, isCloudProvider, isKnownGenProvider } from "./lib/genProviders";
import { normalizeAnnotationPrompt } from "./lib/annotationPrompt";
import { autoRatioFromReferences } from "./components/creation/ratios";

// —— 默认出图 provider（localStorage，照 GEN_PROVIDERS 枚举校验；收藏星标写它）——
const DEFAULT_PROVIDER_KEY = "bowerbird.defaultProvider";
const VISUAL_PROFILE_KEY_PREFIX = "bowerbird.visualProfile.";
function loadDefaultProvider(): string {
  try {
    const v = localStorage.getItem(DEFAULT_PROVIDER_KEY);
    return v && isKnownGenProvider(v) ? canonicalProviderKey(v) : "codex";
  } catch {
    return "codex";
  }
}
function saveDefaultProvider(v: string) {
  try {
    localStorage.setItem(DEFAULT_PROVIDER_KEY, v);
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

// —— 默认反推引擎（localStorage；"auto"=按账号档位自动路由，其余跳过每次的引擎选择浮层）——
const DEFAULT_UNDERSTAND_KEY = "bowerbird.defaultUnderstandProvider";
const UNDERSTAND_PROVIDERS = ["auto", "bowerbird-cloud", "codex"] as const;
export type UnderstandProviderPref = (typeof UNDERSTAND_PROVIDERS)[number];
function loadDefaultUnderstandProvider(): string {
  try {
    const v = localStorage.getItem(DEFAULT_UNDERSTAND_KEY);
    return v && (UNDERSTAND_PROVIDERS as readonly string[]).includes(v) ? v : "auto";
  } catch {
    return "auto";
  }
}
/** 反推引擎是否当下可用（与 DescribeProviderPicker 的门控一致）：Cloud 需登录+有余额；codex 需 Pro+ 且本机就绪。 */
export function understandEngineUsable(
  s: { cloudAuth: AuthSnapshot | null; cloudEntitlement: EntitlementSnapshot | null; codexHealth: CodexHealth | null },
  provider: "bowerbird-cloud" | "codex",
): boolean {
  if (provider === "codex") return canUseByo(s.cloudEntitlement) && !!s.codexHealth?.ok;
  const balances = s.cloudEntitlement
    ? s.cloudEntitlement.balances.daily + s.cloudEntitlement.balances.sub + s.cloudEntitlement.balances.topup
    : 0;
  return !!s.cloudAuth?.cloud_available && !!s.cloudAuth.logged_in && balances > 0;
}

type Mode = "browse" | "manage";

/** 生成会话底部编辑坞的两种入口：「重新编辑」（新版本分支）与底部对话框（会话内续轮）。 */
export type GenEditingMode = "edit" | "revise";

export interface DescribeFailure {
  assetId: string;
  instruction: string;
  name: string;
  provider?: string;
  reason: string;
  failedAt: number;
}

/** 反推引擎选择 Picker 的待执行任务（批量 / 单张），由各反推入口打开 Picker 时传入。 */
export type DescribeTask =
  | { kind: "batch"; ids: string[]; instruction: string }
  | { kind: "single"; assetId: string; instruction: string };

interface State {
  assets: Asset[];
  total: number;
  selectedIds: Set<string>;
  rangeAnchorId: string | null; // Shift 范围多选锚点（最近一次点击选中的卡片）
  loading: boolean;
  currentFolderId: string | null;
  currentCollectionId: string | null;
  colorFilter: string | null; // 颜色桶 key（P3，后端 list_assets_by_color 查询）
  palette: ColorBucket[]; // 全库色板（侧栏渲染，后端 palette_overview）
  searchQuery: string; // FTS5 搜索；空串 = 不搜
  smartFilter: string | null; // 智能查询（如 source:codex），与文件夹/搜索互斥；侧栏「✨ 生成图」用
  mode: Mode;
  detailAssetId: string | null; // 浏览模式打开的详情页资产
  folders: Folder[];
  // —— 项目 workspace ——
  projects: Project[];
  currentProjectId: string | null;
  reloadProjects: () => Promise<void>;
  enterProject: (id: string) => Promise<void>;
  exitProject: () => Promise<void>;
  visualProfiles: VisualProfileSummary[];
  activeVisualProfileId: string | null;
  reloadVisualProfiles: () => Promise<void>;
  setActiveVisualProfile: (id: string | null) => void;
  // —— 自动归类（P2）——
  autoTags: TagCount[]; // 侧栏「自动归类」分区（source='auto' tag + 计数）
  classifyProgress: { done: number; total: number } | null; // 批量重归类进度
  colorRebuild: { done: number; total: number } | null; // 重建色板进度（P3）
  // —— 创作板（核心枢纽）——
  // 创作模式激活态（对话框本身常驻显示，boardOpen 只表示「已进入创作模式」）：
  // 编辑框获得焦点时激活（等同旧「创作板」按钮），编辑框右上角 X 退出。激活时
  // 点图插 chip / 瀑布流默认全量挑图 + 蓝线框 + 顶部「创作模式」刘海；未激活则是
  // 普通浏览（点图开详情、筛选生效）。会话「重新编辑」坞（genEditing）期间对话框
  // 由 App 派生隐藏（两个 useCreationEditor 互斥）。
  boardOpen: boolean;
  setBoardActive: (active: boolean) => void;
  promptedAssets: PromptedAsset[]; // 创作板挑图集合中带 caption（反推）的子集，供编辑器补 sections / 展开维度片段
  promptedAssetsLoaded: boolean; // promptedAssets 是否与库同步（false=补拉中，维度环加载态提示用）
  captionedIds: Set<string>; // 有反推（caption）的资产 id 集合（瀑布流标 🏷️，轻量，不带正文）
  focusAssetId: string | null; // 创作板 chip 点击 → 瀑布流滚动定位+高亮的目标 id（消费后清空）
  // —— 维度环形菜单（CaptionRing，长按图片呼出，全局单例挂 App 根）——
  captionRing: string | null; // 打开中的环会话（assetId）；null = 收起
  ringAssetId: string | null; // 最近一次呼环的 assetId（环收起后保留，供 smartPunct 取该图 sections）
  // 点扇区待插入当前编辑器的维度（assetId = 呼环图：目标编辑器缺该图 chip 时先补插，
  // 保证插入形状是「@图片【维度】」；板未开→先开板，挂载后消费）
  pendingKeyword: { title: string; body: string; assetId?: string; sectionId?: string | null } | null;
  // 「开启 Agent 模式再试」待激活信号（会话详情出图气泡底部链接置位）：CreationBoard
  // 挂载后消费——打开正式 Agent 开关并复位其余 Agent 开关（互斥同按钮点击）。
  pendingAgentArm: boolean;
  armBoardAgent: () => void;
  clearPendingAgentArm: () => void;
  // —— 创作板「用途」（preset）——
  presets: Preset[]; // 命名 prompt 预设，发送时作为基底注入（不进编辑器）
  activePresetId: string | null; // 当前选中用途；null=不注入
  setAssets: (a: Asset[]) => void;
  setTotal: (n: number) => void;
  toggleSelect: (id: string) => void;
  selectRange: (toId: string, orderedIds: string[]) => void;
  selectAll: () => void;
  clearSelect: () => void;
  setLoading: (b: boolean) => void;
  setCurrentFolder: (id: string | null) => void;
  setCurrentCollection: (id: string | null) => void;
  setColorFilter: (c: string | null) => void;
  setSearchQuery: (q: string) => void;
  setSmartFilter: (q: string | null) => void;
  enterManage: () => void;
  exitManage: () => void;
  openDetail: (id: string) => void;
  closeDetail: () => void;
  setFolders: (f: Folder[]) => void;
  reloadFolders: () => Promise<void>;
  reloadPresets: () => Promise<void>;
  setAutoTags: (t: TagCount[]) => void;
  reloadAutoTags: () => Promise<void>;
  setPalette: (p: ColorBucket[]) => void;
  reloadPalette: () => Promise<void>;
  setClassifyProgress: (p: { done: number; total: number } | null) => void;
  setColorRebuild: (p: { done: number; total: number } | null) => void;
  setPromptedAssets: (a: PromptedAsset[]) => void;
  setCaptionedIds: (ids: string[]) => void;
  focusAsset: (id: string) => void;
  clearFocusAsset: () => void;
  openCaptionRing: (assetId: string) => void;
  closeCaptionRing: () => void;
  pickCaptionSection: (section: CaptionSection, assetId?: string) => void;
  clearPendingKeyword: () => void;
  setActivePreset: (id: string | null) => void;
  // —— 反推（全局后台串行）——
  // 反推不绑 AssetDetail 生命周期：返回瀑布流后继续跑、缩略图角标可见、可取消。
  // 单槽 + 前端排队：同一时刻只调一次 codex_describe_asset（后端 DESCRIBE_CANCEL 单例）。
  describingId: string | null;
  describingName: string | null; // 反推中素材名（随队列捕获，切视图仍可显示）
  describeQueue: { assetId: string; instruction: string; name: string; provider?: string }[];
  describeFailures: DescribeFailure[]; // 当前会话失败记录，供右上角 AI 任务清单展示/重试
  describeStartedAt: number | null; // 当前任务开始时间戳；跨组件已耗时显示用
  runDescribe: (assetId: string, instruction: string, provider?: string) => void;
  cancelDescribe: (assetId: string) => Promise<void>;
  retryDescribeFailure: (assetId: string) => void;
  dismissDescribeFailure: (assetId: string) => void;
  describePicker: { task: DescribeTask; anchor: { x: number; y: number } } | null;
  openDescribePicker: (task: DescribeTask, anchor: { x: number; y: number }) => void;
  closeDescribePicker: () => void;
  runDescribePicker: (provider: string) => void;
  // —— 生成会话底部编辑坞（jimeng/gemini 式）：会话面板收成底部编辑坞，露出瀑布流选图插 chip ——
  // 独立于 boardOpen：编辑坞自带一个 useCreationEditor（同一对 board-load-prompt / board-asset-picked
  // 事件），进入时必须关创作板避免双编辑器同时响应；退出编辑即恢复会话全屏视图。
  // "edit" = 首轮气泡「重新编辑」（载入首轮组稿，发送开新版本分支）；
  // "revise" = 底部对话框（空编辑器，发送在会话下方追加一轮对话）。
  genEditing: GenEditingMode | null;
  setGenEditing: (v: GenEditingMode | null) => void;
  // —— 生成（创作板 codex/即梦 画图，多 job 并行）——
  // 派生量：任一 job running 即 true。状态圈在顶部工具栏最右侧（全局可见，不绑创作板生命周期）。
  generating: boolean;
  // —— 导入即基础分析（autoname，后台 fire-and-forget）——
  // 在途计数（后端 codex://auto-active 事件推来）；>0 顶部状态圈算「分析中」。
  autoAnalyzing: number;
  setAutoAnalyzing: (n: number) => void;
  // —— codex 可用性（App 挂载取一次；创作板/生成面板共用，约定 7 置灰依据）——
  codexHealth: CodexHealth | null;
  setCodexHealth: (h: CodexHealth | null) => void;
  // 扩展连接状态（心跳/采集触发；App 挂载取 + listen collect://extension-connected/disconnected）。
  extensionConnected: boolean;
  setExtensionConnected: (v: boolean) => void;
  // 统一「环境状态」总览已并入设置面板（模型设置/系统设置直接唤起各子引导）。
  codexOnboardingForceOpen: boolean;
  setCodexOnboardingForceOpen: (v: boolean) => void;
  extensionOnboardingForceOpen: boolean;
  setExtensionOnboardingForceOpen: (v: boolean) => void;
  dreaminaOnboardingForceOpen: boolean;
  setDreaminaOnboardingForceOpen: (v: boolean) => void;
  accountOnboardingForceOpen: boolean;
  setAccountOnboardingForceOpen: (v: boolean) => void;
  // 新手引导 tour（阶段 B）：spotlight 分步引导，废弃自动注入后用 tour 教导入 + 复用 + 创作。
  // step 0=入口弹窗；1=新建项目；2=导入中；3=首图右键；4=菜单复用；5=编辑框；6=维度；7=结束。
  tourActive: boolean;
  tourStep: number;
  tourImported: boolean; // step 2「导入中」是否完成（完成后【下一步】按钮才出现）
  setTourActive: (v: boolean) => void;
  setTourStep: (n: number) => void;
  setTourImported: (v: boolean) => void;
  startTour: () => void;
  endTour: () => void;
  // —— 应用设置（从后端 settings.json 加载）——
  settings: AppSettings | null;
  loadSettings: () => Promise<void>;
  updateSettings: (s: AppSettings) => Promise<void>;
  // —— Bowerbird 账号与权益（token 不进前端）——
  cloudAuth: AuthSnapshot | null;
  cloudEntitlement: EntitlementSnapshot | null;
  cloudBusy: boolean;
  cloudError: string | null;
  loadCloudAccount: () => Promise<void>;
  startCloudEmailLogin: (email: string) => Promise<void>;
  startCloudWechatLogin: () => Promise<string>;
  syncCloudEntitlement: () => Promise<void>;
  reconcileCloudEntitlement: () => Promise<void>;
  logoutCloud: () => Promise<void>;
  setCloudAuth: (snapshot: AuthSnapshot) => void;
  setCloudError: (error: string | null) => void;
  // —— 即梦（dreamina）可用性 + 出图 provider 切换（Phase 3）——
  dreaminaHealth: CodexHealth | null;
  setDreaminaHealth: (h: CodexHealth | null) => void;
  defaultProvider: string; // 全局默认出图 provider（"codex"/"jimeng"，localStorage 持久化）
  setDefaultProvider: (p: string) => void;
  // —— 默认反推引擎（设置「模型设置」可选并持久化）——
  defaultUnderstandProvider: string; // "auto" | "bowerbird-cloud" | "codex"
  setDefaultUnderstandProvider: (p: string) => void;
  activeGenProvider: string; // 当前会话出图 provider（创作板切换条改它，初值=defaultProvider，不持久化）
  setActiveGenProvider: (p: string) => void;
  // —— dreamina 登录流程（OAuth Device Flow；dreamina://login 逐行透传 stdout）——
  dreaminaLoginLines: string[];
  dreaminaLoginActive: boolean;
  setDreaminaLoginActive: (b: boolean) => void;
  pushDreaminaLoginLine: (line: string) => void;
  clearDreaminaLogin: () => void;
  // —— 浏览器扩展采集 ——
  // 扩展连上本地 WS 后后端 emit collect://extension-connected；采集入库 emit library://assets-changed 带 name。
  collectedNotice: string | null; // 最近一次采集入库的素材名；null=不显提示
  setCollectedNotice: (name: string | null) => void;
  // —— 生成结果面板（多 job；主区覆盖层，可随时开合，状态在 store 不丢）——
  genPanelOpen: boolean;
  activeSessionKind: "generation" | "agent";
  cloudAgentRuns: Record<string, CloudAgentRunRecord>;
  cloudAgentRunOrder: string[];
  activeCloudAgentRunId: string | null;
  genJobs: Record<string, GenJob>; // 所有生成会话（首轮创建，续轮追加 turn）
  genJobOrder: string[]; // job 创建顺序（侧栏 Status 任务列表稳定排序）
  activeJobId: string | null; // 当前查看/操作的 job（续轮/复用/取消/重试基于它）
  genUnread: boolean; // 面板关时落地新图 → 顶栏按钮红点
  // 即梦远端孤儿任务（启动 list_task 比对发现；会话面板生成 tab 顶部「取回」入口）。
  jimengOrphans: JimengOrphanTask[];
  setJimengOrphans: (tasks: JimengOrphanTask[]) => void;
  retrieveJimengOrphan: (submitId: string) => Promise<void>;
  dismissJimengOrphan: (submitId: string) => void;
  setActiveJob: (id: string) => void;
  openCloudAgentRun: (run: CloudAgentRunRecord) => void;
  updateCloudAgentRun: (run: CloudAgentRunRecord) => void;
  loadCloudAgentRuns: () => Promise<void>;
  // 删除生成任务记录（仅前端 genJobs 记录；不取消后端任务、不删已入库图片）。
  removeGenJob: (id: string) => void;
  setGenPanelOpen: (open: boolean) => void;
  startGeneration: (prompt: string, references: Asset[], ratio?: string | null, provider?: string | null, rawPrompt?: string, conversationId?: string, anchorSessionId?: string, dimensionSources?: PromptedAsset[], visualProfileId?: string | null) => Promise<string>;
  // 续轮（底部对话框发送）：instruction = 铺开后实际发送的 prompt；opts 携带编辑框原文
  // （气泡展示）、新挑参考图与比例（jimeng/Cloud 的上一轮产出图由后端权威合并下发）；
  // exactReferences = 轮级重试/编辑的精确重放（该轮当时实际下发的完整参考图，后端跳过合并）。
  sendGenRevise: (
    instruction: string,
    provider?: string | null,
    opts?: {
      rawPrompt?: string | null;
      references?: Asset[];
      ratio?: string | null;
      exactReferences?: string[];
    },
  ) => Promise<void>;
  cancelGeneration: (jobId?: string) => void; // 默认取消 activeJob
  loadGenJobs: () => Promise<void>;
  applyGenChunk: (c: CodexChunk) => void;
  // 重试 activeJob 末尾失败轮：首轮失败 → startGeneration（新建 job 重发），续轮失败 → sendGenRevise（resume 续接）。
  retryLastGenTurn: () => void;
  // 「回看生成对话」：拉某生成图所在会话的历史时间线 → 新建 running=false 的 job 并选中，
  // 复用 GenerationPanel 展示 + 续轮 resume（sessionId=历史 sid）。
  viewGenerationHistory: (assetId: string) => Promise<void>;
  // 「复用到创作板」：把首轮 prompt + 参考图载入创作板编辑器。
  // 开创作板 + 关详情/生成面板/挑图态，延时一帧再 dispatch board-load-prompt，
  // 确保 CreationBoard 已挂载注册 listener（同步 dispatch 会丢）。
  // refs 显式传入优先（右键菜单按 generation_history 复用，含「不入库」标注图的缓存合成）；
  // 缺省取 activeJob（GenerationPanel 复用）。
  reusePromptToBoard: (prompt: string, refs?: PromptedAsset[], dimRefs?: PromptedAsset[]) => void;
  // 「标注插入创作板」：注入临时素材（不入库）到当前编辑器。生成面板编辑坞打开 → 原地插入
  // 不动面板；否则保开创作板 + 延一帧 dispatch board-asset-injected（挂载时序同上）。
  insertAnnotatedToBoard: (asset: PromptedAsset) => void;
  // 「详情页 → 添加到对话框」：关详情回主界面，滚动定位 + 蓝框闪烁（focusAsset 既有机制），
  // 延一帧插参考图 chip（对话框随详情关闭才挂载，同 reusePromptToBoard 的帧等待）；
  // 该图有维度数据则同时呼出维度环（环点扇区继续挑维度）。
  addAssetToBoardFromDetail: (assetId: string) => void;
  // —— 图片标注面板（右键菜单唤起，全局单实例）——
  annotator: { assetId: string } | null;
  openAnnotator: (assetId: string) => void;
  closeAnnotator: () => void;
  // —— 右键菜单（瀑布流缩略图 / 详情页大图）——
  contextMenu: { x: number; y: number; assetId: string } | null;
  openContextMenu: (x: number, y: number, assetId: string) => void;
  closeContextMenu: () => void;
  // —— 项目右键菜单（侧栏项目行 / 收起态圆标）——
  projectContextMenu: { x: number; y: number; projectId: string } | null;
  openProjectContextMenu: (x: number, y: number, projectId: string) => void;
  closeProjectContextMenu: () => void;
  // —— 项目视觉设定（V1：项目内普通文件夹「提炼视觉设定」弹窗）——
  visualProfileFolder: { id: string; name: string } | null;
  openVisualProfile: (folder: { id: string; name: string }) => void;
  closeVisualProfile: () => void;
}

function normalizeGenerationProvider(provider: string): string {
  return provider === "codex-cli" || !provider ? "codex" : provider;
}

function generationGateError(state: State, provider: string): string | null {
  if (!canUseGenerationProvider(state.cloudEntitlement, provider)) {
    return "当前账号不可使用本机生成引擎；升级 Pro 解锁 Codex / 即梦 CLI";
  }
  const runningCount = Object.values(state.genJobs).filter((job) => job.running).length;
  if (!canStartAnotherJob(state.cloudEntitlement, runningCount)) {
    return "已达当前账号档位的并行生成上限";
  }
  return null;
}

function taskErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error && error.message) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export const useStore = create<State>((set, get) => {
  async function reconcileRejectedCloudSession(message: string) {
    if (!message.includes("登录已失效") && !message.includes("请先登录 Bowerbird")) return;
    try {
      const cloudAuth = await api.cloudAuthSnapshot();
      if (cloudAuth.logged_in) return;
      const cloudEntitlement = await api.cloudEntitlement();
      set({
        cloudAuth,
        cloudEntitlement,
        cloudError: "登录已失效，请重新登录",
        activeGenProvider: "bowerbird-cloud-image_hd",
      });
    } catch {
      // 原业务错误仍会展示；这里只做后端已清理会话后的前端快照对齐。
    }
  }

  // 反推队列的串行推进：同一时刻只跑一个 codex_describe_asset（后端单槽）。
  // runDescribe 入队后调一次；任务结束（成功/取消/失败）的 finally 再调一次推下一张。
  // 放在 create 闭包里而非 state 上，避免被组件意外调用。
  async function pumpDescribe() {
    if (get().describingId) return;
    const queue = get().describeQueue;
    const next = queue[0];
    if (!next) return;
    set({
      describeQueue: queue.slice(1),
      describingId: next.assetId,
      describingName: next.name,
      describeStartedAt: Date.now(),
    });
    try {
      await api.describeAsset(next.assetId, next.instruction, next.provider);
    } catch (e) {
      const msg = taskErrorMessage(e);
      await reconcileRejectedCloudSession(msg);
      // 「已取消」是用户主动中断，静默；其它错误留在 AI 任务清单，便于看原因和重试。
      if (!msg.includes("已取消")) {
        console.error("describe failed", e);
        set((s) => ({
          describeFailures: [
            {
              assetId: next.assetId,
              instruction: next.instruction,
              name: next.name,
              provider: next.provider,
              reason: msg || "未知错误",
              failedAt: Date.now(),
            },
            ...s.describeFailures.filter((failure) => failure.assetId !== next.assetId),
          ].slice(0, 20),
        }));
      }
    } finally {
      // 仅当仍是本次任务时清空（cancel 路径已让后端返回「已取消」走 catch）。
      if (get().describingId === next.assetId) {
        set({ describingId: null, describingName: null, describeStartedAt: null });
      }
      void pumpDescribe();
    }
  }

  // —— 生成对话：turn id 计数 + per-job 更新/错误处理（内部，不暴露）——
  let genTurnSeq = 0;
  function nextGenTurnId() {
    genTurnSeq += 1;
    return genTurnSeq;
  }
  // 更新单个 job（按 id）并重算全局 generating（任一 job running 即 true）。job 不存在则空操作
  // （如后端事件到达但前端无此 job —— 理论不发生，稳健处理）。extra 随本次 set 一并合并。
  function updateJob(id: string, fn: (j: GenJob) => GenJob, extra: Partial<State> = {}) {
    set((s) => {
      const prev = s.genJobs[id];
      if (!prev) return {};
      const next = fn(prev);
      const genJobs = { ...s.genJobs, [id]: next };
      return {
        genJobs,
        generating: Object.values(genJobs).some((j) => j.running),
        ...extra,
      };
    });
  }
  // 把一次生成失败落到指定 job：
  //  - 未出图的占位轮 → 记 error 成「失败轮」（时间线可见 + 可重试），不追加 streaming（避免与
  //    TurnView 失败态重复；streaming 保留 codex 本次叙述性 delta 作诊断上下文）。
  //  - 已出图后的后置失败（done 已到、meta/caption 写库失败）→ 不污染成功轮，错误降级进 streaming。
  function applyGenError(id: string, msg: string) {
    updateJob(id, (j) => {
      if (j.turns.length === 0) return j;
      const last = j.turns[j.turns.length - 1];
      if (last.images.length === 0) {
        return {
          ...j,
          turns: [
            ...j.turns.slice(0, -1),
            // 失败也结算用时（用户关心失败前跑了多久）。
            { ...last, error: msg, durationMs: last.startedAt ? Date.now() - last.startedAt : last.durationMs },
          ],
        };
      }
      return { ...j, streaming: j.streaming + `\n[error: ${msg}]` };
    });
  }
  function genHandleError(id: string, msg: string) {
    if (msg.includes("已取消")) {
      // 用户主动取消：删末尾空轮 + streaming 标「已取消」，不算失败、不留红字轮。
      updateJob(id, (j) => ({
        ...j,
        streaming: j.streaming + "\n\n—— 已取消",
        turns:
          j.turns.length > 0 && j.turns[j.turns.length - 1].images.length === 0
            ? j.turns.slice(0, -1)
            : j.turns,
      }));
      return;
    }
    applyGenError(id, msg);
  }

  return {
  assets: [],
  total: 0,
  selectedIds: new Set(),
  rangeAnchorId: null,
  loading: false,
  currentFolderId: null,
  currentCollectionId: null,
  colorFilter: null,
  searchQuery: "",
  smartFilter: null,
  mode: "browse",
  detailAssetId: null,
  folders: [],
  projects: [],
  currentProjectId: null,
  autoTags: [],
  classifyProgress: null,
  colorRebuild: null,
  palette: [],
  boardOpen: false, // 创作模式未激活（对话框仍常驻显示；focus 编辑框激活）
  promptedAssets: [],
  promptedAssetsLoaded: false,
  captionedIds: new Set<string>(),
  focusAssetId: null,
  captionRing: null,
  ringAssetId: null,
  pendingKeyword: null,
  pendingAgentArm: false,
  presets: [],
  activePresetId: null,
  setAssets: (assets) => set({ assets }),
  setTotal: (total) => set({ total }),
  toggleSelect: (id) =>
    set((s) => {
      const next = new Set(s.selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selectedIds: next, rangeAnchorId: id };
    }),
  // Shift 范围多选：以锚点为起点，在 orderedIds（瀑布流可见顺序）里框出 [锚, 目标] 闭区间
  // 并入选中集——可反复 Shift 叠加不同范围；锚不在当前列表（换夹/列表变化）时退化为单选并改锚。
  selectRange: (toId, orderedIds) =>
    set((s) => {
      const next = new Set(s.selectedIds);
      const ai = s.rangeAnchorId ? orderedIds.indexOf(s.rangeAnchorId) : -1;
      const ti = orderedIds.indexOf(toId);
      if (ai < 0 || ti < 0) {
        next.add(toId);
        return { selectedIds: next, rangeAnchorId: toId };
      }
      const [lo, hi] = ai <= ti ? [ai, ti] : [ti, ai];
      for (let i = lo; i <= hi; i++) next.add(orderedIds[i]);
      return { selectedIds: next };
    }),
  clearSelect: () => set({ selectedIds: new Set(), rangeAnchorId: null }),
  selectAll: () => set((s) => ({ selectedIds: new Set(s.assets.map((a) => a.id)) })),
  setLoading: (loading) => set({ loading }),
  // 切文件夹保留颜色筛选（P3：folder + color 叠加）；清详情 + smartFilter/收藏夹（互斥）。
  setCurrentFolder: (currentFolderId) =>
    set({ currentFolderId, currentCollectionId: null, detailAssetId: null, smartFilter: null }),
  // 收藏夹是独立 scope：不与普通文件夹/颜色/搜索/智能查询叠加。
  setCurrentCollection: (currentCollectionId) =>
    set({
      currentCollectionId,
      currentFolderId: null,
      detailAssetId: null,
      smartFilter: null,
      searchQuery: "",
      colorFilter: null,
    }),
  // 颜色与 smartFilter/search/收藏夹互斥（保留 folder 叠加）。
  setColorFilter: (colorFilter) =>
    set({ colorFilter, currentCollectionId: null, smartFilter: null, searchQuery: "" }),
  setSearchQuery: (searchQuery) =>
    set({
      searchQuery,
      currentCollectionId: null,
      detailAssetId: null,
      smartFilter: null,
      colorFilter: null,
    }),
  // 智能查询（如 source:codex）与文件夹/收藏夹/搜索互斥：设它就清 folder/colorFilter。
  setSmartFilter: (smartFilter) =>
    set({
      smartFilter,
      currentFolderId: null,
      currentCollectionId: null,
      colorFilter: null,
      detailAssetId: null,
    }),
  enterManage: () => set({ mode: "manage", detailAssetId: null }),
  exitManage: () => set({ mode: "browse", selectedIds: new Set(), rangeAnchorId: null }),
  openDetail: (detailAssetId) => set({ detailAssetId }),
  closeDetail: () => set({ detailAssetId: null }),
  setFolders: (folders) => set({ folders }),
  reloadFolders: async () => {
    try {
      set({ folders: await api.listFolders() });
    } catch (e) {
      console.error("reloadFolders failed", e);
    }
  },
  reloadProjects: async () => {
    try {
      const projects = await api.listProjects();
      const current = get().currentProjectId;
      if (current && !projects.some((project) => project.id === current)) {
        await api.setActiveProject(null);
        set({
          projects,
          currentProjectId: null,
          currentFolderId: null,
          currentCollectionId: null,
          colorFilter: null,
          searchQuery: "",
          smartFilter: null,
          detailAssetId: null,
          selectedIds: new Set(),
          mode: "browse",
          activePresetId: null,
          visualProfiles: [],
          activeVisualProfileId: null,
        });
      } else {
        set({ projects });
      }
    } catch (e) {
      console.error("reloadProjects failed", e);
    }
  },
  enterProject: async (id) => {
    await api.setActiveProject(id);
    set({
      currentProjectId: id,
      currentFolderId: null,
      currentCollectionId: null,
      colorFilter: null,
      searchQuery: "",
      smartFilter: null,
      detailAssetId: null,
      selectedIds: new Set(),
      mode: "browse",
      activePresetId: null,
    });
    await get().reloadVisualProfiles();
  },
  exitProject: async () => {
    await api.setActiveProject(null);
    set({
      currentProjectId: null,
      currentFolderId: null,
      currentCollectionId: null,
      colorFilter: null,
      searchQuery: "",
      smartFilter: null,
      detailAssetId: null,
      selectedIds: new Set(),
      mode: "browse",
      activePresetId: null,
      visualProfiles: [],
      activeVisualProfileId: null,
    });
  },
  visualProfiles: [],
  activeVisualProfileId: null,
  reloadVisualProfiles: async () => {
    const projectId = get().currentProjectId;
    if (!projectId) {
      set({ visualProfiles: [], activeVisualProfileId: null });
      return;
    }
    try {
      const visualProfiles = await api.visualProfileList(projectId, null);
      const confirmed = visualProfiles.filter((profile) => profile.status === "confirmed");
      const current = get().activeVisualProfileId;
      let activeVisualProfileId = current && confirmed.some((profile) => profile.id === current)
        ? current
        : null;
      if (!activeVisualProfileId) {
        try {
          const saved = localStorage.getItem(`${VISUAL_PROFILE_KEY_PREFIX}${projectId}`);
          activeVisualProfileId = saved && confirmed.some((profile) => profile.id === saved) ? saved : null;
        } catch {
          activeVisualProfileId = null;
        }
      }
      set({ visualProfiles, activeVisualProfileId });
    } catch (error) {
      console.error("reloadVisualProfiles failed", error);
    }
  },
  setActiveVisualProfile: (activeVisualProfileId) => {
    const projectId = get().currentProjectId;
    if (!projectId) return;
    if (activeVisualProfileId && !get().visualProfiles.some(
      (profile) => profile.id === activeVisualProfileId && profile.status === "confirmed",
    )) return;
    try {
      if (activeVisualProfileId) localStorage.setItem(`${VISUAL_PROFILE_KEY_PREFIX}${projectId}`, activeVisualProfileId);
      else localStorage.removeItem(`${VISUAL_PROFILE_KEY_PREFIX}${projectId}`);
    } catch {
      // localStorage unavailable: keep the current-process selection.
    }
    set({ activeVisualProfileId });
  },
  reloadPresets: async () => {
    try {
      set({ presets: await api.listPresets() });
    } catch (e) {
      console.error("reloadPresets failed", e);
    }
  },
  setAutoTags: (autoTags) => set({ autoTags }),
  reloadAutoTags: async () => {
    try {
      set({ autoTags: await api.listTags("auto", get().currentProjectId) });
    } catch (e) {
      console.error("reloadAutoTags failed", e);
    }
  },
  setPalette: (palette) => set({ palette }),
  reloadPalette: async () => {
    try {
      set({ palette: await api.paletteOverview(get().currentProjectId) });
    } catch (e) {
      console.error("reloadPalette failed", e);
    }
  },
  setClassifyProgress: (classifyProgress) => set({ classifyProgress }),
  setColorRebuild: (colorRebuild) => set({ colorRebuild }),
  // —— 创作板 ——
  // 创作模式开关：激活 = 编辑框获得焦点（CreationBoard onFocus → setBoardActive(true)，
  // 等同旧 toggleBoard 开启语义：收详情页/会话面板让瀑布流可挑图）；退出 = 编辑框右上角 X。
  setBoardActive: (active) =>
    set({
      boardOpen: active,
      ...(active
        ? {
            detailAssetId: null,
            // 两个 useCreationEditor（创作板 + 编辑坞）互斥，激活即退出编辑坞
            // （正常情况对话框在编辑坞期间不可见，此处是防御）。
            genEditing: null,
            // 会话面板盖住瀑布流，激活创作模式先收起（生成照常后台跑，圆点可回看）。
            genPanelOpen: false,
          }
        : {}),
    }),  setPromptedAssets: (promptedAssets) => set({ promptedAssets, promptedAssetsLoaded: true }),
  setCaptionedIds: (ids) => set({ captionedIds: new Set(ids) }),
  focusAsset: (id) => set({ focusAssetId: id }),
  clearFocusAsset: () => set({ focusAssetId: null }),
  // —— 维度环 ——
  openCaptionRing: (assetId) => {
    set({ captionRing: assetId, ringAssetId: assetId });
    // 环是全局单例（任意模式长按呼出），但 promptedAssets 只在板开/编辑坞时由 App.refresh
    // 拉取——板外呼环时这里是空的，有反推的图也会显示「无维度」。目标图不在集合里
    // （未加载过 / 数据过期）就按需补拉一次，CaptionRing 响应式订阅到数据后自动补扇区。
    const s = get();
    if (s.promptedAssets.some((a) => a.id === assetId)) return;
    set({ promptedAssetsLoaded: false });
    api
      .listPromptedAssets(s.currentProjectId)
      .then((prompted) => set({ promptedAssets: prompted, promptedAssetsLoaded: true }))
      .catch((e) => {
        console.error("load promptedAssets for ring failed", e);
        set({ promptedAssetsLoaded: true }); // 失败也解除加载态，退回「无维度」空环提示
      });
  },
  closeCaptionRing: () => set({ captionRing: null }),
  // 点扇区 = 维度插进当前编辑器：板已激活或会话编辑坞开着（genEditing）时不动模式——
  // 当前挂载的编辑器实例（板 / 坞，App 派生互斥挂载）直接消费 pendingKeyword，编辑坞
  // 期间不再退出坞打断续轮编辑；两者都没开才激活创作板（板实例挂载后消费）。
  pickCaptionSection: (section, assetId) =>
    set((s) => ({
      ...(s.boardOpen || s.genEditing
        ? {}
        : { boardOpen: true, detailAssetId: null, genEditing: null, genPanelOpen: false }),
      pendingKeyword: {
        title: section.title,
        body: section.body ?? "",
        assetId,
        sectionId: section.id ?? null,
      },
    })),
  clearPendingKeyword: () => set({ pendingKeyword: null }),
  armBoardAgent: () => set({ pendingAgentArm: true }),
  clearPendingAgentArm: () => set({ pendingAgentArm: false }),
  setActivePreset: (id) => set({ activePresetId: id }),
  // —— 反推（全局后台串行）——
  describingId: null,
  describingName: null,
  describeQueue: [],
  describeFailures: [],
  describeStartedAt: null,
  runDescribe: (assetId, instruction, provider) => {
    const trimmed = instruction.trim();
    if (!trimmed) return;
    const s = get();
    // provider 省略时沿用自动路由（Pro→codex、免费→Cloud）；显式指定时仍按权益门控（免费不能选 codex）。
    const route = provider ?? understandProvider(s.cloudEntitlement);
    const denyReason =
      route === null
        ? "当前账号没有可用的理解引擎"
        : route === "codex"
          ? !canUseByo(s.cloudEntitlement)
            ? "升级 Pro 解锁本机 codex 反推"
            : !s.codexHealth?.ok
              ? s.codexHealth?.reason || "codex 不可用"
              : null
          : !s.cloudAuth?.cloud_available || !s.cloudAuth.logged_in
            ? "反推需要先登录 Bowerbird Cloud"
            : null;
    if (denyReason) {
      set({ cloudError: denyReason });
      return;
    }
    // 同一张图不重复入队（正在跑或已排队）。
    if (
      s.describingId === assetId ||
      s.describeQueue.some((q) => q.assetId === assetId)
    ) {
      return;
    }
    set({
      describeQueue: [
        ...s.describeQueue,
        {
          assetId,
          instruction: trimmed,
          name: s.assets.find((a) => a.id === assetId)?.name ?? "未知素材",
          provider: route ?? undefined,
        },
      ],
      describeFailures: s.describeFailures.filter((failure) => failure.assetId !== assetId),
    });
    void pumpDescribe();
  },
  cancelDescribe: async (assetId) => {
    const s = get();
    if (s.describingId === assetId) {
      // 正在跑：后端 kill 子进程 → codex_describe_asset 返回「已取消」
      // → pumpDescribe 的 await reject → finally 清空 describingId 并推进下一张。
      try {
        await api.cancelCodexDescribe();
      } catch (e) {
        console.error(e);
      }
      return;
    }
    // 还在排队：直接移出队列，不打断当前任务。
    const idx = s.describeQueue.findIndex((q) => q.assetId === assetId);
    if (idx >= 0) {
      const q = [...s.describeQueue];
      q.splice(idx, 1);
      set({ describeQueue: q });
    }
  },
  retryDescribeFailure: (assetId) => {
    const failure = get().describeFailures.find((item) => item.assetId === assetId);
    if (!failure) return;
    get().runDescribe(failure.assetId, failure.instruction, failure.provider);
  },
  dismissDescribeFailure: (assetId) =>
    set((s) => ({
      describeFailures: s.describeFailures.filter((failure) => failure.assetId !== assetId),
    })),
  describePicker: null,
  openDescribePicker: (task, anchor) => {
    // 设置了默认反推引擎（非 auto）且该引擎当下可用 → 跳过选择浮层直接执行；
    // 引擎不可用（未登录/积分不足/CLI 未装）时退回浮层让用户看着原因选。
    const s = get();
    const pref = s.defaultUnderstandProvider;
    if (pref === "bowerbird-cloud" || pref === "codex") {
      if (understandEngineUsable(s, pref)) {
        if (task.kind === "batch") {
          for (const id of task.ids) get().runDescribe(id, task.instruction, pref);
          get().exitManage();
        } else {
          get().runDescribe(task.assetId, task.instruction, pref);
        }
        return;
      }
    }
    set({ describePicker: { task, anchor } });
  },
  closeDescribePicker: () => set({ describePicker: null }),
  runDescribePicker: (provider) => {
    const p = get().describePicker;
    if (!p) return;
    const { task } = p;
    if (task.kind === "batch") {
      for (const id of task.ids) get().runDescribe(id, task.instruction, provider);
      get().exitManage();
    } else {
      get().runDescribe(task.assetId, task.instruction, provider);
    }
    set({ describePicker: null });
  },
  // —— 生成（创作板 codex 画图）——
  generating: false,
  // —— 导入即基础分析（autoname）——
  autoAnalyzing: 0,
  setAutoAnalyzing: (autoAnalyzing) => set({ autoAnalyzing }),
  // —— codex 可用性 ——
  codexHealth: null,
  setCodexHealth: (codexHealth) => set({ codexHealth }),
  extensionConnected: false,
  setExtensionConnected: (extensionConnected) => set({ extensionConnected }),
  codexOnboardingForceOpen: false,
  setCodexOnboardingForceOpen: (codexOnboardingForceOpen) =>
    set({ codexOnboardingForceOpen }),
  extensionOnboardingForceOpen: false,
  setExtensionOnboardingForceOpen: (extensionOnboardingForceOpen) =>
    set({ extensionOnboardingForceOpen }),
  dreaminaOnboardingForceOpen: false,
  setDreaminaOnboardingForceOpen: (dreaminaOnboardingForceOpen) =>
    set({ dreaminaOnboardingForceOpen }),
  accountOnboardingForceOpen: false,
  setAccountOnboardingForceOpen: (accountOnboardingForceOpen) =>
    set({ accountOnboardingForceOpen }),
  tourActive: false,
  tourStep: 0,
  tourImported: false,
  setTourActive: (tourActive) => set({ tourActive }),
  setTourStep: (tourStep) => set({ tourStep }),
  setTourImported: (tourImported) => set({ tourImported }),
  startTour: () => set({ tourActive: true, tourStep: 0, tourImported: false }),
  endTour: () => {
    localStorage.setItem("bowerbird.tutorialSeen", "1");
    set({ tourActive: false, tourStep: 0, tourImported: false });
  },
  // —— 应用设置 ——
  settings: null,
  loadSettings: async () => {
    try {
      set({ settings: await api.getSettings() });
    } catch (e) {
      console.error("loadSettings failed", e);
    }
  },
  updateSettings: async (settings) => {
    try {
      await api.updateSettings(settings);
      set({ settings });
    } catch (e) {
      console.error("updateSettings failed", e);
    }
  },
  // —— Bowerbird 账号与权益 ——
  cloudAuth: null,
  cloudEntitlement: null,
  cloudBusy: false,
  cloudError: null,
  setCloudAuth: (cloudAuth) => set({ cloudAuth }),
  setCloudError: (cloudError) => set({ cloudError }),
  loadCloudAccount: async () => {
    set({ cloudBusy: true, cloudError: null });
    try {
      let cloudAuth = await api.cloudAuthSnapshot();
      if (!cloudAuth.logged_in) {
        try {
          cloudAuth = await api.cloudRestoreSession();
        } catch {
          // 没有 keychain 凭据/离线时仍展示脱敏未登录 snapshot。
        }
      }
      let cloudEntitlement = await api.cloudEntitlement();
      if (cloudAuth.logged_in) {
        try {
          cloudEntitlement = await api.cloudSyncEntitlement();
        } catch {
          // 离线时保留 Rust 已按签名/宽限期降级后的缓存结果。
        }
      }
      set((s) => ({
        cloudAuth,
        cloudEntitlement,
        activeGenProvider: canUseGenerationProvider(cloudEntitlement, s.defaultProvider)
          ? s.defaultProvider
          : "bowerbird-cloud-image_hd",
      }));
    } catch (e) {
      set({ cloudError: typeof e === "string" ? e : "账号状态读取失败" });
    } finally {
      set({ cloudBusy: false });
    }
  },
  startCloudEmailLogin: async (email) => {
    set({ cloudBusy: true, cloudError: null });
    try {
      await api.cloudStartEmailLogin(email);
    } catch (e) {
      set({ cloudError: typeof e === "string" ? e : "登录邮件发送失败" });
      throw e;
    } finally {
      set({ cloudBusy: false });
    }
  },
  startCloudWechatLogin: async () => {
    set({ cloudBusy: true, cloudError: null });
    try {
      // 返回系统浏览器要打开的二维码页；扫码后经 bowerbird://wechat/callback 回流。
      return await api.cloudStartWechatLogin();
    } catch (e) {
      set({ cloudError: typeof e === "string" ? e : "微信登录发起失败" });
      throw e;
    } finally {
      set({ cloudBusy: false });
    }
  },
  syncCloudEntitlement: async () => {
    set({ cloudBusy: true, cloudError: null });
    try {
      const cloudEntitlement = await api.cloudSyncEntitlement();
      set((s) => ({
        cloudEntitlement,
        activeGenProvider: canUseGenerationProvider(cloudEntitlement, s.defaultProvider)
          ? s.defaultProvider
          : "bowerbird-cloud-image_hd",
      }));
    } catch (e) {
      const message = taskErrorMessage(e) || "权益同步失败";
      set({ cloudError: message });
      await reconcileRejectedCloudSession(message);
    } finally {
      set({ cloudBusy: false });
    }
  },
  // 静默对账：缓存 Fresh 时只是本地读；降级（重启/超 6h/同步失败）时 Rust 会在线自愈，
  // 顺带把 Rust 侧因门控操作恢复的权益带回 store——修复 Pro 被显示成 free 直到手动刷新。
  reconcileCloudEntitlement: async () => {
    const state = get();
    if (!state.cloudAuth?.logged_in) return;
    try {
      const cloudEntitlement = await api.cloudEntitlement();
      set((s) => ({
        cloudEntitlement,
        activeGenProvider: canUseGenerationProvider(cloudEntitlement, s.defaultProvider)
          ? s.defaultProvider
          : "bowerbird-cloud-image_hd",
      }));
    } catch {
      // 静默失败：下一次轮询或手动刷新再试。
    }
  },
  logoutCloud: async () => {
    set({ cloudBusy: true, cloudError: null });
    try {
      const cloudAuth = await api.cloudLogout();
      const cloudEntitlement = await api.cloudEntitlement();
      set({ cloudAuth, cloudEntitlement, activeGenProvider: "bowerbird-cloud-image_hd" });
    } catch (e) {
      set({ cloudError: typeof e === "string" ? e : "登出失败" });
    } finally {
      set({ cloudBusy: false });
    }
  },
  // —— 即梦 + provider（Phase 3）——
  dreaminaHealth: null,
  setDreaminaHealth: (dreaminaHealth) => set({ dreaminaHealth }),
  defaultProvider: loadDefaultProvider(),
  setDefaultProvider: (defaultProvider) => {
    if (!canUseGenerationProvider(get().cloudEntitlement, defaultProvider)) return;
    saveDefaultProvider(defaultProvider);
    // 改默认同步切当前选择（用户期望「默认」生效立即）。
    set({ defaultProvider, activeGenProvider: defaultProvider });
  },
  defaultUnderstandProvider: loadDefaultUnderstandProvider(),
  setDefaultUnderstandProvider: (p) => {
    if (!(UNDERSTAND_PROVIDERS as readonly string[]).includes(p)) return;
    try {
      localStorage.setItem(DEFAULT_UNDERSTAND_KEY, p);
    } catch {
      /* localStorage 不可用时忽略 */
    }
    set({ defaultUnderstandProvider: p });
  },
  activeGenProvider: loadDefaultProvider(),
  setActiveGenProvider: (activeGenProvider) => {
    if (!canUseGenerationProvider(get().cloudEntitlement, activeGenProvider)) return;
    set({ activeGenProvider });
  },
  dreaminaLoginLines: [],
  dreaminaLoginActive: false,
  setDreaminaLoginActive: (dreaminaLoginActive) => set({ dreaminaLoginActive }),
  pushDreaminaLoginLine: (line) =>
    set((s) => ({ dreaminaLoginLines: [...s.dreaminaLoginLines, line] })),
  clearDreaminaLogin: () => set({ dreaminaLoginLines: [], dreaminaLoginActive: false }),
  // —— 浏览器扩展采集 ——
  collectedNotice: null,
  setCollectedNotice: (collectedNotice) => set({ collectedNotice }),
  genEditing: null,
  // 进入编辑坞不动 boardOpen（常驻 true）：App 按 boardOpen && !genEditing 派生隐藏
  // 创作板对话框（两个 useCreationEditor 互斥）；退出坞（v=null）对话框自动回来。
  setGenEditing: (v) =>
    set(
      v
        ? { genEditing: v, detailAssetId: null }
        : { genEditing: null },
    ),
  // —— 生成结果面板（多 job）——
  genPanelOpen: false,
  activeSessionKind: "generation",
  cloudAgentRuns: {},
  cloudAgentRunOrder: [],
  activeCloudAgentRunId: null,
  genJobs: {},
  genJobOrder: [],
  activeJobId: null,
  genUnread: false,
  jimengOrphans: [],
  setJimengOrphans: (tasks) => set({ jimengOrphans: tasks }),
  retrieveJimengOrphan: async (submitId) => {
    const orphan = get().jimengOrphans.find((t) => t.submit_id === submitId);
    if (!orphan) return;
    // 先从列表移除（防重复点击）；后端 job id 固定 orphan-{submit_id} 亦幂等。
    set((s) => ({ jimengOrphans: s.jimengOrphans.filter((t) => t.submit_id !== submitId) }));
    try {
      await api.jimengRetrieveOrphan(submitId, orphan.prompt);
    } catch (error) {
      console.error("jimengRetrieveOrphan failed", error);
      // 失败放回列表，用户可再试。
      set((s) => ({ jimengOrphans: [...s.jimengOrphans, orphan] }));
    }
  },
  dismissJimengOrphan: (submitId) =>
    set((s) => ({ jimengOrphans: s.jimengOrphans.filter((t) => t.submit_id !== submitId) })),
  setGenPanelOpen: (open) =>
    set((s) => ({ genPanelOpen: open, genUnread: open ? false : s.genUnread })),
  setActiveJob: (id) => set({ activeJobId: id, activeSessionKind: "generation" }),
  openCloudAgentRun: (run) => set((s) => ({
    cloudAgentRuns: { ...s.cloudAgentRuns, [run.runId]: run },
    cloudAgentRunOrder: s.cloudAgentRuns[run.runId]
      ? s.cloudAgentRunOrder
      : [run.runId, ...s.cloudAgentRunOrder],
    activeCloudAgentRunId: run.runId,
    activeSessionKind: "agent",
    genPanelOpen: true,
    genEditing: null,
    detailAssetId: null,
    genUnread: false,
  })),
  updateCloudAgentRun: (run) => set((s) => ({
    cloudAgentRuns: { ...s.cloudAgentRuns, [run.runId]: run },
    cloudAgentRunOrder: s.cloudAgentRuns[run.runId]
      ? s.cloudAgentRunOrder
      : [run.runId, ...s.cloudAgentRunOrder],
  })),
  loadCloudAgentRuns: async () => {
    try {
      const runs = await api.cloudAgentList();
      if (runs.length === 0) return;
      const cloudAgentRuns = Object.fromEntries(runs.map((run) => [run.runId, run]));
      const needsAttention = runs.find((run) =>
        !["succeeded", "failed", "cancelled"].includes(run.status)
        || (run.status === "succeeded" && !run.finalAssetId));
      set({
        cloudAgentRuns,
        cloudAgentRunOrder: runs.map((run) => run.runId),
        activeCloudAgentRunId: needsAttention?.runId ?? null,
        ...(needsAttention
          ? { activeSessionKind: "agent" as const, genPanelOpen: true, genEditing: null }
          : {}),
      });
    } catch (error) {
      console.error("loadCloudAgentRuns failed", error);
    }
  },
  removeGenJob: (id) => {
    // 已完成（非在跑）会话的移除同步删 task_queue 终态行——重启恢复不再出现该会话；
    // 在跑 job 的行留给恢复链路（前端移除仍只动内存），「回看生成对话」的临时 job 无行、删除为空操作。
    const j = get().genJobs[id];
    if (j && !j.running) void api.dismissGenJob(id).catch(console.error);
    set((s) => {
      if (!s.genJobs[id]) return s;
      const genJobs = { ...s.genJobs };
      delete genJobs[id];
      const genJobOrder = s.genJobOrder.filter((x) => x !== id);
      const activeJobId =
        s.activeJobId === id ? (genJobOrder.length > 0 ? genJobOrder[genJobOrder.length - 1] : null) : s.activeJobId;
      const generating = Object.values(genJobs).some((x) => x.running);
      return { genJobs, genJobOrder, activeJobId, generating };
    });
  },
  loadGenJobs: async () => {
    // 启动恢复：① 未完成 job（queued/running）重建 genJobs（恢复中 job 在面板可见）；
    // ② 最近终态会话（done/failed）从 generation_meta 重建时间线 —— 会话面板跨重启保留
    // （done 会话可回看续轮，failed 会话可重试；cancelled 用户显式取消过、不恢复）。
    try {
      const [jobs, recent] = await Promise.all([
        api.listGenJobs(),
        api.recentGenSessions().catch((): RecentGenSession[] => []), // 历史恢复失败不阻断在跑恢复
      ]);
      set((s) => {
        const genJobs = { ...s.genJobs };
        const genJobOrder = [...s.genJobOrder];
        const seenSessions = new Set(
          Object.values(s.genJobs)
            .map((x) => x.sessionId)
            .filter((x): x is string => !!x),
        );
        // 终态会话旧→新追加（genJobOrder 顺序即面板顺序，reverse 后最新在前）。
        for (const r of [...recent].reverse()) {
          if (genJobs[r.id]) continue; // 已存在（本轮新发）不覆盖
          const failed = r.status === "failed";
          const turns: GenTurn[] = r.turns.map((t) => ({
            id: nextGenTurnId(),
            prompt: t.prompt,
            appliedPrompt: t.applied_prompt ?? null,
            promptRaw: t.prompt_raw ?? null,
            images: t.images,
            refs: t.references ?? undefined,
            refAssets: t.ref_assets,
          }));
          if (failed) {
            // 失败态标记在最后一轮：面板 ❌ + 生成面板重试入口（错误文本只活在内存，不入库）。
            const err = r.error ?? "生成失败";
            if (turns.length > 0) turns[turns.length - 1] = { ...turns[turns.length - 1], error: err };
            else turns.push({ id: nextGenTurnId(), prompt: r.prompt, promptRaw: null, images: [], error: err });
          }
          genJobs[r.id] = {
            id: r.id,
            conversationId: r.conversation_id ?? undefined,
            turns,
            sessionId: r.session_id,
            streaming: "",
            lastPrompt: turns[0]?.prompt ?? r.prompt,
            lastRefs: r.references,
            refAssets: r.ref_assets,
            lastRatio: r.ratio ?? null,
            provider: r.provider,
            projectId: r.project_id ?? null,
            visualProfile: r.visual_profile,
            visualProfileId: r.visual_profile?.profileId ?? null,
            createdAt: r.created_at,
            running: false,
            submitId: null,
            remoteStatus: null,
          };
          genJobOrder.push(r.id);
          if (r.session_id) seenSessions.add(r.session_id);
        }
        let firstRecoveredId: string | null = null;
        for (const j of jobs) {
          if (genJobs[j.id]) continue; // 已存在（用户本轮新发）不覆盖
          if (j.session_id && seenSessions.has(j.session_id)) continue; // 同 session 已有终态行，避免双份
          genJobs[j.id] = {
            id: j.id,
            turns: [{
              id: nextGenTurnId(),
              prompt: j.prompt,
              appliedPrompt: j.applied_prompt ?? null,
              images: [],
              provider: j.provider,
            }],
            sessionId: j.session_id ?? j.submit_id ?? null,
            conversationId: j.conversation_id ?? undefined,
            streaming: "",
            lastPrompt: j.prompt,
            lastRefs: j.references ?? [],
            refAssets: [],
            lastRatio: j.ratio ?? null,
            provider: j.provider,
            projectId: j.project_id ?? null,
            visualProfile: j.visual_profile,
            visualProfileId: j.visual_profile?.profileId ?? null,
            createdAt: j.created_at,
            running: j.running,
            submitId: j.submit_id ?? null,
            remoteStatus: j.running ? "querying" : null,
          };
          if (!genJobOrder.includes(j.id)) genJobOrder.push(j.id);
          if (firstRecoveredId === null) firstRecoveredId = j.id;
        }
        const generating = Object.values(genJobs).some((x) => x.running);
        // 有恢复中 job → 自动弹面板 + 选中首个（历史会话恢复不弹，与 startGeneration 自动弹一致）。
        return firstRecoveredId
          ? { genJobs, genJobOrder, generating, genPanelOpen: true, activeSessionKind: "generation" as const, activeJobId: s.activeJobId ?? firstRecoveredId }
          : { genJobs, genJobOrder, generating };
      });
    } catch (e) {
      console.error("loadGenJobs failed", e);
    }
  },
  startGeneration: async (prompt, references, ratio, provider, rawPrompt, conversationId, anchorSessionId, dimensionSources, visualProfileId) => {
    // 多 job：不再因 generating 阻塞（并发发起多个生成，各自独立流转）。
    // provider 兜底：调用点没传（CreationBoard send / retry）→ 当前选择 → 全局默认。
    const prov = normalizeGenerationProvider(
      provider ?? get().activeGenProvider ?? get().defaultProvider,
    );
    const gateError = generationGateError(get(), prov);
    if (gateError) throw new Error(gateError);
    // 用途（preset）注入：选中用途时，其 body 作为基底拼在用户组稿前（类 CLAUDE.md 上下文，
    // 不进编辑器）。续轮 sendGenRevise 不注入——用途是首轮基底，续轮是修改意见。
    const pid = get().activePresetId;
    const preset = pid ? get().presets.find((p) => p.id === pid) : null;
    const combinedPrompt = preset ? `${preset.body}\n\n${prompt}` : prompt;
    // 标注参数按 provider 能力改写；仅改写实际发送文本，编辑器原文不变。
    const sentPrompt = normalizeAnnotationPrompt(combinedPrompt, prov);
    const refPaths = references
      .map((r) => r.store_path)
      .filter((p): p is string => !!p);
    // 「自动」比例（null/空）：有参考图时跟随首张参考图的宽高比吸附到档位、显式下发——
    // 即梦 omit --ratio 会固定回退 16:9（竖屏参考图也被横切）；解析不了（无参考图/无尺寸）
    // 维持「自动」交引擎默认。落 lastRatio 供续轮坞与重试继承。
    const sentRatio = ratio?.trim() ? ratio : autoRatioFromReferences(references);
    const selectedVisualProfileId = visualProfileId === undefined
      ? get().activeVisualProfileId
      : visualProfileId;
    // 前端生成 jobId：创建 GenJob 即知 id，chunk 按 id 路由无 race；后端 task_queue upsert。
    const jobId = crypto.randomUUID();
    // 会话级分组（含普通 job：conversationId 兜底 jobId）——后端 done 入库时落
    // generation_conversations（session → conversation），重启后瀑布流分组不丢。
    const conv = conversationId ?? jobId;
    const job: GenJob = {
      id: jobId,
      conversationId: conv,
      turns: [{ id: nextGenTurnId(), prompt: sentPrompt, promptRaw: rawPrompt ?? null, images: [], refAssets: references, provider: prov, startedAt: Date.now() }],
      sessionId: null,
      streaming: "",
      lastPrompt: sentPrompt,
      lastRefs: refPaths,
      refAssets: references,
      dimAssets: dimensionSources ?? [],
      lastRatio: sentRatio,
      provider: prov,
      projectId: get().currentProjectId,
      visualProfileId: selectedVisualProfileId,
      createdAt: Date.now(),
      running: true,
    };
    set((s) => ({
      genJobs: { ...s.genJobs, [jobId]: job },
      genJobOrder: [...s.genJobOrder, jobId],
      activeJobId: jobId, // 新发 job 自动选中（续轮/复用/取消聚焦它）
      activeSessionKind: "generation",
      genPanelOpen: true, // 自动弹面板给即时反馈（创作板在右槽仍可编辑）
      genUnread: false,
      generating: true, // 新 job running → 至少此 job 在跑
    }));
    try {
      await api.codexCreateImage({
        jobId,
        prompt: sentPrompt,
        promptRaw: rawPrompt,
        // 借用维度源图 id（图 chip 被删、只借维度）：随 generation_meta 落库，复用时回绑车牌。
        dimensionSources: dimensionSources?.map((a) => a.id) ?? [],
        referenceImages: refPaths,
        ratio: sentRatio,
        provider: prov,
        projectId: job.projectId,
        visualProfileId: selectedVisualProfileId,
        conversationId: conv,
        // 版本分支才锚定源会话（源 session 可能是旧版生成 / 回看历史，还没有 conversation 映射）。
        anchorSessionId: conversationId ? anchorSessionId ?? null : null,
      });
    } catch (e) {
      const message = taskErrorMessage(e);
      await reconcileRejectedCloudSession(message);
      genHandleError(jobId, message);
      updateJob(jobId, (j) => ({ ...j, running: false }));
    }
    return jobId;
  },
  sendGenRevise: async (instruction, provider, opts) => {
    const id = get().activeJobId;
    if (!id) return;
    const job = get().genJobs[id];
    const text = instruction.trim();
    if (!job || !job.sessionId || !text) return;
    const prov = normalizeGenerationProvider(
      provider ?? job.provider ?? get().activeGenProvider ?? get().defaultProvider,
    );
    const gateError = generationGateError(get(), prov);
    if (gateError) throw new Error(gateError);
    const sentText = normalizeAnnotationPrompt(text, prov);
    // 续轮参考图：只传坞内显式挑选的图。jimeng/Cloud 的「上一轮产出图」由后端权威合并
    // （codex_create_image 从 generation_meta 取会话最后有图轮，与这里挑的图合并去重、
    // 上一轮产出在前、截前 10）——前端 job.turns 是易失内存（重启恢复/回看重建可能缺历史轮），
    // 且旧逻辑「挑了图就完全替代」会把上一轮生成图挤掉（修改意见里 @ 素材图即复现）。
    // codex resume 自带会话上下文，同样只吃显式挑选的参考图。
    // exactReferences（轮级重试/编辑）：列表即该轮当时实际下发的完整参考图，直发、后端
    // 跳过合并——重试第 N 轮用当时的基图，而不是该轮自己产出的图。
    const reviseRefs = (opts?.references ?? [])
      .map((r) => r.store_path)
      .filter((p): p is string => !!p);
    const exactRefs = opts?.exactReferences?.length ? opts.exactReferences : undefined;
    // 续轮复用同 jobId（同一会话）；后端 task_queue upsert 刷新回 running。
    updateJob(id, (j) => ({
      ...j,
      turns: [
        ...j.turns,
        {
          id: nextGenTurnId(),
          prompt: sentText,
          promptRaw: opts?.rawPrompt ?? null,
          images: [],
          // 坞内组稿挑选的参考图（chip 气泡渲染用）；合并的上一轮产出图走 refs（started 回填）。
          refAssets: opts?.references ?? [],
          provider: prov,
          startedAt: Date.now(),
        },
      ],
      streaming: "",
      running: true,
    }));
    try {
      await api.codexCreateImage({
        jobId: id,
        prompt: sentText,
        promptRaw: opts?.rawPrompt ?? null,
        referenceImages: exactRefs ?? reviseRefs,
        exactReferences: !!exactRefs,
        sessionId: job.sessionId,
        // 会话分组透传：续轮 upsert 整包覆盖 task_queue payload，不传会把持久化的
        // conversation_id 抹成 null——重启后该会话在会话面板脱离它的版本分组。
        conversationId: job.conversationId ?? null,
        // 比例只传坞内显式选档；「自动」由后端按第一参考图（续轮=上一轮产出图）吸附档位——
        // 即梦 omit --ratio 固定回退 16:9，此前续轮 auto 落 16:9 横切竖图。
        ratio: opts?.ratio?.trim() ? opts.ratio : null,
        provider: prov,
        projectId: job.projectId,
        visualProfileId: job.visualProfileId ?? job.visualProfile?.profileId ?? null,
      });
    } catch (e) {
      const message = taskErrorMessage(e);
      await reconcileRejectedCloudSession(message);
      genHandleError(id, message);
      updateJob(id, (j) => ({ ...j, running: false }));
    }
  },
  cancelGeneration: (jobId) => {
    const id = jobId ?? get().activeJobId;
    if (!id) return;
    void api.cancelCodexCreate(id).catch(console.error);
  },
  retryLastGenTurn: () => {
    const s = get();
    const id = s.activeJobId;
    if (!id) return;
    const job = s.genJobs[id];
    if (!job) return;
    const provider = normalizeGenerationProvider(job.provider);
    const targetHealthy = isCloudProvider(provider)
      ? !!s.cloudAuth?.cloud_available && !!s.cloudAuth.logged_in
      : provider === "jimeng"
        ? !!s.dreaminaHealth?.ok
        : !!s.codexHealth?.ok;
    if (!targetHealthy || generationGateError(s, provider)) return;
    const last = job.turns[job.turns.length - 1];
    if (!last?.error) return; // 没有失败轮可重试
    if (job.sessionId) {
      // 续轮失败：先移除失败轮再 resume，重试轮顶替原位（避免同 prompt 编号递增的重复轮）。
      // 参考图精确重放该轮当时实际下发的完整列表（started 事件已记录，含当时的基图）；
      // 恢复重建的失败轮无 refs 时退回正常合并路径。
      updateJob(id, (j) => ({ ...j, turns: j.turns.slice(0, -1) }));
      void s.sendGenRevise(last.prompt, provider, {
        rawPrompt: last.promptRaw ?? undefined,
        references: last.refAssets,
        exactReferences: last.refs?.length ? last.refs : undefined,
      });
    } else {
      // 首轮失败：startGeneration 新建 job 重发（旧失败 job 保留可切回查看）。
      void s.startGeneration(
        job.lastPrompt,
        job.refAssets,
        job.lastRatio,
        provider,
        job.turns[0]?.promptRaw ?? undefined,
        undefined,
        undefined,
        undefined,
        job.visualProfileId ?? job.visualProfile?.profileId ?? null,
      );
    }
  },
  applyGenChunk: (c) => {
    if (c.kind === "started") {
      // started = 后端已定本轮最终参考图与比例（续轮含合并的上一轮产出图 / 自动档已按
      // 第一参考图吸附）→ refs 落到该轮（气泡上方「附件」缩略图）、lastRatio 同步实际值
      // （续轮坞比例初值不再滞留首轮）。首轮展示走 refAssets（完整 asset），refs 仅兜底。
      const sid = c.job_id;
      if (sid && (c.references || c.ratio || c.applied_prompt || c.visual_profile)) {
        updateJob(sid, (j) => {
          const last = j.turns[j.turns.length - 1];
          const turns = last
            ? [
                ...j.turns.slice(0, -1),
                {
                  ...last,
                  refs: c.references ?? last.refs,
                  appliedPrompt: c.applied_prompt ?? last.appliedPrompt,
                },
              ]
            : j.turns;
          return {
            ...j,
            turns,
            lastRatio: c.ratio ?? j.lastRatio,
            visualProfile: c.visual_profile ?? j.visualProfile,
            visualProfileId: c.visual_profile?.profileId ?? j.visualProfileId,
          };
        });
      }
      return;
    }
    if (c.kind === "submit") {
      // 即梦 submit_id 到（Chunk::Submit 回填）：记录到 job，纯展示（恢复续查用）。
      const sid = c.job_id;
      if (sid) updateJob(sid, (j) => ({ ...j, submitId: c.submit_id, remoteStatus: "querying" }));
      return;
    }
    if (c.kind === "recover_started") {
      // 后端启动恢复：自包含造占位 job（防 done 早于 loadGenJobs 丢事件）。
      const rid = c.job_id;
      if (!rid) return;
      set((s) => {
        if (s.genJobs[rid]) return {}; // 已在（loadGenJobs 已拉到）
        const job: GenJob = {
          id: rid,
          turns: [{ id: nextGenTurnId(), prompt: c.prompt, images: [], provider: c.provider }],
          sessionId: null,
          streaming: "",
          lastPrompt: c.prompt,
          lastRefs: [],
          refAssets: [],
          lastRatio: null,
          provider: c.provider,
          projectId: null,
          createdAt: Date.now(),
          running: true,
        };
        return {
          genJobs: { ...s.genJobs, [rid]: job },
          genJobOrder: [...s.genJobOrder, rid],
          activeJobId: s.activeJobId ?? rid,
          activeSessionKind: "generation" as const,
          generating: true,
          genPanelOpen: true, // 恢复中弹面板（用户看得见恢复进度）
        };
      });
      return;
    }
    if (c.kind === "recover_polling") {
      // 远端仍在排队（querying）：保持 running，streaming 显示提示（下次启动再试）。
      const rid = c.job_id;
      if (rid)
        updateJob(rid, (j) => ({
          ...j,
          streaming: c.message ? `远端仍在排队：${c.message}` : "远端仍在排队…",
          remoteStatus: "querying",
        }));
      return;
    }
    const id = c.job_id;
    if (!id) return; // 无 job_id 的事件忽略（理论不发生）
    if (c.kind === "delta") {
      updateJob(id, (j) => ({ ...j, streaming: j.streaming + c.text }));
    } else if (c.kind === "done") {
      const imgs = c.images ?? [];
      const panelOpen = get().genPanelOpen;
      updateJob(
        id,
        (j) => {
          const last = j.turns[j.turns.length - 1];
          const turns = last
            ? [
                ...j.turns.slice(0, -1),
                {
                  ...last,
                  images: [...last.images, ...imgs],
                  provider: c.provider,
                  // 生成用时：done 落地时按本轮 startedAt 结算（恢复的 job 无 startedAt → 不显示）。
                  durationMs: last.startedAt ? Date.now() - last.startedAt : last.durationMs,
                },
              ]
            : j.turns;
          return {
            ...j,
            turns,
            running: false,
            streaming: "", // done 后清流式（图已到；provider 在 turn 角标、耗时勿扰）
            sessionId: c.session_id ?? j.sessionId,
          };
        },
        { genUnread: imgs.length > 0 && !panelOpen ? true : get().genUnread },
      );
    } else if (c.kind === "error") {
      genHandleError(id, c.message);
      updateJob(id, (j) => ({ ...j, running: false }));
    }
  },
  viewGenerationHistory: async (assetId) => {
    // 回看历史：生成会话已结束（DB 有 generation_meta），新建一个 running=false 的 job 并选中，
    // 复用 GenerationPanel 展示时间线 + 续轮 resume（sessionId=历史 sid）。
    try {
      const hist = await api.generationHistory(assetId, get().currentProjectId);
      // 同 sessionId 已有 job 则切过去（避免回看累积重复历史 job）；session_id 为空不去重。
      const existing = hist.session_id
        ? Object.values(get().genJobs).find((j) => j.sessionId === hist.session_id)
        : undefined;
      if (existing) {
        set({ activeJobId: existing.id, activeSessionKind: "generation", genPanelOpen: true, genUnread: false });
        return;
      }
      const jobId = crypto.randomUUID();
      const job: GenJob = {
        id: jobId,
        turns: hist.turns.map((t) => ({
          id: nextGenTurnId(),
          prompt: t.prompt,
          appliedPrompt: t.applied_prompt ?? null,
          promptRaw: t.prompt_raw ?? null,
          images: t.images,
          refs: t.references ?? undefined,
          refAssets: t.ref_assets,
        })),
        sessionId: hist.session_id,
        streaming: "",
        lastPrompt: hist.turns[0]?.prompt ?? "",
        lastRefs: hist.references.map((r) => r.store_path).filter((p): p is string => !!p),
        refAssets: hist.references,
        dimAssets: hist.dimension_assets ?? [],
        lastRatio: null,
        // 首版 meta 的 provider（即梦/cloud key）：续轮坞 provider 初值据此还原，即梦会话
        // 不再默认落到 codex（codex resume 拿即梦 submit_id 会直接报错）。遗留 "dreamina"
        // key 归一为 jimeng；旧 meta 无 provider 维持空串（面板按 codex 展示，可手选）。
        provider: hist.provider === "dreamina" ? "jimeng" : hist.provider ?? "",
        projectId: get().currentProjectId,
        visualProfile: hist.visual_profile ?? null,
        visualProfileId: hist.visual_profile?.profileId ?? null,
        createdAt: Date.now(),
        running: false,
      };
      set((s) => ({
        genJobs: { ...s.genJobs, [jobId]: job },
        genJobOrder: [...s.genJobOrder, jobId],
        activeJobId: jobId,
        activeSessionKind: "generation",
        genPanelOpen: true, // 弹生成面板（盖住详情页，关面板回详情页）
        genUnread: false,
      }));
    } catch (e) {
      console.error("viewGenerationHistory failed", e);
    }
  },
  reusePromptToBoard: (prompt, refs, dimRefs) => {
    const body = prompt.trim();
    if (!body) return;
    set({
      // 常驻化后 boardOpen 恒 true；编辑坞开着则退出坞让创作板接管（否则 load 事件
      // 会被坞内编辑器抢先消费，且两编辑器同挂载双份插入）。
      genEditing: null,
      detailAssetId: null,
      genPanelOpen: false, // 聚焦创作板编辑
      // 载入的 prompt 已含完整内容（含原 preset body），清选中避免发送时 startGeneration 重复拼 body
      activePresetId: null,
    });
    // 参考图：显式传入优先（右键菜单按 generation_history 复用）；
    // 否则取 activeJob（复用入口在 GenerationPanel 基于选中 job）。
    const id = get().activeJobId;
    const activeJob = id ? get().genJobs[id] : undefined;
    const refAssets = refs ?? activeJob?.refAssets ?? [];
    // 借用维度源图（复用 sidecar，回绑车牌取最新反推）：显式传入优先，否则取 activeJob。
    const dimAssets = dimRefs ?? activeJob?.dimAssets ?? [];
    // 延一帧 dispatch：从编辑坞退出的场景 CreationBoard 需先挂载注册 listener，同步派发会丢失。
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("bowerbird://board-load-prompt", {
          detail: { prompt: body, refs: refAssets, dimRefs: dimAssets },
        }),
      );
    }, 0);
  },
  insertAnnotatedToBoard: (asset) => {
    // 生成面板编辑坞打开 → 原地插入不动面板（编辑坞的 useCreationEditor 也监听 injected）；
    // 否则收起详情页让瀑布流+对话框可见（对话框与详情页互斥，见 App 挂载条件）。
    if (!get().genPanelOpen) {
      set({ detailAssetId: null });
    }
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("bowerbird://board-asset-injected", { detail: asset }),
      );
    }, 0);
  },
  addAssetToBoardFromDetail: (assetId) => {
    // 关详情回主界面：瀑布流 + 对话框（互斥）随 detailAssetId 清空而挂载。
    set({ detailAssetId: null });
    // 滚动定位到该图 + 蓝框闪烁（MasonryGrid 既有 focusAsset 消费）。
    get().focusAsset(assetId);
    // 延一帧插 chip：对话框刚挂载，需等其 useCreationEditor 注册 pick listener；
    // 插入后编辑器聚焦 → onFocus 激活创作模式（同点编辑框）。
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("bowerbird://board-asset-picked", { detail: assetId }),
      );
    }, 0);
    // 有维度数据（反推 sections）则呼出维度环；环锚点回退链：瀑布流卡片 → 编辑框 chip。
    const hasSections = get().promptedAssets.some(
      (a) => a.id === assetId && a.sections && a.sections.length > 0,
    );
    if (hasSections) get().openCaptionRing(assetId);
  },
  // —— 图片标注面板 ——
  annotator: null,
  openAnnotator: (assetId) => set({ annotator: { assetId } }),
  closeAnnotator: () => set({ annotator: null }),
  // —— 右键菜单 ——
  contextMenu: null,
  openContextMenu: (x, y, assetId) => set({ contextMenu: { x, y, assetId } }),
  closeContextMenu: () => set({ contextMenu: null }),
  // —— 项目右键菜单 ——
  projectContextMenu: null,
  openProjectContextMenu: (x, y, projectId) => set({ projectContextMenu: { x, y, projectId } }),
  closeProjectContextMenu: () => set({ projectContextMenu: null }),
  visualProfileFolder: null,
  openVisualProfile: (visualProfileFolder) => set({ visualProfileFolder }),
  closeVisualProfile: () => set({ visualProfileFolder: null }),
  };
});
