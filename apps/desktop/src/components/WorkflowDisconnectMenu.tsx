import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface DisconnectChoice { key: string; label: string; detail: string; disabled: boolean; disconnect: () => void }
export function WorkflowDisconnectMenu({ x, y, choices, onClose }: { x: number; y: number; choices: DisconnectChoice[]; onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const rect = menu.current!.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) });
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) onClose(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") { event.stopPropagation(); onClose(); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault(); event.stopPropagation();
        const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
        const index = buttons.indexOf(window.document.activeElement as HTMLButtonElement);
        buttons[(index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
      }
    };
    const wheel = (event: WheelEvent) => { if (!menu.current?.contains(event.target as Node)) onClose(); };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("wheel", wheel, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", outside, true); window.removeEventListener("keydown", key, true);
      window.removeEventListener("wheel", wheel, true); window.removeEventListener("resize", onClose); window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  return createPortal(<div ref={menu} className="workflow-disconnect-menu" role="menu" aria-label="选择要断开的连线" style={position}
    onPointerDown={event => event.stopPropagation()} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}>
    <strong>选择要断开的连线</strong>
    {choices.map(choice => <button key={choice.key} role="menuitem" disabled={choice.disabled} title={`${choice.label} · ${choice.detail}`} onClick={() => { onClose(); choice.disconnect(); }}>
      <span><b>{choice.label}</b><small>{choice.detail}{choice.disabled ? " · 运行中" : ""}</small></span><span aria-hidden="true">断开</span>
    </button>)}
  </div>, window.document.body);
}
