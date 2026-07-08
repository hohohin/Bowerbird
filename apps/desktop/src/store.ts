import { create } from "zustand";
import { api } from "./lib/api";
import type { Asset, Folder, PromptedAsset } from "./lib/types";

type Mode = "browse" | "manage";

interface State {
  assets: Asset[];
  total: number;
  selectedIds: Set<string>;
  loading: boolean;
  currentFolderId: string | null;
  colorFilter: string | null; // hex；前端过滤
  searchQuery: string; // FTS5 搜索；空串 = 不搜
  smartFilter: string | null; // 智能查询（如 source:codex），与文件夹/搜索互斥；侧栏「✨ 生成图」用
  mode: Mode;
  detailAssetId: string | null; // 浏览模式打开的详情页资产
  folders: Folder[];
  // —— 创作板（核心枢纽）——
  boardOpen: boolean;
  boardPickMode: boolean; // 输入 @ 后等待瀑布流点选图片
  promptedAssets: PromptedAsset[]; // 创作板打开时，瀑布流只显示这些（有 caption 的资产）
  setAssets: (a: Asset[]) => void;
  setTotal: (n: number) => void;
  toggleSelect: (id: string) => void;
  clearSelect: () => void;
  setLoading: (b: boolean) => void;
  setCurrentFolder: (id: string | null) => void;
  setColorFilter: (c: string | null) => void;
  setSearchQuery: (q: string) => void;
  setSmartFilter: (q: string | null) => void;
  enterManage: () => void;
  exitManage: () => void;
  openDetail: (id: string) => void;
  closeDetail: () => void;
  setFolders: (f: Folder[]) => void;
  reloadFolders: () => Promise<void>;
  toggleBoard: () => void;
  startBoardImagePick: () => void;
  finishBoardImagePick: () => void;
  cancelBoardImagePick: () => void;
  setPromptedAssets: (a: PromptedAsset[]) => void;
  // —— 反推（全局后台串行）——
  // 反推不绑 AssetDetail 生命周期：返回瀑布流后继续跑、缩略图角标可见、可取消。
  // 单槽 + 前端排队：同一时刻只调一次 codex_describe_asset（后端 DESCRIBE_CANCEL 单例）。
  describingId: string | null;
  describeQueue: { assetId: string; instruction: string }[];
  describeStartedAt: number | null; // 当前任务开始时间戳；跨组件已耗时显示用
  runDescribe: (assetId: string, instruction: string) => void;
  cancelDescribe: (assetId: string) => Promise<void>;
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

  return {
  assets: [],
  total: 0,
  selectedIds: new Set(),
  loading: false,
  currentFolderId: null,
  colorFilter: null,
  searchQuery: "",
  smartFilter: null,
  mode: "browse",
  detailAssetId: null,
  folders: [],
  boardOpen: false,
  boardPickMode: false,
  promptedAssets: [],
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
  // 切文件夹时清颜色筛选与详情（详情指向的图可能不在新文件夹里）。
  setCurrentFolder: (currentFolderId) =>
    set({ currentFolderId, colorFilter: null, detailAssetId: null, smartFilter: null }),
  setColorFilter: (colorFilter) => set({ colorFilter }),
  setSearchQuery: (searchQuery) =>
    set({ searchQuery, detailAssetId: null, smartFilter: null }),
  // 智能查询（如 source:codex）与文件夹/搜索互斥：设它就清 folder/colorFilter。
  setSmartFilter: (smartFilter) =>
    set({ smartFilter, currentFolderId: null, colorFilter: null, detailAssetId: null }),
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
  // —— 创作板 ——
  toggleBoard: () =>
    set((s) => {
      const turningOn = !s.boardOpen;
      return {
        boardOpen: turningOn,
        boardPickMode: false,
        // 打开创作板时收起详情页，让瀑布流（仅反推过的图）可见以便 @ 挑图
        detailAssetId: turningOn ? null : s.detailAssetId,
      };
    }),
  startBoardImagePick: () => set({ boardOpen: true, boardPickMode: true, detailAssetId: null }),
  finishBoardImagePick: () => set({ boardPickMode: false }),
  cancelBoardImagePick: () => set({ boardPickMode: false }),
  setPromptedAssets: (promptedAssets) => set({ promptedAssets }),
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
  };
});
