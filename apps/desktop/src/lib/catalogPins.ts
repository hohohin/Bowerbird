import { create } from "zustand";

const key = "bowerbird.catalog.pinnedTags";
function read(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string"))] : [];
  } catch { return []; }
}
export const useCatalogPins = create<{ ids: string[]; toggle: (id: string) => void }>(set => ({
  ids: read(),
  toggle: id => set(state => {
    const ids = state.ids.includes(id) ? state.ids.filter(value => value !== id) : [id, ...state.ids];
    try { localStorage.setItem(key, JSON.stringify(ids)); } catch { /* Session pins still work. */ }
    return { ids };
  }),
}));
