import { useCallback, useMemo, useState, type SetStateAction } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";

export function useCanvasScope<State extends object>(initial: () => State) {
  const [store] = useState(() => createStore<State>(initial));
  return store;
}

/** Event handlers and rendering read the same workspace-owned value. */
export function useCanvasScopeValue<State extends object, Key extends keyof State>(store: StoreApi<State>, key: Key) {
  const value = useStore(store, state => state[key]);
  const setValue = useCallback((input: SetStateAction<State[Key]>) => {
    const previous = store.getState()[key];
    const next = typeof input === "function" ? (input as (value: State[Key]) => State[Key])(previous) : input;
    if (!Object.is(previous, next)) store.setState({ [key]: next } as unknown as Partial<State>);
  }, [store, key]);
  const current = useMemo(() => ({
    get current() { return store.getState()[key]; },
  }), [store, key]);
  return [value, setValue, current] as const;
}
