import { useEffect, useRef, useState } from "react";
import { Layers } from "lucide-react";
import { CANVAS_LAYER_STEP_EVENT, type CanvasLayerStepDetail } from "../lib/canvasLayers";

/** Stay captured on the menu item while the pointer travels outside the menu. */
export function CanvasLayerMenuItem({ projectId, nodeIds, className, disabled = false }: {
  projectId: string; nodeIds: string[]; className: string; disabled?: boolean;
}) {
  const gesture = useRef<{ pointerId: number; startY: number; direction: -1 | 0 | 1; timer: number | null } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [direction, setDirection] = useState<-1 | 0 | 1 | null>(null);
  function stop() {
    const current = gesture.current;
    gesture.current = null;
    if (current?.timer != null) window.clearInterval(current.timer);
    if (current && button.current?.hasPointerCapture(current.pointerId)) button.current.releasePointerCapture(current.pointerId);
    setDirection(null);
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") stop(); };
    const onVisibility = () => { if (document.hidden) stop(); };
    window.addEventListener("blur", stop);
    window.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      window.removeEventListener("blur", stop);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [projectId, nodeIds.join("\u0000")]);
  return <button ref={button} type="button" role="menuitem" disabled={disabled}
    aria-label="调整层级" title="按住并上下滑动：每 0.4 秒移动一层，回到起点附近暂停"
    className={className} style={{ cursor: "ns-resize", touchAction: "none", userSelect: "none" }}
    onClick={event => event.stopPropagation()}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopPropagation(); stop();
      event.currentTarget.focus({ preventScroll: true });
      gesture.current = { pointerId: event.pointerId, startY: event.clientY, direction: 0, timer: null };
      event.currentTarget.setPointerCapture(event.pointerId);
      setDirection(0);
    }}
    onPointerMove={event => {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      event.stopPropagation();
      if (!(event.buttons & 1)) { stop(); return; }
      const offset = event.clientY - current.startY;
      const next = offset <= -12 ? 1 : offset >= 12 ? -1 : 0;
      if (next === current.direction) return;
      if (current.timer != null) window.clearInterval(current.timer);
      current.timer = null;
      current.direction = next;
      setDirection(next);
      if (next) current.timer = window.setInterval(() => {
        window.dispatchEvent(new CustomEvent<CanvasLayerStepDetail>(CANVAS_LAYER_STEP_EVENT, {
          detail: { projectId, nodeIds, direction: next },
        }));
      }, 400);
    }}
    onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop}>
    <Layers size={14} className="shrink-0" />
    <span>调整层级{direction === 1 ? " · 上移 ↑" : direction === -1 ? " · 下移 ↓" : direction === 0 ? " · 上下滑动" : ""}</span>
  </button>;
}
