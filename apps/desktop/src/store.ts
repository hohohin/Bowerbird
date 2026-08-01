import { create } from "zustand";
import { api } from "./lib/api";
import type {
  AppSettings,
  Asset,
  CodexChunk,
  CodexHealth,
  ColorBucket,
  Folder,
  GenTurn,
  Preset,
  Project,
  PromptedAsset,
  TagCount,
} from "./lib/types";

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
  promptedAssets: PromptedAsset[]; // 创作板打开时，瀑布流只显示这些（有 caption 的资产）
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
  // —— 生成（创作板 codex 画图，单槽无队列）——
  // 状态全局可见：状态圈在顶部工具栏最右侧，故提到 store（不绑创作板生命周期）。
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
  // —— 生成结果面板（独立于创作板；主区覆盖层，可随时开合，状态在 store 不丢）——
  genPanelOpen: boolean;
  genTurns: GenTurn[];
  genSessionId: string | null;
  genStreaming: string;
  genLastPrompt: string; // 最近一次发送 prompt，供「新会话重新生成」复用
  genLastRefs: string[]; // 最近一次发送参考图（store_path）
  genRefAssets: Asset[]; // 最近一次发送参考图的完整 asset，「复用到创作板」还原参考图用
  genProjectId: string | null; // 生成会话所属项目快照；续轮不随当前项目切换漂移
  genUnread: boolean; // 面板关时落地新图 → 顶栏按钮红点
  toggleGenPanel: () => void;
  setGenPanelOpen: (open: boolean) => void;
  startGeneration: (prompt: string, references: Asset[]) => Promise<void>;
  sendGenRevise: (instruction: string) => Promise<void>;
  cancelGeneration: () => void;
  applyGenChunk: (c: CodexChunk) => void;
  // 「回看生成对话」：拉某生成图所在会话的历史时间线 → load 进 genTurns，复用 GenerationPanel
  // 展示 + 续轮 resume（genSessionId=历史 sid）。generating 中拒绝（不覆盖进行中的会话）。
  viewGenerationHistory: (assetId: string) => Promise<void>;
  // 「复用到创作板」：把某段 prompt（如生成会话首轮）载入创作板编辑器。
  // 开创作板 + 关详情/生成面板/挑图态，延时一帧再 dispatch board-load-prompt，
  // 确保 CreationBoard 已挂载注册 listener（同步 dispatch 会丢）。
  reusePromptToBoard: (prompt: string) => void;
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

  // —— 生成对话：turn id 计数 + 错误处理（内部，不暴露）——
  let genTurnSeq = 0;
  function nextGenTurnId() {
    genTurnSeq += 1;
    return genTurnSeq;
  }
  function genHandleError(msg: string) {
    const cancelled = msg.includes("已取消");
    set((s) => ({
      genStreaming: s.genStreaming + (cancelled ? "\n\n—— 已取消" : `\n[error: ${msg}]`),
      // 取消/出错时若最后一轮没产出图，移除占位 turn，避免空轮留在时间线
      genTurns:
        s.genTurns.length > 0 && s.genTurns[s.genTurns.length - 1].images.length === 0
          ? s.genTurns.slice(0, -1)
          : s.genTurns,
    }));
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
        // 打开创作板时收起详情页，让瀑布流（仅反推过的图）可见以便挑图
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
  // —— 生成结果面板 ——
  genPanelOpen: false,
  genTurns: [],
  genSessionId: null,
  genStreaming: "",
  genLastPrompt: "",
  genLastRefs: [],
  genRefAssets: [],
  genProjectId: null,
  genUnread: false,
  toggleGenPanel: () =>
    set((s) => {
      const opening = !s.genPanelOpen;
      return { genPanelOpen: opening, genUnread: opening ? false : s.genUnread };
    }),
  setGenPanelOpen: (open) =>
    set((s) => ({ genPanelOpen: open, genUnread: open ? false : s.genUnread })),
  startGeneration: async (prompt, references) => {
    if (get().generating) return; // 单槽：进行中不再发
    // 用途（preset）注入：选中用途时，其 body 作为基底拼在用户组稿前（类 CLAUDE.md 上下文，
    // 不进编辑器）。续轮 sendGenRevise 不注入——用途是首轮基底，续轮是修改意见。
    const pid = get().activePresetId;
    const preset = pid ? get().presets.find((p) => p.id === pid) : null;
    const sentPrompt = preset ? `${preset.body}\n\n${prompt}` : prompt;
    const refPaths = references
      .map((r) => r.store_path)
      .filter((p): p is string => !!p);
    set({
      genLastPrompt: sentPrompt,
      genLastRefs: refPaths,
      genRefAssets: references,
      genProjectId: get().currentProjectId,
      genSessionId: null,
      genStreaming: "",
      genTurns: [{ id: nextGenTurnId(), prompt: sentPrompt, images: [] }],
      genPanelOpen: true, // 自动弹面板给即时反馈（创作板在右槽仍可编辑）
      genUnread: false,
    });
    set({ generating: true });
    try {
      await api.codexCreateImage({
        prompt: sentPrompt,
        referenceImages: refPaths,
        projectId: get().genProjectId,
      });
    } catch (e) {
      genHandleError(typeof e === "string" ? e : JSON.stringify(e));
    } finally {
      set({ generating: false });
    }
  },
  sendGenRevise: async (instruction) => {
    const sid = get().genSessionId;
    const text = instruction.trim();
    if (get().generating || !sid || !text) return;
    set((s) => ({
      genTurns: [...s.genTurns, { id: nextGenTurnId(), prompt: text, images: [] }],
      genStreaming: "",
    }));
    set({ generating: true });
    try {
      await api.codexCreateImage({
        prompt: text,
        referenceImages: [],
        sessionId: sid,
        projectId: get().genProjectId,
      });
    } catch (e) {
      genHandleError(typeof e === "string" ? e : JSON.stringify(e));
    } finally {
      set({ generating: false });
    }
  },
  cancelGeneration: () => {
    void api.cancelCodexCreate().catch(console.error);
  },
  applyGenChunk: (c) => {
    if (c.kind === "delta") {
      set((s) => ({ genStreaming: s.genStreaming + c.text }));
    } else if (c.kind === "done") {
      const imgs = c.images ?? [];
      set((s) => {
        const base = {
          genSessionId: c.session_id ?? s.genSessionId,
          genStreaming: s.genStreaming + `\n\n—— done · ${c.elapsed_ms}ms via ${c.provider}`,
          genUnread: imgs.length > 0 && !s.genPanelOpen ? true : s.genUnread,
        };
        if (s.genTurns.length === 0) return base;
        const last = s.genTurns[s.genTurns.length - 1];
        return {
          ...base,
          genTurns: [...s.genTurns.slice(0, -1), { ...last, images: [...last.images, ...imgs] }],
        };
      });
    } else if (c.kind === "error") {
      set((s) => ({ genStreaming: s.genStreaming + `\n[error: ${c.message}]` }));
    }
  },
  viewGenerationHistory: async (assetId) => {
    if (get().generating) return; // 进行中不覆盖当前会话
    try {
      const hist = await api.generationHistory(assetId, get().currentProjectId);
      set({
        genTurns: hist.turns.map((t) => ({
          id: nextGenTurnId(),
          prompt: t.prompt,
          images: t.images,
        })),
        genSessionId: hist.session_id,
        genLastPrompt: hist.turns[0]?.prompt ?? "",
        genLastRefs: hist.references
          .map((r) => r.store_path)
          .filter((p): p is string => !!p),
        genRefAssets: hist.references,
        genProjectId: get().currentProjectId,
        genStreaming: "",
        genPanelOpen: true, // 弹生成面板（盖住详情页，关面板回详情页）
        genUnread: false,
      });
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
    const refs = get().genRefAssets;
    // 延一帧：set(boardOpen) 后 CreationBoard 才挂载注册 listener，同步 dispatch 会丢失。
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("bowerbird://board-load-prompt", {
          detail: { prompt: body, refs },
        })
      );
    }, 0);
  },
  };
});
