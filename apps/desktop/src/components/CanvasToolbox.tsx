import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BriefcaseBusiness, Clapperboard, Images, Film } from "lucide-react";
import { useStore } from "../store";
import { notify } from "../lib/notify";
import { canUseComfyVideo } from "../lib/comfyVideo";
import "./CanvasToolbox.css";

export function CanvasToolbox({ onOpenReplication, onOpenLocalVideo }: { onOpenReplication: () => void; onOpenLocalVideo: () => void }) {
  const isTestAccount = useStore(state => state.cloudAuth?.logged_in === true && !!state.cloudAuth.user_id
    && state.cloudEntitlement?.user_id === state.cloudAuth.user_id && state.cloudEntitlement?.is_test_account === true);
  const canUseLocalVideo = useStore(state => canUseComfyVideo(state.cloudAuth, state.cloudEntitlement));
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = button.current?.getBoundingClientRect();
      if (rect) setPosition({ left: Math.min(rect.right + 12, window.innerWidth - 240), top: Math.max(12, Math.min(rect.top - 8, window.innerHeight - (menu.current?.offsetHeight ?? 98) - 12)) });
    };
    place();
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, isTestAccount, canUseLocalVideo]);

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
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? []);
          const index = items.findIndex(item => item === document.activeElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }
      }}>
      <div className="canvas-toolbox-heading">工具箱</div>
      <button type="button" role="menuitem" onClick={() => { setOpen(false); onOpenReplication(); }}>
        <Clapperboard size={19} aria-hidden="true" /><span><strong>视频复刻工具</strong><small>分析参考 · 改写分镜 · 生成视频</small></span>
      </button>
      {isTestAccount && <button type="button" role="menuitem" onClick={() => { setOpen(false); button.current?.focus(); notify("功能开发中"); }}>
        <Images size={19} aria-hidden="true" /><span><strong>视频转图文</strong><small>功能开发中</small></span>
      </button>}
      {canUseLocalVideo && <button type="button" role="menuitem" onClick={() => { setOpen(false); onOpenLocalVideo(); }}>
        <Film size={19} aria-hidden="true" /><span><strong>本地 H3 视频</strong><small>首尾帧 · 提示词 · 生成视频</small></span>
      </button>}
    </div>, document.body)}
  </div>;
}
