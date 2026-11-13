import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ImageIcon } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { canvasAssetMediaPath } from "../lib/creativeCanvas";
import type { WorkflowLoopItem } from "../lib/canvasWorkflow";
import type { Asset } from "../lib/types";
import { contentTableRows } from "../lib/contentTable";

export const loopItemDescription = (item: WorkflowLoopItem, assets: Asset[]) =>
  (item.table ? contentTableRows(item.table).map(row => row.filter(Boolean).join(" · ")).join(" / ").trim() : item.text.trim())
  || item.assetIds.map(id => assets.find(asset => asset.id === id)?.name || "图片").join("、");

export function WorkflowLoopStartSelect({ id, items, assets, value, disabled, notice, rounds, onChange }: {
  id: string; items: WorkflowLoopItem[]; assets: Asset[]; value: number; disabled: boolean; notice: string;
  rounds?: boolean;
  onChange: (value: number) => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const selected = items[value - 1];
  const description = (item: WorkflowLoopItem) => loopItemDescription(item, assets);
  const unit = rounds ? "轮" : "项";
  const imageSrc = (id: string) => {
    const asset = assets.find(asset => asset.id === id);
    const path = asset && canvasAssetMediaPath({ thumbPath: asset.thumb_path ?? null, storePath: asset.store_path ?? null });
    return path ? path.startsWith("data:") ? path : convertFileSrc(path) : "";
  };
  const preview = (item: WorkflowLoopItem) => <>
    {!!item.assetIds.length && <span className="workflow-loop-thumbs">{item.assetIds.slice(0, 3).map((id, index) => imageSrc(id)
      ? <img key={`${id}-${index}`} src={imageSrc(id)} alt={assets.find(asset => asset.id === id)?.name || "图片"} />
      : <ImageIcon key={`${id}-${index}`} size={24} aria-hidden="true" />)}{item.assetIds.length > 3 && <small>+{item.assetIds.length - 3}</small>}</span>}
    <span className="workflow-loop-item-text">{description(item)}</span>
  </>;
  const close = (restoreFocus = false) => { setOpen(false); if (restoreFocus) anchor.current?.focus({ preventScroll: true }); };
  useEffect(() => { if (disabled || !items.length) setOpen(false); }, [disabled, items.length]);
  useLayoutEffect(() => {
    if (!open || disabled || !items.length) return;
    const rect = anchor.current!.getBoundingClientRect(), popup = menu.current!.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - popup.width - 8)),
      top: Math.max(8, Math.min(rect.bottom + 6 + popup.height <= window.innerHeight - 8 ? rect.bottom + 6 : rect.top - popup.height - 6, window.innerHeight - popup.height - 8)) });
    const option = menu.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]') ?? menu.current?.querySelector<HTMLButtonElement>("button");
    option?.focus({ preventScroll: true }); option?.scrollIntoView({ block: "nearest" });
  }, [open, disabled, items.length, value]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) setOpen(false); };
    const close = () => setOpen(false);
    const wheel = (event: WheelEvent) => { if (!menu.current?.contains(event.target as Node)) close(); };
    window.addEventListener("pointerdown", outside, true); window.addEventListener("wheel", wheel, true);
    window.addEventListener("resize", close); window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", outside, true); window.removeEventListener("wheel", wheel, true);
      window.removeEventListener("resize", close); window.removeEventListener("blur", close);
    };
  }, [open]);
  return <div className="workflow-loop-start">
    <div className="loop-field-label"><span>从哪里开始</span>{!!items.length && <small>共 {items.length} {unit}</small>}</div>
    <button ref={anchor} className="tactical-menu-trigger" type="button" aria-label="循环起始项" aria-describedby={`loop-start-value-${id}`} aria-haspopup="listbox" aria-expanded={open && !disabled && !!items.length} aria-controls={open ? `loop-start-${id}` : undefined}
      disabled={disabled || !items.length} onClick={() => setOpen(!open)} onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); }
      }}>
      <span id={`loop-start-value-${id}`}>{selected ? `第 ${value} ${unit}` : items.length ? "选择起始项" : "等待输入"}</span>
      {selected && !rounds && preview(selected)}{!!items.length && !disabled && <ChevronDown size={14} aria-hidden="true" />}
    </button>
    {!items.length && <small className="loop-note">{notice || "连接输入后可选择起始项"}</small>}
    {open && !disabled && !!items.length && createPortal(<div ref={menu} id={`loop-start-${id}`} className="workflow-loop-menu app-popover" role="listbox" aria-label="选择循环起始项" style={position}
      onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onKeyDown={event => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); close(true); }
        if (event.key === "Tab") close(true);
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const buttons = Array.from(menu.current!.querySelectorAll<HTMLButtonElement>("button"));
          const index = buttons.indexOf(window.document.activeElement as HTMLButtonElement);
          buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
        }
      }}>
      <strong>从哪里开始 · 共 {items.length} {unit}</strong>
      {items.map((item, index) => <button key={index} type="button" role="option" aria-selected={value === index + 1} title={description(item)} onClick={() => { onChange(index + 1); close(true); }}>
        <span className="workflow-loop-item-number">第 {index + 1} {unit}</span>{!rounds && preview(item)}{value === index + 1 && <Check size={14} aria-hidden="true" />}
      </button>)}
    </div>, window.document.body)}
  </div>;
}
