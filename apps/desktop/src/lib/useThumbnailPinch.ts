import { useEffect, useState } from "react";
import { useStore } from "../store";
import { clampThumbnailWidth, MAX_THUMBNAIL_WIDTH, minThumbnailWidth, type ThumbnailScope } from "./thumbnailSize";

/** Attach to the library region once, including all its embedded project grids. */
export function useThumbnailPinch(scope: ThumbnailScope) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!element) return;
    const readWidth = () => {
      const state = useStore.getState();
      return scope === "library" ? state.libraryThumbnailWidth : state.canvasThumbnailWidth;
    };
    let width = readWidth();
    let lastApplied = width;
    let lastWheelAt = 0;
    let gestureScale: number | null = null;

    function resetWidth() { width = lastApplied = readWidth(); }
    function resize(factor: number) {
      if (readWidth() !== lastApplied) resetWidth();
      // Keep sub-step movement so slow pinches accumulate; clamp before rounding
      // so reversing at a limit responds immediately.
      width = Math.max(minThumbnailWidth(scope), Math.min(MAX_THUMBNAIL_WIDTH, width * factor));
      const next = clampThumbnailWidth(width, scope);
      if (next === lastApplied) return;
      lastApplied = next;
      useStore.getState().setThumbnailWidth(scope, next);
    }
    function onWheel(event: WheelEvent) {
      // Chromium pinch uses Ctrl+wheel; also support explicit Ctrl/Cmd+wheel.
      if (!(event.ctrlKey || event.metaKey) || !Number.isFinite(event.deltaY)) return;
      event.preventDefault();
      event.stopPropagation();
      if (gestureScale !== null) return; // Avoid applying both event streams on WebKit.
      const now = performance.now();
      if (now - lastWheelAt > 200) resetWidth();
      lastWheelAt = now;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element!.clientHeight : 1;
      // Mouse wheel notches are much larger than trackpad deltas.
      const delta = Math.max(-12, Math.min(12, event.deltaY * unit));
      resize(Math.exp(-delta * 0.01));
    }
    function onGestureStart(event: Event) {
      event.preventDefault();
      event.stopPropagation();
      resetWidth();
      gestureScale = 1;
    }
    function onGestureChange(event: Event) {
      if (gestureScale === null) return;
      event.preventDefault();
      event.stopPropagation();
      const scale = (event as Event & { scale: number }).scale;
      if (!Number.isFinite(scale) || scale <= 0) return;
      resize(scale / gestureScale);
      gestureScale = scale;
    }
    function onGestureEnd(event: Event) {
      if (gestureScale === null) return;
      event.preventDefault();
      event.stopPropagation();
      gestureScale = null;
      lastWheelAt = 0;
    }
    element.addEventListener("wheel", onWheel, { passive: false });
    // Safari/WKWebView exposes cumulative scale through GestureEvent instead.
    element.addEventListener("gesturestart", onGestureStart, { passive: false });
    element.addEventListener("gesturechange", onGestureChange, { passive: false });
    element.addEventListener("gestureend", onGestureEnd, { passive: false });
    return () => {
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("gesturestart", onGestureStart);
      element.removeEventListener("gesturechange", onGestureChange);
      element.removeEventListener("gestureend", onGestureEnd);
    };
  }, [element, scope]);
  return setElement;
}
