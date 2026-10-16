import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BriefcaseBusiness, Clapperboard } from "lucide-react";
import "./CanvasToolbox.css";

export function CanvasToolbox({ onOpenReplication }: { onOpenReplication: () => void }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = button.current?.getBoundingClientRect();
      if (rect) setPosition({ left: Math.min(rect.right + 12, window.innerWidth - 240), top: Math.max(12, Math.min(rect.top - 8, window.innerHeight - 110)) });
    };
    place();
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", outside);
    return () => window.removeEventListener("pointerdown", outside);
  }, [open]);

  return <div className="canvas-assist-tools" role="group" aria-label="工具">
    <span>工具</span>
    <button ref={button} type="button" data-tip={open ? undefined : "工具箱"} aria-label="工具箱" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={() => setOpen(value => !value)} onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); } }}><BriefcaseBusiness size={18} /></button>
    {open && createPortal(<div ref={menu} id={menuId} className="canvas-toolbox-menu" role="menu" aria-label="工具箱" style={position}
      onPointerDown={event => event.stopPropagation()} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); button.current?.focus(); }
        if (event.key === "Tab") setOpen(false);
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); menu.current?.querySelector<HTMLButtonElement>("button")?.focus(); }
      }}>
      <div className="canvas-toolbox-heading">工具箱</div>
      <button type="button" role="menuitem" onClick={() => { setOpen(false); onOpenReplication(); }}>
        <Clapperboard size={19} aria-hidden="true" /><span><strong>视频复刻工具</strong><small>分析参考 · 改写分镜 · 生成视频</small></span>
      </button>
    </div>, document.body)}
  </div>;
}
