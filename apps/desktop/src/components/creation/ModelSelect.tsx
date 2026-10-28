import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { userErrorMessage } from "../../lib/userError";
import { Check, ChevronDown, CircleHelp, Coins, Monitor, Star, UserRound } from "lucide-react";
import { OverlayScrollArea } from "../CollectionScrollArea";
import "./ModelSelect.css";
import { useStore } from "../../store";

export type ModelSource = "personal" | "cloud" | "local";
export interface ModelOption {
  key: string;
  label: string;
  source: ModelSource;
  reason?: string;
}

function family(label: string): string {
  return label.toLowerCase().startsWith("gpt-image") ? "gpt" : label.toLowerCase().split(" ")[0];
}

export function ModelSelect({ value, label, source, options, onChange, defaultKey, onSetDefault, kind = "图像", quotaDetail, cloudBalance, cloudLoggedIn, footer, menuClassName }: {
  value: string; label: string; source?: ModelSource; options: ModelOption[];
  onChange: (key: string) => void; defaultKey?: string; onSetDefault?: (key: string) => void;
  kind?: string; quotaDetail?: string; cloudBalance?: number | null; cloudLoggedIn?: boolean; footer?: ReactNode; menuClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const prices = useStore(state => state.cloudEntitlement?.generation_services);
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number; width: number; height: number }>();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const sourceLabel = source === "cloud" ? "Bowerbird Bcoin" : source === "personal" ? "自有订阅" : source === "local" ? "本地部署，不扣积分" : "来源待确认";
  const SourceIcon = source === "cloud" ? Coins : source === "personal" ? UserRound : source === "local" ? Monitor : CircleHelp;
  const localOption = options.find(option => option.source === "local");
  const balanceLabel = !cloudLoggedIn ? "登录后查看 Bowerbird Bcoin" : cloudBalance == null ? "Bowerbird Bcoin余额暂不可用" : `Bowerbird 可用 Bcoin：${cloudBalance.toLocaleString("zh-CN")}`;
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
      title={kind === "图像" ? "选择出图引擎" : `选择${kind}模型`} aria-label={`${label} · ${sourceLabel}，选择${kind}模型`}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onKeyDown={event => { if (open && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); } }}
      onClick={() => setOpen(value => !value)}>
      <span className="model-select-source model-source-badge" title={quotaDetail ?? sourceLabel} aria-label={sourceLabel}><SourceIcon size={12} strokeWidth={2.8} aria-hidden="true" /></span>
      <span className="model-select-name">{label}</span>
      <ChevronDown size={12} aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={menu} id={id} role="dialog" aria-label={`${kind}模型`} className={`app-popover model-select-menu${menuClassName ? ` ${menuClassName}` : ""}`}
      style={{ position: "fixed", left: position?.left, top: position?.top, bottom: position?.bottom, width: position?.width, visibility: position ? "visible" : "hidden" }}
      onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
        if (event.key === "Tab") { close(true); return; }
        if (!(event.target instanceof HTMLButtonElement) || !event.target.hasAttribute("data-model-option")) return;
        const column = event.target.closest(".model-select-column");
        const localButton = menu.current?.querySelector<HTMLButtonElement>('.model-select-local:not(:disabled)');
        if (!column) {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); event.stopPropagation(); menu.current?.querySelector<HTMLButtonElement>('.model-select-column [data-model-option]:not(:disabled)')?.focus(); }
          return;
        }
        const buttons = Array.from(column.querySelectorAll<HTMLButtonElement>("[data-model-option]:not(:disabled)"));
        const index = buttons.indexOf(event.target);
        let next: HTMLButtonElement | undefined;
        if (event.key === "ArrowDown") next = index === buttons.length - 1 && localButton ? localButton : buttons[(index + 1) % buttons.length];
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
          return <section key={column} className="model-select-column" data-source={column} aria-label={`${column === "cloud" ? "Bowerbird Bcoin" : "自有订阅"}模型`}>
            <div className="model-select-column-heading">
              <div className="model-select-column-title"><span className="model-source-badge"><Icon size={12} strokeWidth={2.8} aria-hidden="true" /></span><span className="model-select-column-label">{column === "cloud" ? "Bowerbird Bcoin" : "自有订阅"}</span></div>
              {column === "cloud" && <div className="model-select-balance" role="status" aria-label={balanceLabel} title={balanceLabel}>
                <Coins size={13} aria-hidden="true" /><strong>{cloudLoggedIn && cloudBalance != null ? cloudBalance.toLocaleString("zh-CN") : "—"}</strong>
              </div>}
            </div>
            <div className="model-select-options">{ordered.map(option => <div key={option.key} className="model-select-row">
              <button type="button" data-model-option data-model-key={option.key} className="model-select-option" disabled={!!option.reason}
                aria-pressed={value === option.key} title={option.reason ? userErrorMessage(option.reason, "此模型暂不可用，请检查账号和服务状态。") : option.label}
                onClick={() => { onChange(option.key); close(true); }}>
                <span>{option.label}{option.source === "cloud" && prices?.some(price => option.key === `bowerbird-cloud-${price.service}`) && <small> · {prices.find(price => option.key === `bowerbird-cloud-${price.service}`)!.credits} Bcoin 起</small>}</span>{value === option.key && <Check size={13} aria-hidden="true" />}
              </button>
              {onSetDefault && <button type="button" className={`model-select-default${defaultKey === option.key ? " is-default" : ""}`}
                disabled={!!option.reason} aria-label={`${defaultKey === option.key ? "取消默认" : "设为默认"}：${option.label}`}
                onClick={() => onSetDefault(option.key)}><Star size={12} fill={defaultKey === option.key ? "currentColor" : "none"} aria-hidden="true" /></button>}
            </div>)}</div>
          </section>;
        })}</div>
        {localOption && <div className="model-select-local-row" data-source="local"><button type="button" className="model-select-local" data-model-option data-model-key={localOption.key} aria-pressed={value === localOption.key}
          disabled={!!localOption.reason} title={localOption.reason ? userErrorMessage(localOption.reason, "本地视频暂不可用，请检查账号和本机环境。") : "本地 H3 视频，不消耗积分"} onClick={() => { onChange(localOption.key); close(true); }}>
          <span className="model-source-badge"><Monitor size={12} strokeWidth={2.8} aria-hidden="true" /></span><span>本地部署</span><small>H3</small><span className="model-local-cost"><Coins size={12} aria-hidden="true" />0</span>{value === localOption.key && <Check size={13} aria-hidden="true" />}
        </button></div>}
        {kind === "图像" && <div className="model-select-footer">Cloud 按张计费；第 2 张起每增加一张参考图，每张输出加 1 Bcoin。</div>}
        {footer && <div className="model-select-footer">{footer}</div>}
      </OverlayScrollArea>
    </div>, document.body)}
  </div>;
}
