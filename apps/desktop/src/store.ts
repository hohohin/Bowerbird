import { create } from "zustand";
import { api } from "./lib/api";
import type { Asset, Folder } from "./lib/types";

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
  setAssets: (a: Asset[]) => void;
  setTotal: (n: number) => void;
  toggleSelect: (id: string) => void;
  clearSelect: () => void;
  setLoading: (b: boolean) => void;
  setCurrentFolder: (id: string | null) => void;
  setColorFilter: (c: string | null) => void;
  setSearchQuery: (q: string) => void;
  enterManage: () => void; // 进入批量管理模式
  exitManage: () => void; // 退出并清空选中
  openDetail: (id: string) => void;
  closeDetail: () => void;
  setFolders: (f: Folder[]) => void;
  reloadFolders: () => Promise<void>;
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
}));
