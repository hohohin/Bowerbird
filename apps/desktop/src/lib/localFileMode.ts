import { create } from "zustand";

export const useLocalFileMode = create<{
  open: boolean; query: string;
  globalRequest: number;
  mode: "global" | "files";
  setMode: (mode: "global" | "files") => void;
  openGlobal: () => void;
  openBrowser: () => void;
  navigationHost: HTMLDivElement | null;
  setNavigationHost: (host: HTMLDivElement | null) => void;
  setOpen: (value: boolean | ((value: boolean) => boolean)) => void;
  setQuery: (query: string) => void;
}>((set) => ({
  open: false, query: "", navigationHost: null, globalRequest: 0, mode: "global",
  setMode: mode => set({ mode }),
  openGlobal: () => set(state => ({ open: true, mode: "global", query: "", globalRequest: state.globalRequest + 1 })),
  openBrowser: () => set(state => ({ open: true, mode: "files", query: "", globalRequest: state.globalRequest + 1 })),
  setNavigationHost: navigationHost => set({ navigationHost }),
  setOpen: value => set(state => ({ open: typeof value === "function" ? value(state.open) : value })),
  setQuery: query => set({ query }),
}));
