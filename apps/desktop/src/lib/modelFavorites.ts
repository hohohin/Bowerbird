import { create } from "zustand";
import { persist } from "zustand/middleware";

export function modelFavoriteKey(kind: string, source: string, key: string): string {
  return JSON.stringify([kind, source, key]);
}

export const useModelFavorites = create<{ keys: string[]; toggle: (key: string) => void }>()(persist(set => ({
  keys: [],
  toggle: key => set(state => ({ keys: state.keys.includes(key) ? state.keys.filter(item => item !== key) : [...state.keys, key] })),
}), { name: "bowerbird.model-favorites.v1" }));
