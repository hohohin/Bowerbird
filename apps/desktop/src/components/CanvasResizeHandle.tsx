import { useRef, type PointerEvent } from "react";

type Size = { width: number; height: number };

/** Shared pointer capture keeps resizing separate from canvas dragging and panning. */
export function CanvasResizeHandle({ label, size, zoom, minimum, constrain, onResize }: {
  label: string;
  size: Size;
  zoom: number;
  minimum: Size;
  constrain?: (size: Size, delta: Size) => Size;
  onResize: (size: Size, finished: boolean, cancelled?: boolean) => void;
}) {
  const drag = useRef<(Size & { pointerId: number; x: number; y: number; zoom: number }) | null>(null);
  function resized(event: PointerEvent<HTMLButtonElement>) {
    const start = drag.current!;
    const delta = { width: (event.clientX - start.x) / start.zoom, height: (event.clientY - start.y) / start.zoom };
    return constrain ? constrain(start, delta) : {
      width: Math.max(minimum.width, start.width + delta.width),
      height: Math.max(minimum.height, start.height + delta.height),
    };
  }
  function finish(event: PointerEvent<HTMLButtonElement>, cancelled = false) {
    if (drag.current?.pointerId !== event.pointerId) return;
    event.stopPropagation();
    const next = cancelled ? { width: drag.current.width, height: drag.current.height } : resized(event);
    drag.current = null;
    onResize(next, true, cancelled);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  return <button className="canvas-resize-handle" aria-label={label} title="拖动调整大小"
    onClick={event => event.stopPropagation()}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Escape" && drag.current) {
        const start = drag.current;
        drag.current = null;
        onResize({ width: start.width, height: start.height }, true, true);
        if (event.currentTarget.hasPointerCapture(start.pointerId)) event.currentTarget.releasePointerCapture(start.pointerId);
      }
    }}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.stopPropagation(); event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      drag.current = { ...size, pointerId: event.pointerId, x: event.clientX, y: event.clientY, zoom };
      event.currentTarget.setPointerCapture(event.pointerId);
      onResize(size, false);
    }}
    onPointerMove={event => {
      if (drag.current?.pointerId !== event.pointerId) return;
      event.stopPropagation(); onResize(resized(event), false);
    }}
    onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)} />;
}
