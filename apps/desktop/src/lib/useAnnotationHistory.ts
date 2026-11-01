import { useState } from "react";

/** Each editor owns its snapshots; the same undo/redo rules apply to shapes and image transforms. */
export function useAnnotationHistory<T>() {
  const [past, setPast] = useState<T[]>([]);
  const [future, setFuture] = useState<T[]>([]);
  return {
    past,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    record(current: T) { setPast(items => [...items, current]); setFuture([]); },
    undo(current: T): T | undefined {
      if (!past.length) return;
      setPast(past.slice(0, -1)); setFuture(items => [...items, current]);
      return past[past.length - 1];
    },
    redo(current: T): T | undefined {
      if (!future.length) return;
      setFuture(future.slice(0, -1)); setPast(items => [...items, current]);
      return future[future.length - 1];
    },
    reset() { setPast([]); setFuture([]); },
  };
}
