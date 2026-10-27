import { createContext, useContext } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createLocalFileMode, useLocalFileMode } from "./localFileMode";
import { useCatalogPins } from "./catalogPins";
import { useStore } from "../store";
import type { ThumbnailScope } from "./thumbnailSize";

export type LibraryBrowsePosition = { active: string | null; top: number; alphabetic: boolean; color: string | null; query: string; generatedFilter: string | null };
export function createLibraryPane(id: string, mode = createLocalFileMode()) {
  return { id, mode, positions: new Map<string, LibraryBrowsePosition>(), preferences: create<{
    width: number; setWidth: (width: number) => void;
    pins: string[]; togglePin: (id: string) => void;
  }>()(persist(set => ({
    width: useStore.getState().libraryThumbnailWidth,
    setWidth: width => set({ width }),
    pins: [...useCatalogPins.getState().ids],
    togglePin: id => set(state => ({ pins: state.pins.includes(id) ? state.pins.filter(value => value !== id) : [id, ...state.pins] })),
  }), { name: `bowerbird.libraryPane.${id}`, partialize: ({ width, pins }) => ({ width, pins }) })) };
}
export type LibraryPaneState = ReturnType<typeof createLibraryPane>;
export function copyLibraryPane(id: string, source: LibraryPaneState) {
  const pane = createLibraryPane(id), state = source.mode.getState(), preferences = source.preferences.getState();
  pane.mode.setState({ open: true, mode: state.mode, source: state.source, media: state.media,
    views: { ...state.views }, videoViews: { ...state.videoViews }, generatedFilter: state.generatedFilter, query: "" });
  pane.preferences.setState({ width: preferences.width, pins: [...preferences.pins] });
  source.positions.forEach((position, key) => pane.positions.set(key, { ...position }));
  for (const key of ["bowerbird.localFiles.lastDirectory", "bowerbird.catalog.tagSidebarWidth"]) {
    try {
      const value = localStorage.getItem(`${key}.${source.id}`) ?? localStorage.getItem(key);
      if (value === null) localStorage.removeItem(`${key}.${id}`);
      else localStorage.setItem(`${key}.${id}`, value);
    } catch { /* Browsing remains available without persisted preferences. */ }
  }
  return pane;
}
const mountedPanes = new Map<string, LibraryPaneState>();
export function registerLibraryPane(pane: LibraryPaneState) {
  mountedPanes.set(pane.id, pane);
  return () => { if (mountedPanes.get(pane.id) === pane) mountedPanes.delete(pane.id); };
}
export function libraryPaneAt(target: EventTarget | null) {
  const id = target instanceof Element ? target.closest<HTMLElement>("[data-library-pane]")?.dataset.libraryPane : undefined;
  return id ? mountedPanes.get(id) : undefined;
}
export const LibraryPaneContext = createContext<LibraryPaneState | null>(null);
export const useLibraryPane = () => useContext(LibraryPaneContext);
export const useLibraryModeStore = () => useLibraryPane()?.mode ?? useLocalFileMode;
export const useActiveLibraryPane = create<{ pane: LibraryPaneState | null; activate: (pane: LibraryPaneState | null) => void }>(set => ({ pane: null, activate: pane => set({ pane }) }));
export const useActiveLibraryModeStore = () => useActiveLibraryPane(s => s.pane)?.mode ?? useLocalFileMode;

export function useLibraryThumbnail(scope: ThumbnailScope) {
  const pane = useLibraryPane();
  const preferences = pane?.preferences;
  // Subscribe to a stable fallback store outside a pane (canvas and project views).
  const global = useStore(s => scope === "library" ? s.libraryThumbnailWidth : scope === "projects" ? s.projectsThumbnailWidth : s.canvasThumbnailWidth);
  const local = (preferences ?? fallbackPreferences)(s => s.width);
  return {
    width: scope === "library" && preferences ? local : global,
    setWidth: (width: number) => scope === "library" && preferences ? preferences.getState().setWidth(width) : useStore.getState().setThumbnailWidth(scope, width),
  };
}
const fallbackPreferences = create(() => ({ width: 0, pins: [] as string[], togglePin: (_id: string) => {} }));

export function useLibraryPins() {
  const pane = useLibraryPane();
  const global = useCatalogPins();
  const local = (pane?.preferences ?? fallbackPreferences)();
  return pane ? { ids: local.pins, toggle: local.togglePin } : global;
}
