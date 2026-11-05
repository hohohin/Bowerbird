import { useEffect, type RefObject } from "react";
import type { EditorView } from "prosemirror-view";

/** A paint-only caret: ProseMirror and the native selection still own editing/IME. */
export function useTerminalCaret(viewRef: RefObject<EditorView | null>, hostRef: RefObject<HTMLDivElement>) {
  useEffect(() => {
    const view = viewRef.current, host = hostRef.current;
    if (!view || !host) return;
    const caret = document.createElement("span");
    caret.className = "composer-terminal-caret";
    caret.setAttribute("aria-hidden", "true");
    caret.hidden = true;
    host.append(caret);
    host.classList.add("has-terminal-caret");
    let frame = 0;
    function paint() {
      frame = 0;
      const selection = document.getSelection();
      if (!view!.hasFocus() || !selection?.isCollapsed || !selection.anchorNode || !view!.dom.contains(selection.anchorNode)) {
        caret.hidden = true;
        return;
      }
      // During composition the DOM is ahead of the PM transaction; do not disturb it.
      const composing = view!.composing && selection.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
      const point = composing?.height ? composing : view!.coordsAtPos(view!.state.selection.head);
      const origin = host!.getBoundingClientRect();
      caret.hidden = false;
      caret.style.left = `${point.left - origin.left + host!.scrollLeft}px`;
      caret.style.top = `${point.top - origin.top + host!.scrollTop + Math.max(0, (point.bottom - point.top - 20) / 2)}px`;
    }
    function schedule() { if (!frame) frame = requestAnimationFrame(paint); }
    const observer = new MutationObserver(schedule);
    observer.observe(view.dom, { childList: true, subtree: true, characterData: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(view.dom);
    const events = ["focusin", "focusout", "input", "keyup", "pointerup", "compositionupdate", "compositionend"];
    for (const event of events) host.addEventListener(event, schedule);
    document.addEventListener("selectionchange", schedule);
    window.addEventListener("scroll", schedule, true);
    schedule();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); resize.disconnect(); caret.remove();
      host.classList.remove("has-terminal-caret");
      for (const event of events) host.removeEventListener(event, schedule);
      document.removeEventListener("selectionchange", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [hostRef, viewRef]);
}
