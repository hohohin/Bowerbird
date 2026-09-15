import { useRef, useState, type PointerEvent } from "react";
import { canvasBubbleTailAt, type CanvasBubbleTail as Tail } from "../lib/canvasNotes";

export function CanvasBubbleTail({ value, width, height, onChange, onSelect }: {
  value: Tail; width: number; height: number; onChange: (tail: Tail) => void; onSelect: () => void;
}) {
  const [preview, setPreview] = useState<Tail | null>(null);
  const drag = useRef<{ pointerId: number; bounds: DOMRect; tail: Tail } | null>(null);
  const tail = preview ?? value;
  const horizontal = tail.side === "top" || tail.side === "bottom";
  const length = horizontal ? width : height;
  const position = Math.max(24, Math.min(length - 24, length * tail.position / 100));
  function at(event: PointerEvent<HTMLButtonElement>) {
    const rect = drag.current!.bounds;
    return canvasBubbleTailAt((event.clientX - rect.left) / rect.width * width, (event.clientY - rect.top) / rect.height * height, width, height);
  }
  function finish(event: PointerEvent<HTMLButtonElement>, cancelled = false) {
    if (drag.current?.pointerId !== event.pointerId) return;
    event.stopPropagation();
    const next = drag.current.tail;
    drag.current = null;
    setPreview(null);
    if (!cancelled) onChange(next);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  return <button className={`canvas-bubble-tail is-${tail.side}`} aria-label="调整气泡突出部分" title="拖动到便签边缘，调整突出位置"
    style={horizontal ? { left: position } : { top: position }}
    onClick={event => event.stopPropagation()}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.stopPropagation(); event.preventDefault();
      onSelect();
      event.currentTarget.focus({ preventScroll: true });
      drag.current = { pointerId: event.pointerId, bounds: event.currentTarget.closest(".canvas-note")!.getBoundingClientRect(), tail: value };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      if (drag.current?.pointerId !== event.pointerId) return;
      event.stopPropagation();
      const next = at(event);
      drag.current.tail = next;
      setPreview(next);
    }}
    onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Escape" && drag.current) {
        const pointerId = drag.current.pointerId;
        drag.current = null; setPreview(null);
        if (event.currentTarget.hasPointerCapture(pointerId)) event.currentTarget.releasePointerCapture(pointerId);
      }
    }}>
    <svg viewBox="0 0 36 36" aria-hidden="true"><path d="M2 0H34C27 4 25 17 21 27Q18 34 15 27C11 17 9 4 2 0Z" /></svg>
  </button>;
}
