import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, CircleHelp, Coins, Star, UserRound } from "lucide-react";
import { OverlayScrollArea } from "../CollectionScrollArea";
import "./ModelSelect.css";

export type ModelSource = "personal" | "cloud";
export interface ModelOption {
  key: string;
  label: string;
  source: ModelSource;
  reason?: string;
}

function family(label: string): string {
  return label.toLowerCase().startsWith("gpt-image") ? "gpt" : label.toLowerCase().split(" ")[0];
}

export function ModelSelect({ value, label, source, options, onChange, defaultKey, onSetDefault, kind = "图像", quotaDetail, footer }: {
  value: string; label: string; source?: ModelSource; options: ModelOption[];
  onChange: (key: string) => void; defaultKey?: string; onSetDefault?: (key: string) => void;
  kind?: string; quotaDetail?: string; footer?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number; width: number; height: number }>();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const sourceLabel = source === "cloud" ? "Bowerbird 积分" : source === "personal" ? "自有订阅" : "来源待确认";
  const SourceIcon = source === "cloud" ? Coins : source === "personal" ? UserRound : CircleHelp;
  function close(restore = false) {
    setOpen(false);
    if (restore) trigger.current?.focus();
  }
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(448, window.innerWidth - 24);
      const above = rect.top - 20;
      const below = window.innerHeight - rect.bottom - 20;
      const up = above >= Math.min(280, below);
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), width,
        ...(up ? { bottom: window.innerHeight - rect.top + 8 } : { top: rect.bottom + 8 }), height: Math.max(60, up ? above : below) });
    }
    place();
    const frame = requestAnimationFrame(() => {
      const selected = menu.current?.querySelector<HTMLButtonElement>('[data-model-option][aria-pressed="true"]:not(:disabled)');
      (selected ?? menu.current?.querySelector<HTMLButtonElement>('[data-model-option]:not(:disabled)'))?.focus();
    });
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close();
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => { if (open && trigger.current?.matches(":disabled")) close(); });

  return <div className="provider-select model-select">
    <button ref={trigger} type="button" className="provider-choice model-select-trigger" data-source={source}
      title={kind === "图像" ? "选择出图引擎" : "选择视频模型"} aria-label={`${label} · ${sourceLabel}，选择${kind}模型`}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onKeyDown={event => { if (open && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); } }}
      onClick={() => setOpen(value => !value)}>
      <span className="model-select-source model-source-badge" title={quotaDetail ?? sourceLabel} aria-label={sourceLabel}><SourceIcon size={12} strokeWidth={2.8} aria-hidden="true" /></span>
      <span className="model-select-name">{label}</span>
      <ChevronDown size={12} aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={menu} id={id} role="dialog" aria-label={`${kind}模型`} className="app-popover model-select-menu"
      style={{ position: "fixed", left: position?.left, top: position?.top, bottom: position?.bottom, width: position?.width, visibility: position ? "visible" : "hidden" }}
      onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
        if (event.key === "Tab") { close(true); return; }
        if (!(event.target instanceof HTMLButtonElement) || !event.target.hasAttribute("data-model-option")) return;
        const column = event.target.closest(".model-select-column")!;
        const buttons = Array.from(column.querySelectorAll<HTMLButtonElement>("[data-model-option]:not(:disabled)"));
        const index = buttons.indexOf(event.target);
        let next: HTMLButtonElement | undefined;
        if (event.key === "ArrowDown") next = buttons[(index + 1) % buttons.length];
        if (event.key === "ArrowUp") next = buttons[(index - 1 + buttons.length) % buttons.length];
        if (event.key === "Home") next = buttons[0];
        if (event.key === "End") next = buttons[buttons.length - 1];
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          const other = event.key === "ArrowLeft" ? column.previousElementSibling : column.nextElementSibling;
          const others = Array.from(other?.querySelectorAll<HTMLButtonElement>("[data-model-option]:not(:disabled)") ?? []);
          next = others[Math.min(index, others.length - 1)];
        }
        if (next) { event.preventDefault(); event.stopPropagation(); next.focus(); next.scrollIntoView({ block: "nearest" }); }
      }}>
      <OverlayScrollArea label="模型列表滚动条" viewportStyle={{ maxHeight: position?.height }}>
        <div className="model-select-columns">{(["personal", "cloud"] as const).map(column => {
          const entries = options.filter(option => option.source === column);
          const families = [...new Set(entries.map(option => family(option.label)))];
          const ordered = families.flatMap(group => entries.filter(option => family(option.label) === group));
          const Icon = column === "cloud" ? Coins : UserRound;
          return <section key={column} className="model-select-column" data-source={column} aria-label={`${column === "cloud" ? "Bowerbird积分" : "自有订阅"}模型`}>
            <div className="model-select-column-title"><span className="model-source-badge"><Icon size={12} strokeWidth={2.8} aria-hidden="true" /></span>{column === "cloud" ? "Bowerbird 积分" : "自有订阅"}</div>
            <div className="model-select-options">{ordered.map(option => <div key={option.key} className="model-select-row">
              <button type="button" data-model-option data-model-key={option.key} className="model-select-option" disabled={!!option.reason}
                aria-pressed={value === option.key} title={option.reason ?? option.label}
                onClick={() => { onChange(option.key); close(true); }}>
                <span>{option.label}</span>{value === option.key && <Check size={13} aria-hidden="true" />}
              </button>
              {onSetDefault && <button type="button" className={`model-select-default${defaultKey === option.key ? " is-default" : ""}`}
                disabled={!!option.reason} aria-label={`${defaultKey === option.key ? "取消默认" : "设为默认"}：${option.label}`}
                onClick={() => onSetDefault(option.key)}><Star size={12} fill={defaultKey === option.key ? "currentColor" : "none"} aria-hidden="true" /></button>}
            </div>)}</div>
          </section>;
        })}</div>
        {footer && <div className="model-select-footer">{footer}</div>}
      </OverlayScrollArea>
    </div>, document.body)}
  </div>;
}
