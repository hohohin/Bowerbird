import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

const MIN_ZOOM = .25, MAX_ZOOM = 8;
const isTyping = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest('input, textarea, select, [contenteditable="true"]');

/** View-only navigation, independent of layer geometry and undo history. */
export function useLayerViewport(preview: RefObject<HTMLElement>) {
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  const space = useRef(false);
  const pan = useRef<{ id: number; x: number; y: number; originX: number; originY: number } | null>(null);
  const blockDoubleClickUntil = useRef(0);

  function zoomBy(factor: number, clientX?: number, clientY?: number) {
    const bounds = preview.current?.getBoundingClientRect();
    if (!bounds || pan.current) return;
    const x = clientX === undefined ? 0 : clientX - bounds.left - bounds.width / 2;
    const y = clientY === undefined ? 0 : clientY - bounds.top - bounds.height / 2;
    setView(current => {
      const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, current.zoom * factor));
      const ratio = zoom / current.zoom;
      return { zoom, x: x - (x - current.x) * ratio, y: y - (y - current.y) * ratio };
    });
  }

  function endPan() {
    const id = pan.current?.id;
    pan.current = null; setPanning(false);
    if (id !== undefined && preview.current?.hasPointerCapture(id)) preview.current.releasePointerCapture(id);
  }

  useEffect(() => {
    const node = preview.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest('.layer-view-tools')) return;
      event.preventDefault(); event.stopPropagation();
      if (event.buttons) return;
      const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientHeight : 1);
      zoomBy(Math.exp(-Math.max(-200, Math.min(200, pixels)) * .002), event.clientX, event.clientY);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.isComposing || isTyping(event.target) || event.ctrlKey || event.metaKey || event.altKey || !node.closest('.app-modal')?.contains(event.target as Node)) return;
      event.preventDefault(); event.stopPropagation();
      space.current = true; setSpaceHeld(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      if (space.current) { event.preventDefault(); event.stopPropagation(); }
      space.current = false; setSpaceHeld(false);
    };
    const reset = () => { space.current = false; setSpaceHeld(false); endPan(); };
    const visibility = () => { if (document.hidden) reset(); };
    node.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", reset);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      node.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", reset);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  function onPointerDownCapture(event: ReactPointerEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest('.layer-view-tools')) return;
    if (event.button !== 1 && !(event.button === 0 && space.current)) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    pan.current = { id: event.pointerId, x: event.clientX, y: event.clientY, originX: view.x, originY: view.y };
    blockDoubleClickUntil.current = Date.now() + 400;
    setPanning(true);
  }
  function onPointerMove(event: ReactPointerEvent<HTMLElement>) {
    const current = pan.current;
    if (!current || current.id !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    blockDoubleClickUntil.current = Date.now() + 400;
    setView(previous => ({ ...previous, x: current.originX + event.clientX - current.x, y: current.originY + event.clientY - current.y }));
  }

  return { view, spaceHeld, panning, zoomBy, reset: () => { endPan(); setView({ zoom: 1, x: 0, y: 0 }); },
    transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
    blocksDoubleClick: () => space.current || !!pan.current || Date.now() < blockDoubleClickUntil.current,
    onPointerDownCapture, onPointerMove, endPan };
}
