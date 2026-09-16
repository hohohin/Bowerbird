import { useRef, type PointerEvent } from "react";

type Size = { width: number; height: number };
type Position = { x: number; y: number };

/** Shared pointer capture keeps resizing separate from canvas dragging and panning. */
export function CanvasResizeHandle({ label, size, position, corner = "se", zoom, minimum, constrain, onResize }: {
  label: string;
  size: Size;
  position?: Position;
  corner?: "nw" | "ne" | "sw" | "se";
  zoom: number;
  minimum: Size;
  constrain?: (size: Size, delta: Size) => Size;
  onResize: (size: Size & Partial<Position>, finished: boolean, cancelled?: boolean) => void;
}) {
  const drag = useRef<{ initial: Size & Partial<Position>; pointerId: number; x: number; y: number; zoom: number } | null>(null);
  function resized(event: PointerEvent<HTMLButtonElement>) {
    const start = drag.current!;
    const left = corner.endsWith("w"), top = corner.startsWith("n");
    const delta = { width: (event.clientX - start.x) / start.zoom * (left ? -1 : 1), height: (event.clientY - start.y) / start.zoom * (top ? -1 : 1) };
    const next = constrain ? constrain(start.initial, delta) : {
      width: Math.max(minimum.width, start.initial.width + delta.width),
      height: Math.max(minimum.height, start.initial.height + delta.height),
    };
    return {
      ...next,
      ...(start.initial.x != null ? { x: start.initial.x + (left ? start.initial.width - next.width : 0) } : {}),
      ...(start.initial.y != null ? { y: start.initial.y + (top ? start.initial.height - next.height : 0) } : {}),
    };
  }
  function finish(event: PointerEvent<HTMLButtonElement>, cancelled = false) {
    if (drag.current?.pointerId !== event.pointerId) return;
    event.stopPropagation();
    const next = cancelled ? drag.current.initial : resized(event);
    drag.current = null;
    onResize(next, true, cancelled);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  return <button className="canvas-resize-handle" data-corner={corner} aria-label={label} title="拖动调整大小"
    onClick={event => event.stopPropagation()}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Escape" && drag.current) {
        const start = drag.current;
        drag.current = null;
        onResize(start.initial, true, true);
        if (event.currentTarget.hasPointerCapture(start.pointerId)) event.currentTarget.releasePointerCapture(start.pointerId);
      }
    }}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.stopPropagation(); event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      drag.current = { initial: { width: size.width, height: size.height, ...position }, pointerId: event.pointerId, x: event.clientX, y: event.clientY, zoom };
      event.currentTarget.setPointerCapture(event.pointerId);
      onResize(drag.current.initial, false);
    }}
    onPointerMove={event => {
      if (drag.current?.pointerId !== event.pointerId) return;
      event.stopPropagation(); onResize(resized(event), false);
    }}
    onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)} />;
}
