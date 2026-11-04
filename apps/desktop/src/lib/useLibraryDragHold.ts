import { useEffect, useRef, type DragEvent, type PointerEvent } from "react";
import { createCanvasDragHold } from "./canvasDragHold";
import { startExternalDrag } from "./externalDrag";

function isLibraryPress(event: PointerEvent<HTMLElement>) {
  return event.button === 0 && event.pointerType === "mouse"
    && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;
}

function suppressTailClick() {
  const clear = () => {
    window.removeEventListener("click", consume, true);
    window.removeEventListener("pointerdown", clear, true);
  };
  const consume = (event: MouseEvent) => {
    if (event.detail === 0) return; // Keyboard activation is not the mouse press's tail click.
    event.preventDefault(); event.stopImmediatePropagation(); clear();
  };
  window.addEventListener("click", consume, true);
  window.addEventListener("pointerdown", clear, true);
  return clear;
}

function exceedsLibraryThreshold(start: { x: number; y: number }, point: { x: number; y: number }) {
  return Math.hypot(point.x - start.x, point.y - start.y) > 4;
}

/** A cancelled browser dragstart will not restart itself; hand later movement to the same native bridge. */
function trackPress(event: PointerEvent<HTMLElement>, ready: (externalOnly: boolean) => void) {
  const hold = createCanvasDragHold(exceedsLibraryThreshold);
  const origin = { x: event.clientX, y: event.clientY };
  const pointerId = event.pointerId;
  let pending = true, deferred = false;
  const move = (event: globalThis.PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    if (!(event.buttons & 1)) { end(); return; }
    if (exceedsLibraryThreshold(origin, { x: event.clientX, y: event.clientY })) {
      end();
      if (deferred) ready(false);
      return;
    }
    hold.move(event.pointerId, { x: event.clientX, y: event.clientY }, event.buttons);
  };
  const end = () => {
    pending = false; hold.cancel();
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", end, true);
    window.removeEventListener("pointercancel", end, true);
    window.removeEventListener("blur", end);
    window.removeEventListener("scroll", end, true);
    window.removeEventListener("keydown", key, true);
  };
  const key = (event: KeyboardEvent) => { if (event.key === "Escape") end(); };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", end, true);
  window.addEventListener("pointercancel", end, true);
  window.addEventListener("blur", end);
  window.addEventListener("scroll", end, true);
  window.addEventListener("keydown", key, true);
  hold.start(pointerId, origin, () => { end(); ready(true); });
  return {
    cancel: end,
    deferDragStart(event: DragEvent<HTMLElement>) {
      if (pending && !exceedsLibraryThreshold(origin, { x: event.clientX, y: event.clientY })) {
        deferred = true; event.preventDefault(); return true;
      }
      end(); return false;
    },
  };
}

type PrepareLibraryDrag = ((element: HTMLElement) => string[] | null) | undefined;

function beginLibraryDrag(element: HTMLElement, prepare: PrepareLibraryDrag, externalOnly: boolean) {
  if (!element.isConnected || element.closest('[inert], [aria-hidden="true"]')) return;
  const ids = prepare?.(element);
  if (!ids?.length) return;
  const clearClick = suppressTailClick();
  const controller = new AbortController();
  void startExternalDrag(ids, "hold", { externalOnly, signal: controller.signal,
    sourceRect: (element.querySelector("img, video") ?? element).getBoundingClientRect(),
  });
  return () => { clearClick(); controller.abort(); };
}

/** Library presses allow 4px of jitter; ordinary movement keeps its existing drag path. */
export function useLibraryDragHold(identity: string, prepare: PrepareLibraryDrag) {
  const current = useRef(prepare);
  current.current = prepare;
  const gesture = useRef<ReturnType<typeof trackPress>>();
  const cancelActive = useRef<() => void>(() => {});
  useEffect(() => () => {
    gesture.current?.cancel(); cancelActive.current();
  }, [identity, !!prepare]);
  function onPointerDown(event: PointerEvent<HTMLElement>) {
    gesture.current?.cancel();
    if (!current.current || !isLibraryPress(event)) return;
    const element = event.currentTarget;
    gesture.current = trackPress(event, externalOnly => {
      const cancel = beginLibraryDrag(element, current.current, externalOnly);
      if (cancel) { cancelActive.current(); cancelActive.current = cancel; }
    });
  }
  return { onPointerDown, deferDragStart: (event: DragEvent<HTMLElement>) => gesture.current?.deferDragStart(event) ?? false };
}
