import { create } from "zustand";

export const libraryMediaTypes = ["all", "images", "videos", "audios", "texts"] as const;
export type LibraryMedia = typeof libraryMediaTypes[number];
export type LibrarySidebarMode = "hierarchy" | "tags";
export type LibraryHierarchyTarget =
  | { kind: "all" }
  | { kind: "projects"; projectId: string | null }
  | { kind: "folders"; folderId: string | null };
type FileMode = "all" | "tags" | "collections" | "files" | "global";
type Memory = { sidebarMode: LibrarySidebarMode; sidebarCollapsed: boolean; hierarchyTarget: LibraryHierarchyTarget; media: LibraryMedia };
type SavedMemory = Partial<Memory> & { source?: string; lens?: string; view?: string; tagSource?: string };

export function libraryShortcutMode(key: string): LibrarySidebarMode | undefined {
  switch (key.toLowerCase()) {
    case "q": return "hierarchy";
    case "e": return "tags";
  }
}

export const libraryProject = ({ sidebarMode, hierarchyTarget }: Memory) =>
  sidebarMode === "hierarchy" && hierarchyTarget.kind === "projects" ? hierarchyTarget.projectId : null;

export function createLocalFileMode(paneId = "main") {
  const memories = new Map<string | null, Memory>();
  const memoryKey = (context: string | null) => `bowerbird.libraryView.${paneId}.${context ?? "home"}`;
  function navigation(context: string | null): Memory {
    const memory = memories.get(context);
    if (memory) return memory;
    let saved: SavedMemory | null = null, projectId = context;
    try {
      saved = JSON.parse(localStorage.getItem(memoryKey(context)) ?? "null");
      const oldProjectKey = `bowerbird.libraryProject.${context ?? "home"}`;
      projectId = (paneId !== "main" ? localStorage.getItem(`bowerbird.libraryPaneProject.${paneId}.${context ?? "home"}`) : null)
        ?? localStorage.getItem(oldProjectKey) ?? context;
    } catch { /* Use defaults when the previous preference is unavailable. */ }
    const source = saved?.source ?? (saved?.view === "tags" ? saved.tagSource : saved?.view);
    const previousTarget: LibraryHierarchyTarget = source === "folders" || source === "collections" ? { kind: "folders", folderId: null }
      : source === "project" || (!source && context) ? { kind: "projects", projectId } : { kind: "all" };
    const target = saved?.hierarchyTarget;
    const validTarget = target?.kind === "all"
      || (target?.kind === "projects" && (typeof target.projectId === "string" || target.projectId === null))
      || (target?.kind === "folders" && (typeof target.folderId === "string" || target.folderId === null));
    const result: Memory = {
      hierarchyTarget: validTarget ? target! : previousTarget,
      sidebarMode: saved?.sidebarMode === "tags" || (saved?.sidebarMode !== "hierarchy" && (saved?.lens === "tags" || saved?.view === "tags")) ? "tags" : "hierarchy",
      sidebarCollapsed: saved?.sidebarCollapsed === true,
      media: saved?.media && libraryMediaTypes.includes(saved.media) ? saved.media : "images",
    };
    memories.set(context, result);
    return result;
  }
  const store = create<Memory & {
    open: boolean; query: string; mode: FileMode; globalRequest: number;
    navigationHost: HTMLDivElement | null;
    contextProjectId: string | null;
    setProjectContext: (id: string | null) => void;
    setSidebarMode: (mode: LibrarySidebarMode) => void;
    setSidebarCollapsed: (collapsed: boolean) => void;
    selectHierarchy: (target: LibraryHierarchyTarget) => void;
    generatedFilter: "source:generated" | "source:!generated" | null;
    setGeneratedFilter: (filter: "source:generated" | "source:!generated" | null) => void;
    setMedia: (media: LibraryMedia) => void;
    setMode: (mode: FileMode) => void;
    openBrowser: () => void;
    setOpen: (value: boolean | ((value: boolean) => boolean)) => void;
    setQuery: (query: string) => void;
  }>((set, get) => ({
    ...navigation(null),
    open: false, query: "", mode: "all", globalRequest: 0, navigationHost: null, contextProjectId: null,
    setProjectContext: contextProjectId => set(state => {
      if (state.contextProjectId === contextProjectId) return state;
      const restored = navigation(contextProjectId);
      return {
        ...restored, contextProjectId, query: "",
        generatedFilter: restored.media === "audios" || restored.media === "texts" ? null : state.generatedFilter,
      };
    }),
    setSidebarMode: sidebarMode => set(state => state.sidebarMode === sidebarMode ? state : { sidebarMode, query: "" }),
    setSidebarCollapsed: sidebarCollapsed => set({ sidebarCollapsed }),
    selectHierarchy: hierarchyTarget => set(state => state.sidebarMode === "hierarchy"
      && JSON.stringify(state.hierarchyTarget) === JSON.stringify(hierarchyTarget) ? state
      : { hierarchyTarget, sidebarMode: "hierarchy", query: "", open: true }),
    generatedFilter: null,
    setGeneratedFilter: generatedFilter => set({ generatedFilter }),
    setMedia: media => set(state => ({ media, generatedFilter: media === "audios" || media === "texts" ? null : state.generatedFilter })),
    setMode: mode => set({ mode }),
    openBrowser: () => { get().selectHierarchy({ kind: "folders", folderId: null }); get().setOpen(true); },
    setOpen: value => set(state => ({ open: typeof value === "function" ? value(state.open) : value })),
    setQuery: query => set({ query }),
  }));
  store.subscribe((state, previous) => {
    const { sidebarMode, sidebarCollapsed, hierarchyTarget, media, contextProjectId } = state;
    if (sidebarMode === previous.sidebarMode && sidebarCollapsed === previous.sidebarCollapsed && hierarchyTarget === previous.hierarchyTarget
      && media === previous.media && contextProjectId === previous.contextProjectId) return;
    const memory = { sidebarMode, sidebarCollapsed, hierarchyTarget, media };
    memories.set(contextProjectId, memory);
    try { localStorage.setItem(memoryKey(contextProjectId), JSON.stringify(memory)); } catch { /* Keep session memory without storage. */ }
  });
  return store;
}

export const useLocalFileMode = createLocalFileMode();
