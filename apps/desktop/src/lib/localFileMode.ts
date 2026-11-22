import { create } from "zustand";
import type { CatalogKind } from "./materialCatalog";

export const LIBRARY_SOURCES = ["global", "project", "folders"] as const;
export type LibrarySource = typeof LIBRARY_SOURCES[number];
export type LibraryLens = "flow" | "tags";
const libraryMediaTypes = ["all", "images", "videos", "audios", "texts"] as const;
export type LibraryMedia = typeof libraryMediaTypes[number];
type FileMode = "all" | "tags" | "collections" | "files" | "global";
type Memory = { source: LibrarySource; lens: LibraryLens; media: LibraryMedia };
type SavedMemory = Partial<Memory> & { view?: string; tagSource?: string };

const fileMode = (source: LibrarySource, lens: LibraryLens): FileMode =>
  source === "folders" ? "collections" : lens === "tags" ? "tags" : "all";

export function libraryShortcutSource(key: string): LibrarySource | undefined {
  switch (key.toLowerCase()) {
    case "q": return "global";
    case "e": return "project";
    case "f": return "folders";
  }
}

export const createLocalFileMode = (paneId = "main") => {
  const memories = new Map<string | null, Memory>();
  const projects = new Map<string | null, string>();
  const memoryKey = (context: string | null) => `bowerbird.libraryView.${paneId}.${context ?? "home"}`;
  const legacyProjectKey = (context: string | null) => `bowerbird.libraryProject.${context ?? "home"}`;
  const projectKey = (context: string | null) => paneId === "main" ? legacyProjectKey(context) : `bowerbird.libraryPaneProject.${paneId}.${context ?? "home"}`;
  function rememberedProject(context: string | null) {
    if (projects.has(context)) return projects.get(context)!;
    try { return localStorage.getItem(projectKey(context)) || localStorage.getItem(legacyProjectKey(context)) || context; }
    catch { return context; }
  }
  function navigation(context: string | null) {
    let memory = memories.get(context);
    if (!memory) {
      let saved: SavedMemory | null = null;
      try { saved = JSON.parse(localStorage.getItem(memoryKey(context)) ?? "null"); } catch { /* Use defaults without storage. */ }
      const defaultSource = context ? "project" : "global";
      const legacySource = saved?.view === "collections" ? "folders"
        : saved?.view === "project" || saved?.view === "global" ? saved.view
        : saved?.view === "tags" && (saved.tagSource === "project" || saved.tagSource === "global") ? saved.tagSource
        : defaultSource;
      const source = saved?.source && LIBRARY_SOURCES.includes(saved.source) ? saved.source : legacySource;
      const lens = saved?.lens === "flow" || saved?.lens === "tags" ? saved.lens : saved?.view === "tags" ? "tags" : "flow";
      const media = saved?.media && libraryMediaTypes.includes(saved.media) ? saved.media : "images";
      memory = { source, lens, media };
      memories.set(context, memory);
    }
    return { ...memory, mode: fileMode(memory.source, memory.lens) };
  }
  const store = create<Memory & {
  open: boolean; query: string;
  contextProjectId: string | null;
  browseProjectId: string | null;
  setProjectContext: (id: string | null) => void;
  selectProject: (id: string) => void;
  generatedFilter: "source:generated" | "source:!generated" | null;
  setGeneratedFilter: (filter: "source:generated" | "source:!generated" | null) => void;
  setMedia: (media: LibraryMedia) => void;
  globalRequest: number;
  mode: FileMode;
  setMode: (mode: FileMode) => void;
  openSource: (source: LibrarySource) => void;
  setLens: (lens: LibraryLens) => void;
  setCatalogView: (kind: CatalogKind) => void;
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
  contextProjectId: null, browseProjectId: rememberedProject(null),
  setProjectContext: contextProjectId => set(state => {
    if (state.contextProjectId === contextProjectId) return state;
    const restored = navigation(contextProjectId);
    return {
      ...restored, contextProjectId, browseProjectId: rememberedProject(contextProjectId),
      generatedFilter: restored.media === "audios" || restored.media === "texts" ? null : state.generatedFilter,
      query: "",
    };
  }),
  selectProject: browseProjectId => {
    const { contextProjectId } = get();
    projects.set(contextProjectId, browseProjectId);
    try { localStorage.setItem(projectKey(contextProjectId), browseProjectId); } catch { /* Keep browsing without storage. */ }
    set({ browseProjectId, query: "" });
  },
  generatedFilter: null,
  setGeneratedFilter: generatedFilter => set({ generatedFilter }),
  navigationHost: null, globalRequest: 0,
  setMode: mode => set({ mode }),
  openSource: source => set(state => ({
    open: true, source, mode: fileMode(source, state.lens), query: state.source === source ? state.query : "",
  })),
  setLens: lens => set(state => ({ lens, mode: fileMode(state.source, lens) })),
  setCatalogView: kind => {
    const { source, openSource, setLens } = get();
    openSource(kind === "collections" ? "folders" : source === "folders" ? "global" : source);
    if (kind !== "collections") setLens(kind === "tags" ? "tags" : "flow");
  },
  setMedia: media => set(state => ({ media, generatedFilter: media === "audios" || media === "texts" ? null : state.generatedFilter })),
  toggleCatalog: () => {
    const { source, lens, setLens } = get();
    if (source !== "folders") setLens(lens === "flow" ? "tags" : "flow");
  },
  closeBrowser: () => set(state => ({ mode: fileMode(state.source, state.lens), query: "" })),
  openGlobal: () => get().openSource("global"),
  openBrowser: () => get().openSource("folders"),
  setNavigationHost: navigationHost => set({ navigationHost }),
  setOpen: value => set(state => ({ open: typeof value === "function" ? value(state.open) : value })),
  setQuery: query => set({ query }),
}));
  store.subscribe((state, previous) => {
    if (state.source === previous.source && state.lens === previous.lens && state.media === previous.media && state.contextProjectId === previous.contextProjectId) return;
    const memory = { source: state.source, lens: state.lens, media: state.media };
    memories.set(state.contextProjectId, memory);
    try { localStorage.setItem(memoryKey(state.contextProjectId), JSON.stringify(memory)); } catch { /* Keep session memory without storage. */ }
  });
  return store;
};

export const useLocalFileMode = createLocalFileMode();
