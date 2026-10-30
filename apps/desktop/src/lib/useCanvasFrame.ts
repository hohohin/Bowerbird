import { useCallback, useEffect, useMemo, useRef } from "react";

/** Stable event identity with the current render's state. */
export function useLatestCallback<Args extends unknown[], Result>(callback: (...args: Args) => Result) {
  const latest = useRef(callback);
  latest.current = callback;
  return useCallback((...args: Args) => latest.current(...args), []);
}

/** Keep the last sample per frame; pointerup can synchronously deliver its final sample. */
export function useCanvasFrame<T>(update: (sample: T) => void) {
  const deliver = useLatestCallback(update);
  const state = useRef<{ frame: number | null; pending: { sample: T } | null }>({ frame: null, pending: null });
  const frame = useMemo(() => {
    const cancel = () => {
      if (state.current.frame != null) cancelAnimationFrame(state.current.frame);
      state.current.frame = null;
      state.current.pending = null;
    };
    const flush = () => {
      const pending = state.current.pending;
      cancel();
      if (pending) deliver(pending.sample);
    };
    return {
      cancel, flush,
      push(sample: T) {
        state.current.pending = { sample };
        if (state.current.frame == null) state.current.frame = requestAnimationFrame(flush);
      },
      finish(sample: T) { cancel(); deliver(sample); },
    };
  }, [deliver]);
  useEffect(() => frame.cancel, [frame]);
  return frame;
}
