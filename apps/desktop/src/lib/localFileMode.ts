import { create } from "zustand";
import type { CatalogKind } from "./materialCatalog";

export type LibrarySource = "global" | "project";
export type LibraryMedia = "images" | "videos";
export const catalogViewName = (kind: CatalogKind, media: LibraryMedia) => kind === "collections" ? "集合分类" : media === "videos" ? "视频平铺" : "标签分类";
// "global" here is the file browser's aggregate directory, not a source tab.
type FileMode = CatalogKind | "files" | "global";
export const useLocalFileMode = create<{
  open: boolean; query: string;
  source: LibrarySource;
  views: Record<LibrarySource, CatalogKind>;
  media: LibraryMedia;
  generatedFilter: "source:generated" | "source:!generated" | null;
  setGeneratedFilter: (filter: "source:generated" | "source:!generated" | null) => void;
  videoViews: Record<LibrarySource, CatalogKind>;
  setMedia: (media: LibraryMedia) => void;
  globalRequest: number;
  mode: FileMode;
  viewTransition: { source: LibrarySource; kind: CatalogKind; startedAt: number } | null;
  setMode: (mode: FileMode) => void;
  openSource: (source: LibrarySource) => void;
  toggleCatalog: () => void;
  closeBrowser: () => void;
  openGlobal: () => void;
  openBrowser: () => void;
  navigationHost: HTMLDivElement | null;
  setNavigationHost: (host: HTMLDivElement | null) => void;
  setOpen: (value: boolean | ((value: boolean) => boolean)) => void;
  setQuery: (query: string) => void;
}>((set, get) => ({
  open: false, query: "", source: "global", views: { global: "tags", project: "tags" },
  media: "images", videoViews: { global: "tags", project: "tags" },
  generatedFilter: null,
  setGeneratedFilter: generatedFilter => set({ generatedFilter }),
  navigationHost: null, globalRequest: 0, mode: "tags", viewTransition: null,
  setMode: mode => set({ mode }),
  openSource: source => set(state => ({ open: true, source, mode: (state.media === "images" ? state.views : state.videoViews)[source], query: "", viewTransition: null })),
  setMedia: media => set(state => ({ media, mode: (media === "images" ? state.views : state.videoViews)[state.source], viewTransition: null })),
  toggleCatalog: () => set(state => {
    // The ungrouped video view uses the same all-assets query as image tags.
    const key = state.media === "images" ? "views" : "videoViews";
    const view = state[key][state.source] === "tags" ? "collections" : "tags";
    return { open: true, mode: view, [key]: { ...state[key], [state.source]: view },
      viewTransition: { source: state.source, kind: view, startedAt: Date.now() } };
  }),
  closeBrowser: () => set(state => ({ mode: (state.media === "images" ? state.views : state.videoViews)[state.source], query: "" })),
  openGlobal: () => get().openSource("global"),
  openBrowser: () => set(state => ({ open: true, mode: "files", query: "", globalRequest: state.globalRequest + 1, viewTransition: null })),
  setNavigationHost: navigationHost => set({ navigationHost }),
  setOpen: value => set(state => ({ open: typeof value === "function" ? value(state.open) : value, viewTransition: null })),
  setQuery: query => set({ query }),
}));
