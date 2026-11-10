import { create } from "zustand";
import type { CatalogKind } from "./materialCatalog";

export type LibrarySource = "global" | "project";
export type LibraryMedia = "all" | "images" | "videos" | "audios" | "texts";
export const LIBRARY_VIEW_ORDER = ["collections", "project", "tags", "global"] as const;
export type LibraryView = typeof LIBRARY_VIEW_ORDER[number];
// "global" here is the file browser's aggregate directory, not a source tab.
type FileMode = CatalogKind | "files" | "global";
const projectMemoryKey = (context: string | null) => `bowerbird.libraryProject.${context ?? "home"}`;
function rememberedProject(context: string | null) {
  try { return localStorage.getItem(projectMemoryKey(context)) || context; } catch { return context; }
}
export const createLocalFileMode = () => create<{
  open: boolean; query: string;
  source: LibrarySource;
  view: LibraryView;
  tagSource: LibrarySource;
  contextProjectId: string | null;
  browseProjectId: string | null;
  projectPickerOpen: boolean;
  scopeMenuOpen: boolean;
  setProjectContext: (id: string | null) => void;
  selectProject: (id: string) => void;
  setProjectPickerOpen: (open: boolean) => void;
  setScopeMenuOpen: (open: boolean) => void;
  setView: (view: LibraryView) => void;
  setTagSource: (source: LibrarySource) => void;
  media: LibraryMedia;
  generatedFilter: "source:generated" | "source:!generated" | null;
  setGeneratedFilter: (filter: "source:generated" | "source:!generated" | null) => void;
  setMedia: (media: LibraryMedia) => void;
  globalRequest: number;
  mode: FileMode;
  setMode: (mode: FileMode) => void;
  openSource: (source: LibrarySource) => void;
  setCatalogView: (view: CatalogKind) => void;
  toggleCatalog: () => void;
  closeBrowser: () => void;
  openGlobal: () => void;
  openBrowser: () => void;
  navigationHost: HTMLDivElement | null;
  setNavigationHost: (host: HTMLDivElement | null) => void;
  setOpen: (value: boolean | ((value: boolean) => boolean)) => void;
  setQuery: (query: string) => void;
}>((set, get) => ({
  open: false, query: "", source: "global", view: "global", tagSource: "global",
  contextProjectId: null, browseProjectId: rememberedProject(null), projectPickerOpen: false, scopeMenuOpen: false,
  setProjectContext: contextProjectId => set(state => state.contextProjectId === contextProjectId ? state : {
    contextProjectId, browseProjectId: rememberedProject(contextProjectId), projectPickerOpen: false, scopeMenuOpen: false,
  }),
  selectProject: browseProjectId => {
    try { localStorage.setItem(projectMemoryKey(get().contextProjectId), browseProjectId); } catch { /* Keep browsing without storage. */ }
    set({ browseProjectId, projectPickerOpen: false, query: "" });
  },
  setProjectPickerOpen: projectPickerOpen => set({ projectPickerOpen }),
  setScopeMenuOpen: scopeMenuOpen => set({ scopeMenuOpen }),
  media: "images",
  generatedFilter: null,
  setGeneratedFilter: generatedFilter => set({ generatedFilter }),
  navigationHost: null, globalRequest: 0, mode: "all",
  setMode: mode => set({ mode }),
  setView: view => set(state => {
    const mode = view === "global" || view === "project" ? "all" : view;
    if (state.view === view) return { open: true, mode };
    const source = view === "tags" ? state.tagSource : view === "project" ? "project" : "global";
    return { open: true, view, source, mode, query: "", projectPickerOpen: false, scopeMenuOpen: view === "tags" || view === "project",
      tagSource: view === "global" || view === "project" ? source : state.tagSource };
  }),
  setTagSource: source => set(state => ({ tagSource: source, projectPickerOpen: false, ...(state.view === "tags" ? { source, query: "" } : {}) })),
  openSource: source => get().setView(source),
  setMedia: media => set(state => ({ media, generatedFilter: media === "audios" || media === "texts" ? null : state.generatedFilter })),
  setCatalogView: view => get().setView(view === "all" ? get().source : view),
  toggleCatalog: () => {
    const state = get();
    state.setView(LIBRARY_VIEW_ORDER[(LIBRARY_VIEW_ORDER.indexOf(state.view) + 1) % LIBRARY_VIEW_ORDER.length]);
  },
  closeBrowser: () => set(state => ({ mode: state.view === "global" || state.view === "project" ? "all" : state.view, query: "" })),
  openGlobal: () => get().openSource("global"),
  openBrowser: () => { get().setCatalogView("collections"); set({ open: true }); },
  setNavigationHost: navigationHost => set({ navigationHost }),
  setOpen: value => set(state => ({ open: typeof value === "function" ? value(state.open) : value })),
  setQuery: query => set({ query }),
}));

export const useLocalFileMode = createLocalFileMode();
