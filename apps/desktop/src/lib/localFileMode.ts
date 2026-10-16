import { create } from "zustand";

export const useLocalFileMode = create<{
  open: boolean; query: string;
  setOpen: (value: boolean | ((value: boolean) => boolean)) => void;
  setQuery: (query: string) => void;
}>((set) => ({
  open: false, query: "",
  setOpen: value => set(state => ({ open: typeof value === "function" ? value(state.open) : value })),
  setQuery: query => set({ query }),
}));
