import { create } from "zustand";

export type LibraryTab = "global" | "files";
const defaults: LibraryTab[] = ["global", "files"];
const key = "bowerbird.library.materialTabOrder";
function readOrder(): LibraryTab[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (Array.isArray(value)) {
      const order = value.filter(item => defaults.includes(item));
      if (order.length === 2 && new Set(order).size === 2) return order as LibraryTab[];
    }
  } catch { /* Use the default order if preferences are unavailable. */ }
  return defaults;
}
export const useLibraryTabOrder = create<{ order: LibraryTab[]; setOrder: (order: string[]) => void }>(set => ({
  order: readOrder(),
  setOrder: values => {
    if (values.length !== 2 || new Set(values).size !== 2 || !values.every(value => defaults.includes(value as LibraryTab))) return;
    const order = values as LibraryTab[];
    set({ order });
    try { localStorage.setItem(key, JSON.stringify(order)); } catch { /* Keep the session order. */ }
  },
}));
