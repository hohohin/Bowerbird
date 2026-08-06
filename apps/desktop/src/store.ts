import { create } from "zustand";
import { api } from "./lib/api";
import type {
  AppSettings,
  Asset,
  CodexChunk,
  CodexHealth,
  ColorBucket,
  Folder,
  GenJob,
  Preset,
  Project,
  PromptedAsset,
  TagCount,
} from "./lib/types";

// —— 默认出图 provider（localStorage，照 boardRatio 枚举校验）——
const DEFAULT_PROVIDER_KEY = "bowerbird.defaultProvider";
const PROVIDERS = ["codex", "jimeng"] as const;
function loadDefaultProvider(): string {
  try {
    const v = localStorage.getItem(DEFAULT_PROVIDER_KEY);
    return v && (PROVIDERS as readonly string[]).includes(v) ? v : "codex";
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

type Mode = "browse" | "manage";

interface State {
  assets: Asset[];
  total: number;
  selectedIds: Set<string>;
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
  // —— 自动归类（P2）——
  autoTags: TagCount[]; // 侧栏「自动归类」分区（source='auto' tag + 计数）
  classifyProgress: { done: number; total: number } | null; // 批量重归类进度
  colorRebuild: { done: number; total: number } | null; // 重建色板进度（P3）
  // —— 创作板（核心枢纽）——
  boardOpen: boolean;
  promptedAssets: PromptedAsset[]; // 创作板挑图集合中带 caption（反推）的子集，供编辑器补 sections / 展开维度片段
  // —— 创作板「用途」（preset）——
  presets: Preset[]; // 命名 prompt 预设，发送时作为基底注入（不进编辑器）
  activePresetId: string | null; // 当前选中用途；null=不注入
  setAssets: (a: Asset[]) => void;
  setTotal: (n: number) => void;
  toggleSelect: (id: string) => void;
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
  toggleBoard: () => void;
  setPromptedAssets: (a: PromptedAsset[]) => void;
  setActivePreset: (id: string | null) => void;
  // —— 反推（全局后台串行）——
  // 反推不绑 AssetDetail 生命周期：返回瀑布流后继续跑、缩略图角标可见、可取消。
  // 单槽 + 前端排队：同一时刻只调一次 codex_describe_asset（后端 DESCRIBE_CANCEL 单例）。
  describingId: string | null;
  describeQueue: { assetId: string; instruction: string }[];
  describeStartedAt: number | null; // 当前任务开始时间戳；跨组件已耗时显示用
  runDescribe: (assetId: string, instruction: string) => void;
  cancelDescribe: (assetId: string) => Promise<void>;
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
  // 统一「环境状态」总览；子引导只由总览卡片跳转唤起。
  onboardingForceOpen: boolean;
  setOnboardingForceOpen: (v: boolean) => void;
  codexOnboardingForceOpen: boolean;
  setCodexOnboardingForceOpen: (v: boolean) => void;
  extensionOnboardingForceOpen: boolean;
  setExtensionOnboardingForceOpen: (v: boolean) => void;
  // —— 应用设置（从后端 settings.json 加载）——
  settings: AppSettings | null;
  loadSettings: () => Promise<void>;
  updateSettings: (s: AppSettings) => Promise<void>;
  // —— 即梦（dreamina）可用性 + 出图 provider 切换（Phase 3）——
  dreaminaHealth: CodexHealth | null;
  setDreaminaHealth: (h: CodexHealth | null) => void;
  defaultProvider: string; // 全局默认出图 provider（"codex"/"jimeng"，localStorage 持久化）
  setDefaultProvider: (p: string) => void;
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
  genJobs: Record<string, GenJob>; // 所有生成会话（首轮创建，续轮追加 turn）
  genJobOrder: string[]; // job 创建顺序（标签栏稳定排序）
  activeJobId: string | null; // 当前查看/操作的 job（续轮/复用/取消/重试基于它）
  genUnread: boolean; // 面板关时落地新图 → 顶栏按钮红点
  setActiveJob: (id: string) => void;
  toggleGenPanel: () => void;
  setGenPanelOpen: (open: boolean) => void;
  startGeneration: (prompt: string, references: Asset[], ratio?: string | null, provider?: string | null) => Promise<void>;
  sendGenRevise: (instruction: string, provider?: string | null) => Promise<void>;
  cancelGeneration: (jobId?: string) => void; // 默认取消 activeJob
  loadGenJobs: () => Promise<void>;
  applyGenChunk: (c: CodexChunk) => void;
  // 重试 activeJob 末尾失败轮：首轮失败 → startGeneration（新建 job 重发），续轮失败 → sendGenRevise（resume 续接）。
  retryLastGenTurn: () => void;
  // 「回看生成对话」：拉某生成图所在会话的历史时间线 → 新建 running=false 的 job 并选中，
  // 复用 GenerationPanel 展示 + 续轮 resume（sessionId=历史 sid）。
  viewGenerationHistory: (assetId: string) => Promise<void>;
  // 「复用到创作板」：把 activeJob 首轮 prompt + 参考图载入创作板编辑器。
  // 开创作板 + 关详情/生成面板/挑图态，延时一帧再 dispatch board-load-prompt，
  // 确保 CreationBoard 已挂载注册 listener（同步 dispatch 会丢）。
  reusePromptToBoard: (prompt: string) => void;
  // —— 右键菜单（瀑布流缩略图 / 详情页大图）——
  contextMenu: { x: number; y: number; assetId: string } | null;
  openContextMenu: (x: number, y: number, assetId: string) => void;
  closeContextMenu: () => void;
}

export const useStore = create<State>((set, get) => {
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
      describeStartedAt: Date.now(),
    });
    try {
      await api.describeAsset(next.assetId, next.instruction);
    } catch (e) {
      const msg = typeof e === "string" ? e : JSON.stringify(e);
      // 「已取消」是用户主动中断，静默；其它错误记录（后续可扩展为 per-asset 提示）。
      if (!msg.includes("已取消")) console.error("describe failed", e);
    } finally {
      // 仅当仍是本次任务时清空（cancel 路径已让后端返回「已取消」走 catch）。
      if (get().describingId === next.assetId) {
        set({ describingId: null, describeStartedAt: null });
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
        return { ...j, turns: [...j.turns.slice(0, -1), { ...last, error: msg }] };
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
  boardOpen: false,
  promptedAssets: [],
  presets: [],
  activePresetId: null,
  setAssets: (assets) => set({ assets }),
  setTotal: (total) => set({ total }),
  toggleSelect: (id) =>
    set((s) => {
      const next = new Set(s.selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selectedIds: next };
    }),
  clearSelect: () => set({ selectedIds: new Set() }),
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
  exitManage: () => set({ mode: "browse", selectedIds: new Set() }),
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
          boardOpen: false,
          activePresetId: null,
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
      boardOpen: false,
      activePresetId: null,
    });
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
      boardOpen: false,
      activePresetId: null,
    });
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
  toggleBoard: () =>
    set((s) => {
      const turningOn = !s.boardOpen;
      return {
        boardOpen: turningOn,
        // 打开创作板时收起详情页，让瀑布流（全部图，任意图可插为参考图）可见以便挑图
        detailAssetId: turningOn ? null : s.detailAssetId,
      };
    }),
  setPromptedAssets: (promptedAssets) => set({ promptedAssets }),
  setActivePreset: (id) => set({ activePresetId: id }),
  // —— 反推（全局后台串行）——
  describingId: null,
  describeQueue: [],
  describeStartedAt: null,
  runDescribe: (assetId, instruction) => {
    const trimmed = instruction.trim();
    if (!trimmed) return;
    const s = get();
    // 同一张图不重复入队（正在跑或已排队）。
    if (
      s.describingId === assetId ||
      s.describeQueue.some((q) => q.assetId === assetId)
    ) {
      return;
    }
    set({
      describeQueue: [...s.describeQueue, { assetId, instruction: trimmed }],
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
  onboardingForceOpen: false,
  setOnboardingForceOpen: (onboardingForceOpen) => set({ onboardingForceOpen }),
  codexOnboardingForceOpen: false,
  setCodexOnboardingForceOpen: (codexOnboardingForceOpen) =>
    set({ codexOnboardingForceOpen }),
  extensionOnboardingForceOpen: false,
  setExtensionOnboardingForceOpen: (extensionOnboardingForceOpen) =>
    set({ extensionOnboardingForceOpen }),
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
  // —— 即梦 + provider（Phase 3）——
  dreaminaHealth: null,
  setDreaminaHealth: (dreaminaHealth) => set({ dreaminaHealth }),
  defaultProvider: loadDefaultProvider(),
  setDefaultProvider: (defaultProvider) => {
    saveDefaultProvider(defaultProvider);
    // 改默认同步切当前选择（用户期望「默认」生效立即）。
    set({ defaultProvider, activeGenProvider: defaultProvider });
  },
  activeGenProvider: loadDefaultProvider(),
  setActiveGenProvider: (activeGenProvider) => set({ activeGenProvider }),
  dreaminaLoginLines: [],
  dreaminaLoginActive: false,
  setDreaminaLoginActive: (dreaminaLoginActive) => set({ dreaminaLoginActive }),
  pushDreaminaLoginLine: (line) =>
    set((s) => ({ dreaminaLoginLines: [...s.dreaminaLoginLines, line] })),
  clearDreaminaLogin: () => set({ dreaminaLoginLines: [], dreaminaLoginActive: false }),
  // —— 浏览器扩展采集 ——
  collectedNotice: null,
  setCollectedNotice: (collectedNotice) => set({ collectedNotice }),
  // —— 生成结果面板（多 job）——
  genPanelOpen: false,
  genJobs: {},
  genJobOrder: [],
  activeJobId: null,
  genUnread: false,
  toggleGenPanel: () =>
    set((s) => {
      const opening = !s.genPanelOpen;
      return { genPanelOpen: opening, genUnread: opening ? false : s.genUnread };
    }),
  setGenPanelOpen: (open) =>
    set((s) => ({ genPanelOpen: open, genUnread: open ? false : s.genUnread })),
  setActiveJob: (id) => set({ activeJobId: id }),
  loadGenJobs: async () => {
    // 启动恢复：拉本地未完成生成 job 重建 genJobs（恢复中 job 在面板可见）。
    try {
      const jobs = await api.listGenJobs();
      set((s) => {
        const genJobs = { ...s.genJobs };
        const genJobOrder = [...s.genJobOrder];
        for (const j of jobs) {
          if (genJobs[j.id]) continue; // 已存在（用户本轮新发）不覆盖
          genJobs[j.id] = {
            id: j.id,
            turns: [{ id: nextGenTurnId(), prompt: j.prompt, images: [], provider: j.provider }],
            sessionId: j.session_id ?? j.submit_id ?? null,
            streaming: "",
            lastPrompt: j.prompt,
            lastRefs: j.references ?? [],
            refAssets: [],
            lastRatio: j.ratio ?? null,
            provider: j.provider,
            projectId: j.project_id ?? null,
            createdAt: j.created_at,
            running: j.running,
            pendingBoardClose: false,
            submitId: j.submit_id ?? null,
            remoteStatus: j.running ? "querying" : null,
          };
          if (!genJobOrder.includes(j.id)) genJobOrder.push(j.id);
        }
        return {
          genJobs,
          genJobOrder,
          generating: Object.values(genJobs).some((x) => x.running),
        };
      });
    } catch (e) {
      console.error("loadGenJobs failed", e);
    }
  },
  startGeneration: async (prompt, references, ratio, provider) => {
    // 多 job：不再因 generating 阻塞（并发发起多个生成，各自独立流转）。
    // provider 兜底：调用点没传（CreationBoard send / retry）→ 当前选择 → 全局默认。
    const prov = provider ?? get().activeGenProvider ?? get().defaultProvider;
    // 用途（preset）注入：选中用途时，其 body 作为基底拼在用户组稿前（类 CLAUDE.md 上下文，
    // 不进编辑器）。续轮 sendGenRevise 不注入——用途是首轮基底，续轮是修改意见。
    const pid = get().activePresetId;
    const preset = pid ? get().presets.find((p) => p.id === pid) : null;
    const sentPrompt = preset ? `${preset.body}\n\n${prompt}` : prompt;
    const refPaths = references
      .map((r) => r.store_path)
      .filter((p): p is string => !!p);
    // 前端生成 jobId：创建 GenJob 即知 id，chunk 按 id 路由无 race；后端 task_queue upsert。
    const jobId = crypto.randomUUID();
    const job: GenJob = {
      id: jobId,
      turns: [{ id: nextGenTurnId(), prompt: sentPrompt, images: [], provider: prov }],
      sessionId: null,
      streaming: "",
      lastPrompt: sentPrompt,
      lastRefs: refPaths,
      refAssets: references,
      lastRatio: ratio ?? null,
      provider: prov,
      projectId: get().currentProjectId,
      createdAt: Date.now(),
      running: true,
      pendingBoardClose: true, // 首轮：done 有图则关创作板（草稿由编辑器卸载时落盘保留）
    };
    set((s) => ({
      genJobs: { ...s.genJobs, [jobId]: job },
      genJobOrder: [...s.genJobOrder, jobId],
      activeJobId: jobId, // 新发 job 自动选中（续轮/复用/取消聚焦它）
      genPanelOpen: true, // 自动弹面板给即时反馈（创作板在右槽仍可编辑）
      genUnread: false,
      generating: true, // 新 job running → 至少此 job 在跑
    }));
    try {
      await api.codexCreateImage({
        jobId,
        prompt: sentPrompt,
        referenceImages: refPaths,
        ratio,
        provider: prov,
        projectId: job.projectId,
      });
    } catch (e) {
      genHandleError(jobId, typeof e === "string" ? e : JSON.stringify(e));
      updateJob(jobId, (j) => ({ ...j, running: false }));
    }
  },
  sendGenRevise: async (instruction, provider) => {
    const id = get().activeJobId;
    if (!id) return;
    const job = get().genJobs[id];
    const text = instruction.trim();
    if (!job || !job.sessionId || !text) return;
    const prov = provider ?? job.provider ?? get().activeGenProvider ?? get().defaultProvider;
    // 即梦续轮：image2image 传上一轮产出图（codex resume 记得上一轮图、不需传）。
    const lastImages = job.turns[job.turns.length - 1]?.images ?? [];
    const reviseRefs = prov === "jimeng" ? lastImages : [];
    // 续轮复用同 jobId（同一会话）；后端 task_queue upsert 刷新回 running。
    updateJob(id, (j) => ({
      ...j,
      turns: [...j.turns, { id: nextGenTurnId(), prompt: text, images: [], provider: prov }],
      streaming: "",
      running: true,
      pendingBoardClose: false, // 续轮修改不关闭创作板
    }));
    try {
      await api.codexCreateImage({
        jobId: id,
        prompt: text,
        referenceImages: reviseRefs,
        sessionId: job.sessionId,
        provider: prov,
        projectId: job.projectId,
      });
    } catch (e) {
      genHandleError(id, typeof e === "string" ? e : JSON.stringify(e));
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
    if (!job || !s.codexHealth?.ok) return;
    const last = job.turns[job.turns.length - 1];
    if (!last?.error) return; // 没有失败轮可重试
    if (job.sessionId) {
      // 续轮失败：先移除失败轮再 resume，重试轮顶替原位（避免同 prompt 编号递增的重复轮）。
      updateJob(id, (j) => ({ ...j, turns: j.turns.slice(0, -1) }));
      void s.sendGenRevise(last.prompt);
    } else {
      // 首轮失败：startGeneration 新建 job 重发（旧失败 job 保留可切回查看）。
      void s.startGeneration(job.lastPrompt, job.refAssets, job.lastRatio);
    }
  },
  applyGenChunk: (c) => {
    if (c.kind === "started") return; // 前端已自生成 jobId 创建 job；started 无需处理
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
          pendingBoardClose: false,
        };
        return {
          genJobs: { ...s.genJobs, [rid]: job },
          genJobOrder: [...s.genJobOrder, rid],
          activeJobId: s.activeJobId ?? rid,
          generating: true,
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
            ? [...j.turns.slice(0, -1), { ...last, images: [...last.images, ...imgs], provider: c.provider }]
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
      // 创作板首发（per-job 标记）且本轮有图 = 生成成功 → 关闭创作板（草稿由编辑器卸载时落盘）。
      const job = get().genJobs[id];
      if (imgs.length > 0 && job?.pendingBoardClose) {
        updateJob(id, (j) => ({ ...j, pendingBoardClose: false }));
        set({ boardOpen: false });
      }
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
        set({ activeJobId: existing.id, genPanelOpen: true, genUnread: false });
        return;
      }
      const jobId = crypto.randomUUID();
      const job: GenJob = {
        id: jobId,
        turns: hist.turns.map((t) => ({ id: nextGenTurnId(), prompt: t.prompt, images: t.images })),
        sessionId: hist.session_id,
        streaming: "",
        lastPrompt: hist.turns[0]?.prompt ?? "",
        lastRefs: hist.references.map((r) => r.store_path).filter((p): p is string => !!p),
        refAssets: hist.references,
        lastRatio: null,
        provider: "",
        projectId: get().currentProjectId,
        createdAt: Date.now(),
        running: false,
        pendingBoardClose: false,
      };
      set((s) => ({
        genJobs: { ...s.genJobs, [jobId]: job },
        genJobOrder: [...s.genJobOrder, jobId],
        activeJobId: jobId,
        genPanelOpen: true, // 弹生成面板（盖住详情页，关面板回详情页）
        genUnread: false,
      }));
    } catch (e) {
      console.error("viewGenerationHistory failed", e);
    }
  },
  reusePromptToBoard: (prompt) => {
    const body = prompt.trim();
    if (!body) return;
    set({
      boardOpen: true,
      detailAssetId: null,
      genPanelOpen: false, // 聚焦创作板编辑
      // 载入的 prompt 已含完整内容（含原 preset body），清选中避免发送时 startGeneration 重复拼 body
      activePresetId: null,
    });
    // 参考图取自 activeJob（复用入口在 GenerationPanel 基于选中 job）。
    const id = get().activeJobId;
    const refs = id ? get().genJobs[id]?.refAssets ?? [] : [];
    // 延一帧：set(boardOpen) 后 CreationBoard 才挂载注册 listener，同步 dispatch 会丢失。
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("bowerbird://board-load-prompt", {
          detail: { prompt: body, refs },
        }),
      );
    }, 0);
  },
  // —— 右键菜单 ——
  contextMenu: null,
  openContextMenu: (x, y, assetId) => set({ contextMenu: { x, y, assetId } }),
  closeContextMenu: () => set({ contextMenu: null }),
  };
});