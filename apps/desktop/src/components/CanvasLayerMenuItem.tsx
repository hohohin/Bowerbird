import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown, Layers } from "lucide-react";
import { CANVAS_LAYER_STEP_EVENT, type CanvasLayerStepDetail } from "../lib/canvasLayers";
import { ContextSubmenu } from "./ContextMenu";

/** Stay captured on the menu item while the pointer travels outside the menu. */
export function CanvasLayerMenuItem({ projectId, nodeIds, className, onClose, disabled = false }: {
  projectId: string; nodeIds: string[]; className: string; onClose: () => void; disabled?: boolean;
}) {
  const gesture = useRef<{ pointerId: number; startY: number; direction: -1 | 0 | 1; timer: number | null } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [direction, setDirection] = useState<-1 | 0 | 1 | null>(null);
  function step(direction: CanvasLayerStepDetail["direction"]) {
    window.dispatchEvent(new CustomEvent<CanvasLayerStepDetail>(CANVAS_LAYER_STEP_EVENT, { detail: { projectId, nodeIds, direction } }));
  }
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
  return <><button ref={button} type="button" role="menuitem" disabled={disabled}
    aria-label="调整层级" title="按住并上下滑动调整；键盘 Enter 上移一层，Shift+Enter 下移一层"
    className={className} style={{ cursor: "ns-resize", touchAction: "none", userSelect: "none" }}
    onClick={event => {
      event.stopPropagation();
      if (event.detail === 0) step(event.shiftKey ? -1 : 1);
    }}
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
      if (next) current.timer = window.setInterval(() => step(next), 400);
    }}
    onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop}>
    <Layers size={14} className="shrink-0" />
    <span>调整层级{direction === 1 ? " · 上移 ↑" : direction === -1 ? " · 下移 ↓" : direction === 0 ? " · 上下滑动" : ""}</span>
  </button>
    <ContextSubmenu label="层级操作" icon={<ChevronsUpDown size={13} aria-hidden="true" />} disabled={disabled}>
      <button type="button" role="menuitem" className={className} onClick={() => { step(1); onClose(); }}>
        <ArrowUp size={13} aria-hidden="true" />上移一层
      </button>
      <button type="button" role="menuitem" className={className} onClick={() => { step(-1); onClose(); }}>
        <ArrowDown size={13} aria-hidden="true" />下移一层
      </button>
    </ContextSubmenu>
  </>;
}
