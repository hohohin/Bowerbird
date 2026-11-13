import { create } from "zustand";
import type { CatalogKind } from "./materialCatalog";

export type LibrarySource = "global" | "project";
const libraryMediaTypes = ["all", "images", "videos", "audios", "texts"] as const;
export type LibraryMedia = typeof libraryMediaTypes[number];
export const LIBRARY_VIEW_ORDER = ["collections", "project", "tags", "global"] as const;
export type LibraryView = typeof LIBRARY_VIEW_ORDER[number];
// "global" here is the file browser's aggregate directory, not a source tab.
type FileMode = CatalogKind | "files" | "global";
const projectMemoryKey = (context: string | null) => `bowerbird.libraryProject.${context ?? "home"}`;
function rememberedProject(context: string | null) {
  try { return localStorage.getItem(projectMemoryKey(context)) || context; } catch { return context; }
}
export const createLocalFileMode = (paneId = "main") => {
  type Memory = { view: LibraryView; tagSource: LibrarySource; media: LibraryMedia };
  const memories = new Map<string | null, Memory>();
  const memoryKey = (context: string | null) => `bowerbird.libraryView.${paneId}.${context ?? "home"}`;
  function navigation(context: string | null) {
    let memory = memories.get(context);
    if (!memory) {
      let saved: Partial<Memory> | null = null;
      try { saved = JSON.parse(localStorage.getItem(memoryKey(context)) ?? "null"); } catch { /* Use defaults without storage. */ }
      const view = saved?.view && LIBRARY_VIEW_ORDER.includes(saved.view) ? saved.view : context ? "project" : "global";
      const tagSource = saved?.tagSource === "project" || saved?.tagSource === "global" ? saved.tagSource : context ? "project" : "global";
      const media = saved?.media && libraryMediaTypes.includes(saved.media) ? saved.media : "images";
      memory = { view, tagSource, media };
      memories.set(context, memory);
    }
    const source: LibrarySource = memory.view === "tags" ? memory.tagSource : memory.view === "project" ? "project" : "global";
    const mode: FileMode = memory.view === "global" || memory.view === "project" ? "all" : memory.view;
    return { ...memory, source, mode };
  }
  const store = create<{
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
  open: false, query: "", ...navigation(null),
  contextProjectId: null, browseProjectId: rememberedProject(null), projectPickerOpen: false, scopeMenuOpen: false,
  setProjectContext: contextProjectId => set(state => {
    if (state.contextProjectId === contextProjectId) return state;
    const restored = navigation(contextProjectId);
    return {
      ...restored, contextProjectId, browseProjectId: rememberedProject(contextProjectId),
      generatedFilter: restored.media === "audios" || restored.media === "texts" ? null : state.generatedFilter,
      query: "", projectPickerOpen: false, scopeMenuOpen: false,
    };
  }),
  selectProject: browseProjectId => {
    try { localStorage.setItem(projectMemoryKey(get().contextProjectId), browseProjectId); } catch { /* Keep browsing without storage. */ }
    set({ browseProjectId, projectPickerOpen: false, query: "" });
  },
  setProjectPickerOpen: projectPickerOpen => set({ projectPickerOpen }),
  setScopeMenuOpen: scopeMenuOpen => set({ scopeMenuOpen }),
  generatedFilter: null,
  setGeneratedFilter: generatedFilter => set({ generatedFilter }),
  navigationHost: null, globalRequest: 0,
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
  store.subscribe((state, previous) => {
    if (state.view === previous.view && state.tagSource === previous.tagSource && state.media === previous.media && state.contextProjectId === previous.contextProjectId) return;
    const memory = { view: state.view, tagSource: state.tagSource, media: state.media };
    memories.set(state.contextProjectId, memory);
    try { localStorage.setItem(memoryKey(state.contextProjectId), JSON.stringify(memory)); } catch { /* Keep session memory without storage. */ }
  });
  return store;
};

export const useLocalFileMode = createLocalFileMode();
