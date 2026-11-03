import { useRef } from "react";

/** Composition state and legacy key events describe the same unfinished input. */
export function useImeGuard() {
  const composing = useRef(false);
  return {
    composing,
    onCompositionStart: () => { composing.current = true; },
    onCompositionEnd: () => { composing.current = false; },
    isComposing: (event: Pick<KeyboardEvent, "isComposing" | "keyCode">) =>
      composing.current || event.isComposing || event.keyCode === 229,
  };
}
