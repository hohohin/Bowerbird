import { useEffect, useRef, type RefObject } from "react";
import { Check, Loader2, RefreshCw, X } from "lucide-react";
import { FILE_COLORS, type useFileColors } from "../lib/useFileColors";

/** Shared downward color picker for file-backed library views. */
export function FileColorFilter({ open, onOpenChange, color, onColorChange, palette, triggerRef }: {
  open: boolean; onOpenChange: (open: boolean) => void;
  color: string | null; onColorChange: (color: string | null) => void;
  palette: ReturnType<typeof useFileColors>; triggerRef?: RefObject<HTMLButtonElement>;
}) {
  const root = useRef<HTMLDivElement>(null);
  const ownTrigger = useRef<HTMLButtonElement>(null);
  const trigger = triggerRef ?? ownTrigger;
  function close() { onOpenChange(false); trigger.current?.focus({ preventScroll: true }); }
  useEffect(() => {
    if (open) root.current?.querySelector<HTMLButtonElement>('[role="dialog"] button')?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) onOpenChange(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); close();
    };
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", dismiss); window.removeEventListener("keydown", escape, true); };
  }, [open, onOpenChange, trigger]);
  return <div ref={root} className={`library-color-control library-color-dropdown library-floating-surface${open ? " is-open" : ""}`}>
    <button ref={trigger} className="library-filter-trigger" aria-label="颜色筛选" title="颜色筛选" data-active={!!color || undefined}
      aria-expanded={open} aria-haspopup="dialog" onClick={() => onOpenChange(!open)}>
      <span className="library-rgb-orb" aria-hidden="true"/>{color && <span className="library-filter-dot"/>}
    </button>
    {open && <div className="library-color-strip library-floating-surface" role="dialog" aria-label="颜色筛选"
      onBlur={event => { if (event.relatedTarget && !root.current?.contains(event.relatedTarget as Node)) onOpenChange(false); }}
      onKeyDown={event => {
        if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
          event.preventDefault(); event.stopPropagation();
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        }
      }}>
      <div className="library-filter-colors">{FILE_COLORS.map(([key, label, hex]) => <button key={key} aria-label={label} aria-pressed={color === key}
        title={label} style={{ background: hex }} onClick={() => onColorChange(color === key ? null : key)}>{color === key && <Check size={10}/>}</button>)}</div>
      {palette.pending && <span className="library-filter-notice" role="status" aria-label="正在读取颜色" title="正在读取颜色…"><Loader2 size={12} className="animate-spin"/></span>}
      {!!palette.failed && <button className="library-color-action" aria-label={`${palette.failed} 项读取失败 · 重试`} title={`${palette.failed} 项读取失败 · 重试`} onClick={palette.retry}><RefreshCw size={12}/></button>}
      {color && <button className="library-color-action" aria-label="清除颜色筛选" title="清除颜色筛选" onClick={() => onColorChange(null)}><X size={12}/></button>}
    </div>}
  </div>;
}
