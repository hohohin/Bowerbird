import { forwardRef, type HTMLAttributes } from "react";
import { GripVertical, X } from "lucide-react";

/** Shared library/exploration edge tab; each panel owns its width and persistence. */
export const PanelEdgeHandle = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & {
  collapsed?: boolean;
  variant?: "tab" | "overlay";
  side?: "left" | "right";
  closeLabel: string;
  revealLabel?: string;
  onClose: () => void;
  onEscape?: () => void;
  grip?: HTMLAttributes<HTMLDivElement>;
}>(function PanelEdgeHandle({ collapsed, variant = "tab", side = "right", closeLabel, revealLabel, onClose, onEscape, grip, className = "", ...props }, ref) {
  const overlay = variant === "overlay", cut = 4;
  return <div {...props} ref={ref} className={`canvas-library-resize ${className}`} aria-hidden={collapsed} data-reveal={!!revealLabel || undefined} onKeyDown={event => {
    if (event.key === "Escape" && onEscape) { event.preventDefault(); event.stopPropagation(); onEscape(); }
  }}>
    <svg className="canvas-library-tab-shape" viewBox={overlay ? "0 0 14.4 76" : "0 0 32 96"} data-overlay-cut={overlay ? cut : undefined} data-overlay-side={overlay ? side : undefined} preserveAspectRatio="none" aria-hidden="true">
      <g transform={overlay && side === "left" ? "translate(14.4 0) scale(-1 1)" : undefined}>
        <path className="canvas-library-tab-fill" d={overlay ? `M${cut} 0H14.4V76H${cut}L0 ${76-cut}V${cut}Z` : "M0 0H20Q32 0 32 12V74Q32 86 20 86H18C12 86 8 88 8 96H0Z"} />
        <path className="canvas-library-tab-edge" d={overlay ? `M14.4 .5H${cut+.2}L.5 ${cut+.2}V${76-cut-.2}L${cut+.2} 75.5H14.4` : "M8 0H20Q32 0 32 12V74Q32 86 20 86H18C12 86 8 88 8 96"} />
      </g>
    </svg>
    <button type="button" className="canvas-library-close" aria-label={closeLabel} title={onEscape ? `${closeLabel} · Esc` : closeLabel}
      aria-keyshortcuts={onEscape ? "Escape" : undefined} tabIndex={collapsed ? -1 : 0} onClick={onClose}>
      {revealLabel || <>{!overlay && <span className="canvas-library-close-hint" aria-hidden="true">ESC</span>}<X size={13} aria-hidden="true" /></>}
    </button>
    {grip && <div {...grip} className="canvas-library-grip" role="separator" tabIndex={collapsed ? -1 : 0} aria-orientation="vertical">
      <GripVertical size={15} aria-hidden="true" />
    </div>}
  </div>;
});
