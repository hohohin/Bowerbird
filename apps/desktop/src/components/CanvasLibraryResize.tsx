import { useLayoutEffect, useRef, useState } from "react";
import { GripVertical, X } from "lucide-react";

const widthKey = "bowerbird.canvasLibraryWidth";

/** Resize only the material panel; the canvas keeps its viewport and camera. */
export function CanvasLibraryResize({ panelId, collapsed, onClose }: { panelId: string; collapsed: boolean; onClose: () => void }) {
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; x: number; width: number } | null>(null);
  const [preferredWidth, setPreferredWidth] = useState<number | null>(() => {
    try { const raw = localStorage.getItem(widthKey), saved = Number(raw); return raw !== null && Number.isFinite(saved) && saved >= 0 ? saved : null; }
    catch { return null; }
  });
  const [maximum, setMaximum] = useState(480);
  const [requiredWidth, setRequiredWidth] = useState(480);
  const [dragging, setDragging] = useState(false);
  const minimum = Math.min(requiredWidth, maximum);
  const width = Math.min(maximum, Math.max(minimum, preferredWidth ?? maximum));

  useLayoutEffect(() => {
    const workspace = handle.current?.closest<HTMLElement>(".canvas-workspace");
    if (!workspace) return;
    const measure = () => {
      // Read the resolved gap, including clamp() at narrow window widths.
      const panel = document.getElementById(panelId)!;
      const bottom = parseFloat(getComputedStyle(panel).bottom);
      const outsideSpace = Math.max(bottom, handle.current!.offsetWidth + 4);
      setMaximum(Math.max(0, workspace.clientWidth - outsideSpace));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    measure();
    return () => { observer.disconnect(); workspace.style.removeProperty("--canvas-source-width"); };
  }, [panelId]);

  useLayoutEffect(() => {
    const panel = document.getElementById(panelId)!;
    let frame = 0;
    let observedSidebar: HTMLElement | null = null;
    const measure = () => {
      frame = 0;
      const sidebar = panel.querySelector<HTMLElement>(".catalog-sidebar, .file-browser-places");
      const navigation = panel.querySelector<HTMLElement>(".library-view-switch");
      if (!sidebar || !navigation) return;
      if (sidebar !== observedSidebar) {
        if (observedSidebar) observer.unobserve(observedSidebar);
        observer.observe(sidebar); observedSidebar = sidebar;
      }
      // Reserve a stable title slot. Long names truncate within the available space
      // instead of widening the drawer after each catalog/title finishes loading.
      const titleWidth = 64;
      // Centered navigation needs equal clearance on each side: title on the left,
      // one 28px overflow control on the right, with 16px inset and 8px gap.
      setRequiredWidth(Math.ceil(sidebar.getBoundingClientRect().width + navigation.getBoundingClientRect().width + 2 * (Math.max(titleWidth, 28) + 24) + 16));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule); observer.observe(panel);
    const changes = new MutationObserver(schedule);
    changes.observe(panel, { childList:true, subtree:true, characterData:true });
    schedule();
    return () => { observer.disconnect(); changes.disconnect(); cancelAnimationFrame(frame); };
  }, [panelId]);

  useLayoutEffect(() => {
    const workspace = handle.current?.closest<HTMLElement>(".canvas-workspace");
    workspace?.style.setProperty("--canvas-source-width", `${width}px`);
    workspace?.classList.toggle("is-library-resizing", dragging);
    return () => { workspace?.classList.remove("is-library-resizing"); };
  }, [width, dragging]);

  function resize(next: number | null) {
    const value = next === null ? null : Math.min(maximum, Math.max(0, next));
    setPreferredWidth(value);
    try { if (value === null) localStorage.removeItem(widthKey); else localStorage.setItem(widthKey, String(value)); }
    catch { /* Keep the session width when browser storage is unavailable. */ }
  }
  function finish() { drag.current = null; setDragging(false); }

  return <div ref={handle} className="canvas-library-resize" aria-hidden={collapsed}>
    <svg className="canvas-library-tab-shape" viewBox="0 0 32 96" aria-hidden="true">
      <path className="canvas-library-tab-fill" d="M0 0H20Q32 0 32 12V74Q32 86 20 86H18C12 86 8 88 8 96H0Z" />
      <path className="canvas-library-tab-edge" d="M8 0H20Q32 0 32 12V74Q32 86 20 86H18C12 86 8 88 8 96" />
    </svg>
    <button type="button" className="canvas-library-close" aria-label="关闭素材库" title="关闭素材库 · Esc"
      aria-keyshortcuts="Escape" tabIndex={collapsed ? -1 : 0} onClick={onClose}>
      <span className="canvas-library-close-hint" aria-hidden="true">ESC</span><X size={13} aria-hidden="true" />
    </button>
    <div className="canvas-library-grip" role="separator" tabIndex={collapsed ? -1 : 0}
    aria-label="调整素材库宽度" aria-orientation="vertical" aria-controls={panelId}
    aria-valuemin={Math.round(minimum)} aria-valuemax={Math.round(maximum)} aria-valuenow={Math.round(width)}
    aria-valuetext={`${Math.round(width)} 像素`}
    title="拖动调整素材库宽度 · 左右方向键微调 · 双击恢复最大宽度"
    onPointerDown={event => {
      if (event.button !== 0 || drag.current) return;
      event.preventDefault(); event.stopPropagation();
      event.currentTarget.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointer: event.pointerId, x: event.clientX, width };
      setDragging(true);
    }}
    onPointerMove={event => {
      const start = drag.current;
      if (start?.pointer === event.pointerId) resize(start.width + event.clientX - start.x);
    }}
    onPointerUp={event => {
      if (drag.current?.pointer !== event.pointerId) return;
      finish(); event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onPointerCancel={finish} onLostPointerCapture={finish}
    onDoubleClick={() => resize(null)}
    onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === "End") resize(null);
      else resize(event.key === "Home" ? 0 : width + (event.key === "ArrowLeft" ? -32 : 32));
    }}><GripVertical size={15} aria-hidden="true" /></div>
  </div>;
}
