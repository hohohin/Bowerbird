import { useEffect, useRef, useState, type CSSProperties } from "react";

export function LibraryViewSwitch({ value, options, onChange, label, onReorder }: {
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  label: string;
  onReorder?: (values: string[]) => void;
}) {
  const [dragged, setDragged] = useState<string | null>(null);
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number; active: boolean; order: string[] } | null>(null);
  const suppressClick = useRef(false);
  function cancel() {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null; setDragged(null);
  }
  useEffect(() => {
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape" || !press.current?.active) return;
      event.preventDefault(); event.stopImmediatePropagation(); cancel();
    }
    window.addEventListener("keydown", escape, true);
    window.addEventListener("blur", cancel);
    return () => { window.removeEventListener("keydown", escape, true); window.removeEventListener("blur", cancel); if (press.current) clearTimeout(press.current.timer); };
  }, []);
  const index = Math.max(0, options.findIndex(option => option.value === value));
  return <div className="library-view-switch" data-reorderable={!!onReorder || undefined} data-dragging={!!dragged || undefined} role="tablist" aria-label={label}
    style={{ "--switch-index": index, "--switch-count": options.length } as CSSProperties}>
    <span className="library-view-switch-thumb" aria-hidden="true" />
    {options.map((option, i) => <button key={option.value} type="button" role="tab"
      data-tab-value={option.value} data-dragged={dragged === option.value || undefined}
      title={onReorder ? "点击切换；长按拖动排序（Alt + 左右键也可排序）" : undefined}
      onPointerDown={event => {
        if (!onReorder || event.button !== 0) return;
        cancel(); suppressClick.current = false;
        const button = event.currentTarget;
        const pointerId = event.pointerId;
        button.setPointerCapture(pointerId);
        press.current = { x: event.clientX, y: event.clientY, active: false, order: options.map(item => item.value),
          timer: setTimeout(() => {
            if (!press.current) return;
            press.current.active = true; suppressClick.current = true;
            setDragged(option.value);
          }, 320) };
      }}
      onPointerMove={event => {
        const current = press.current;
        if (!current) return;
        if (!current.active) {
          if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > 6) { suppressClick.current = true; cancel(); }
          return;
        }
        event.preventDefault();
        const rect = event.currentTarget.parentElement!.getBoundingClientRect();
        const target = Math.max(0, Math.min(options.length - 1, Math.floor((event.clientX - rect.left) / (rect.width / options.length))));
        const next = [...current.order]; const from = next.indexOf(option.value);
        if (from === target) return;
        next.splice(from, 1); next.splice(target, 0, option.value);
        current.order = next; onReorder?.(next);
      }}
      onPointerUp={() => cancel()} onPointerCancel={() => cancel()}
      onLostPointerCapture={() => cancel()}
      onContextMenu={event => { if (press.current?.active) event.preventDefault(); }}
      aria-selected={value === option.value} tabIndex={index === i ? 0 : -1}
      onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } onChange(option.value); }} onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
          : (i + (event.key === "ArrowRight" ? 1 : -1) + options.length) % options.length;
        if (event.altKey && onReorder && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
          const values = options.map(item => item.value);
          values.splice(i, 1); values.splice(next, 0, option.value); onReorder(values); return;
        }
        onChange(options[next].value);
        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
      }}>{option.label}</button>)}
  </div>;
}
