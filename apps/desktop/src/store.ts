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
}

export const useStore = create<State>((set) => ({
  assets: [],
  total: 0,
  selectedIds: new Set(),
  loading: false,
  currentFolderId: null,
  colorFilter: null,
  searchQuery: "",
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
    set({ currentFolderId, colorFilter: null, detailAssetId: null }),
  setColorFilter: (colorFilter) => set({ colorFilter }),
  setSearchQuery: (searchQuery) => set({ searchQuery, detailAssetId: null }),
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
}));
