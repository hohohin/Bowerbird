import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createPortal } from "react-dom";
import { userErrorMessage } from "../../lib/userError";
import { Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Coins, Monitor, Pin, Star, UserRound } from "lucide-react";
import { OverlayScrollArea } from "../CollectionScrollArea";
import "./ModelSelect.css";

import { usePortalTarget } from "../../lib/portalTarget";

export type ModelSource = "personal" | "cloud" | "local";
export interface ModelOption {
  key: string;
  label: string;
  source: ModelSource;
  group?: string;
  reason?: string;
}

const useFavorites = create<{ keys: string[]; toggle: (key: string) => void }>()(persist(set => ({
  keys: [],
  toggle: key => set(state => ({ keys: state.keys.includes(key) ? state.keys.filter(item => item !== key) : [...state.keys, key] })),
}), { name: "bowerbird.model-favorites.v1" }));

function family(label: string): string {
  return label.toLowerCase().startsWith("gpt-image") ? "gpt" : label.toLowerCase().split(" ")[0];
}

export function ModelSelect({ value, label, source, options, onChange, defaultKey, onSetDefault, kind = "图像", quotaDetail, cloudBalance, cloudLoggedIn, footer, menuClassName }: {
  value: string; label: string; source?: ModelSource; options: ModelOption[];
  onChange: (key: string) => void; defaultKey?: string; onSetDefault?: (key: string) => void;
  kind?: string; quotaDetail?: string; cloudBalance?: number | null; cloudLoggedIn?: boolean; footer?: ReactNode | ((close: () => void) => ReactNode); menuClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const favoriteKeys = useFavorites(state => open ? state.keys : null);
  const favoriteId = (option: ModelOption) => JSON.stringify([kind, option.source, option.key]);
  const favorites = favoriteKeys ? options.filter(option => favoriteKeys.includes(favoriteId(option))) : [];
  function favoriteButton(option: ModelOption) {
    const key = favoriteId(option);
    const saved = favoriteKeys?.includes(key) ?? false;
    const action = `${saved ? "取消收藏" : "收藏"}：${option.label}`;
    return <button type="button" className="model-select-favorite" aria-label={action} title={action} aria-pressed={saved}
      onClick={() => useFavorites.getState().toggle(key)}><Star size={13} fill={saved ? "currentColor" : "none"} aria-hidden /></button>;
  }
  const portalTarget = usePortalTarget();
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const groupSource = useRef("personal");
  const groupFocus = useRef<string | null>(null);
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
    setOpenGroup(null);
    groupFocus.current = null;
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
  function switchGroup(group: string, source = groupSource.current) {
    groupSource.current = source;
    groupFocus.current = group;
    setOpenGroup(current => current === group ? null : group);
  }
  useLayoutEffect(() => {
    if (!open || !groupFocus.current) return;
    const column = menu.current?.querySelector(`.model-select-column[data-source="${groupSource.current}"]`);
    const back = column?.querySelector<HTMLButtonElement>(`[data-model-group="${CSS.escape(groupFocus.current)}"]`);
    const selected = column?.querySelector<HTMLButtonElement>('[data-model-key][aria-pressed=true]:not(:disabled)');
    const first = column?.querySelector<HTMLButtonElement>('[data-model-key]:not(:disabled)');
    (openGroup ? selected ?? first ?? back : back)?.focus();
    groupFocus.current = null;
  }, [open, openGroup]);
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
      onClick={() => open ? close() : setOpen(true)}>
      <span className="model-select-source model-source-badge" title={quotaDetail ?? sourceLabel} aria-label={sourceLabel}><SourceIcon size={12} strokeWidth={2.8} aria-hidden="true" /></span>
      <span className="model-select-name">{label}</span>
      <ChevronDown size={12} aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={menu} id={id} role="dialog" aria-label={`${kind}模型`} className={`app-popover model-select-menu${menuClassName ? ` ${menuClassName}` : ""}`}
      style={{ position: "fixed", left: position?.left, top: position?.top, bottom: position?.bottom, width: position?.width, visibility: position ? "visible" : "hidden" }}
      onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (openGroup) switchGroup(openGroup); else close(true); return; }
        if (event.key === "Tab") {
          const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
          if (event.target === buttons[event.shiftKey ? 0 : buttons.length - 1]) close(true);
          return;
        }
        if (!(event.target instanceof HTMLButtonElement) || !event.target.hasAttribute("data-model-option")) return;
        const column = event.target.closest(".model-select-column");
        const localButton = menu.current?.querySelector<HTMLButtonElement>('.model-select-local:not(:disabled)');
        if (!column) {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); event.stopPropagation(); menu.current?.querySelector<HTMLButtonElement>('.model-select-column [data-model-option]:not(:disabled)')?.focus(); }
          return;
        }
        const group = event.target.dataset.modelGroup;
        if ((event.key === "ArrowRight" && group && (openGroup !== group || column.getAttribute("data-source") !== groupSource.current)) || (event.key === "ArrowLeft" && openGroup && column.getAttribute("data-source") === groupSource.current)) {
          event.preventDefault(); event.stopPropagation(); switchGroup((group ?? openGroup)!, column.getAttribute("data-source")!); return;
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
        {favorites.length > 0 && <section className="model-select-favorites" aria-label="收藏的模型">
          <strong>收藏</strong>{favorites.map(option => <button type="button" key={option.key} disabled={!!option.reason}
            title={option.reason ? userErrorMessage(option.reason, "此模型暂不可用") : option.label}
            onClick={() => { onChange(option.key); close(true); }}>
            {option.source === "cloud" ? <Coins size={12} /> : option.source === "personal" ? <UserRound size={12} /> : <Monitor size={12} />}{option.label}
          </button>)}
        </section>}
        <div className="model-select-columns">{(["personal", "cloud"] as const).map(column => {
          const columnOptions = options.filter(option => option.source === column);
          const groups = [...new Set(columnOptions.flatMap(option => option.group ? [option.group] : []))];
          const activeGroup = column === groupSource.current ? openGroup : null;
          const entries = columnOptions.filter(option => (option.group ?? null) === activeGroup);
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
            <div className="model-select-options">
              {activeGroup && <button type="button" className="model-select-option model-select-group" data-model-option data-model-group={activeGroup}
                aria-label={column === "personal" ? "返回自有订阅" : "返回 Bowerbird Bcoin"} onClick={() => switchGroup(activeGroup)}><ChevronLeft size={13} />{activeGroup}</button>}
              {ordered.map(option => <div key={option.key} className="model-select-row">
              <button type="button" data-model-option data-model-key={option.key} className="model-select-option" disabled={!!option.reason}
                aria-pressed={value === option.key} title={option.reason ? userErrorMessage(option.reason, "此模型暂不可用，请检查账号和服务状态。") : option.label}
                onClick={() => { onChange(option.key); close(true); }}>
                <span>{option.label}</span>{value === option.key && <Check size={13} aria-hidden="true" />}
              </button>
              {favoriteButton(option)}
              {onSetDefault && <button type="button" className={`model-select-default${defaultKey === option.key ? " is-default" : ""}`}
                disabled={!!option.reason} aria-label={`${defaultKey === option.key ? "取消默认" : "设为默认"}：${option.label}`}
                onClick={() => onSetDefault(option.key)}><Pin size={12} fill={defaultKey === option.key ? "currentColor" : "none"} aria-hidden="true" /></button>}
            </div>)}
              {!activeGroup && groups.map(group => <button key={group} type="button" className="model-select-option model-select-group" data-model-option data-model-group={group}
                aria-pressed={columnOptions.some(option => option.group === group && option.key === value)} onClick={() => switchGroup(group, column)}><span>{group}</span><ChevronRight size={13} /></button>)}
            </div>
          </section>;
        })}</div>
        {localOption && <div className="model-select-local-row" data-source="local"><button type="button" className="model-select-local" data-model-option data-model-key={localOption.key} aria-pressed={value === localOption.key}
          disabled={!!localOption.reason} title={localOption.reason ? userErrorMessage(localOption.reason, "本地模型暂不可用，请检查账号和本机环境。") : "本地部署，不消耗积分"} onClick={() => { onChange(localOption.key); close(true); }}>
          <span className="model-source-badge"><Monitor size={12} strokeWidth={2.8} aria-hidden="true" /></span><span>本地部署</span><small>{localOption.label.replace("本地部署 · ", "")}</small>{value === localOption.key && <Check size={13} aria-hidden="true" />}
        </button>{favoriteButton(localOption)}{onSetDefault && <button type="button" className={`model-select-default${defaultKey === localOption.key ? " is-default" : ""}`}
          disabled={!!localOption.reason} aria-label={`${defaultKey === localOption.key ? "取消默认" : "设为默认"}：${localOption.label}`}
          onClick={() => onSetDefault(localOption.key)}><Pin size={12} fill={defaultKey === localOption.key ? "currentColor" : "none"} aria-hidden="true" /></button>}</div>}
        {kind === "图像" && <div className="model-select-footer">Cloud 按张计费；第 2 张起每增加一张参考图，每张输出加 1 Bcoin。</div>}
        {footer && <div className="model-select-footer">{typeof footer === "function" ? footer(() => close(true)) : footer}</div>}
      </OverlayScrollArea>
    </div>, portalTarget)}
  </div>;
}
