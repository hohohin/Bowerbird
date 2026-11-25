import {
  createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState,
  type DragEvent, type PointerEvent, type ReactNode,
} from "react";
import { ArrowRight, type LucideIcon } from "lucide-react";
import { createPortal, flushSync } from "react-dom";
import { useLatestCallback } from "../lib/useCanvasFrame";
import { usePortalTarget } from "../lib/portalTarget";
import { OverlayScrollArea } from "./CollectionScrollArea";
import "./CanvasToolbox.css";

export type CanvasToolGroupId = "container" | "content" | "workflow" | "toolbox";
export type CanvasToolDescriptor<T extends string> = {
  id: T;
  label: string;
  icon: LucideIcon | ((props: { size: number }) => ReactNode);
  shortcut?: string;
  locked?: boolean;
  disabled?: boolean;
  draggable?: boolean;
  windingKey?: boolean;
  buttonLabel?: string;
};
export type CanvasToolActivation = { x: number; y: number };
type CanvasToolSection<T extends string> = {
  label?: string;
  locked?: boolean;
  tools: CanvasToolDescriptor<T>[];
};
type ToolPress = { end: () => void; held: boolean };
const HOVER_MS = 240;
const HOLD_MS = 110;
const EXIT_MS = 140;

const GroupContext = createContext<{
  open: CanvasToolGroupId | null;
  setOpen: (id: CanvasToolGroupId | null) => void;
  hoverBlocked: () => boolean;
} | null>(null);

export function CanvasToolGroups({ children, hoverBlocked }: { children: ReactNode; hoverBlocked: () => boolean }) {
  const [open, setOpen] = useState<CanvasToolGroupId | null>(null);
  const blockHover = useLatestCallback(hoverBlocked);
  return <GroupContext.Provider value={{ open, setOpen, hoverBlocked: blockHover }}>
    <div className="canvas-drawing-tools" role="toolbar" aria-label="画板工具"
      onPointerDown={event => event.stopPropagation()}
      onPointerOver={event => {
        if (!open || !(event.target instanceof Element) || !event.currentTarget.contains(event.target)) return;
        const button = event.target.closest<HTMLButtonElement>("button");
        if (button && button.dataset.canvasToolGroup !== open) setOpen(null);
      }}>
      {children}
    </div>
  </GroupContext.Provider>;
}

export function useCanvasToolMemory() {
  const [remembered, setRemembered] = useState<Partial<Record<CanvasToolGroupId, string>>>(() => {
    const values: Partial<Record<CanvasToolGroupId, string>> = {};
    for (const group of ["container", "content", "workflow", "toolbox"] as const) {
      try {
        const saved = localStorage.getItem("bb.canvas.lastTool." + group);
        if (saved) values[group] = saved;
      } catch { /* The toolbar remains usable when storage is unavailable. */ }
    }
    return values;
  });
  const remember = (group: CanvasToolGroupId, id: string) => {
    setRemembered(current => current[group] === id ? current : { ...current, [group]: id });
    try { localStorage.setItem("bb.canvas.lastTool." + group, id); } catch { /* Memory is optional. */ }
  };
  return { remembered, remember };
}

function ProBadge() {
  return <span className="canvas-tool-pro-badge" aria-hidden="true">PRO</span>;
}

export function CanvasToolGroup<T extends string>({
  group, label, sections, remembered, active, onTool, onDragTool, onUpgrade,
}: {
  group: CanvasToolGroupId;
  label: string;
  sections: CanvasToolSection<T>[];
  remembered?: string;
  active?: string;
  onTool: (tool: T, point?: CanvasToolActivation) => void;
  onDragTool?: (tool: T, event: DragEvent<HTMLButtonElement>) => void;
  onUpgrade?: () => void;
}) {
  const { open, setOpen, hoverBlocked } = useContext(GroupContext)!;
  const tools = sections.flatMap(section => section.tools);
  const current = tools.find(tool => tool.id === remembered) ?? tools[0];
  const CurrentIcon = current.icon;
  const portalTarget = usePortalTarget();
  const menuId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const hover = useRef<number>();
  const leave = useRef<number>();
  const press = useRef<ToolPress>();
  const nativeDrag = useRef(false);
  const releasedChoice = useRef<HTMLButtonElement>();
  const keyboardOpen = useRef(false);
  const isOpen = open === group;
  const tooltip = current.label + (current.shortcut ? " " + current.shortcut : "");

  const cancelHover = () => window.clearTimeout(hover.current);
  const cancelLeave = () => window.clearTimeout(leave.current);
  const focusButton = () => button.current?.focus({ preventScroll: true });
  const inside = (target: EventTarget | null) => target instanceof Node
    && (button.current?.contains(target) || popup.current?.contains(target));
  const items = () => Array.from(popup.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:enabled') ?? []);
  function display(keyboard = false) {
    cancelHover();
    cancelLeave();
    keyboardOpen.current = keyboard;
    if (isOpen && keyboard) items()[0]?.focus({ preventScroll: true });
    setOpen(group);
  }
  function close(restoreFocus = false) {
    cancelHover();
    cancelLeave();
    if (restoreFocus) focusButton();
    if (isOpen) setOpen(null);
  }
  function leaveGroup(target: EventTarget | null) {
    cancelHover();
    if (!isOpen || nativeDrag.current || inside(target)) return;
    cancelLeave();
    leave.current = window.setTimeout(() => close(!!popup.current?.contains(document.activeElement)), EXIT_MS);
  }
  const invoke = useLatestCallback((tool: CanvasToolDescriptor<T>, point?: CanvasToolActivation) => {
    if (tool.disabled) return;
    close(true);
    onTool(tool.id, point);
  });
  const upgrade = useLatestCallback(() => { close(true); onUpgrade?.(); });
  const chooseOnRelease = useLatestCallback((target: Element | null, point: CanvasToolActivation) => {
    if (!target || !popup.current?.contains(target)) return;
    const choice = target.closest<HTMLButtonElement>("[data-tool-choice]:enabled");
    if (!choice) return;
    releasedChoice.current = choice;
    if (choice.dataset.toolChoice === "upgrade") upgrade();
    else {
      const tool = tools.find(candidate => candidate.id === choice.dataset.toolChoice);
      if (tool) invoke(tool, point);
    }
  });
  const closeCancelledPress = useLatestCallback(() => close());
  function bindPress(event: PointerEvent<HTMLButtonElement>, tool: CanvasToolDescriptor<T>, outer: boolean) {
    if (event.button !== 0 || press.current) return;
    cancelHover();
    cancelLeave();
    const pointerId = event.pointerId;
    const owner = event.currentTarget;
    const start = { x: event.clientX, y: event.clientY };
    const wasOpen = isOpen;
    if (owner.hasPointerCapture(pointerId)) owner.releasePointerCapture(pointerId);
    let timer: number | undefined;
    const binding: ToolPress = { held: false, end: cleanup };
    press.current = binding;

    const move = (sample: globalThis.PointerEvent) => {
      if (!tool.windingKey || tool.locked || tool.disabled || binding.held || sample.pointerId !== pointerId
        || Math.hypot(sample.clientX - start.x, sample.clientY - start.y) < 5) return;
      const target = document.elementFromPoint(sample.clientX, sample.clientY);
      if (!target?.closest(".canvas-stage") || target.closest(".canvas-drawing-tools")) return;
      cleanup();
      // The canvas consumes the first pointerup to place the armed winding key.
      flushSync(() => invoke(tool, { x: sample.clientX, y: sample.clientY }));
    };
    const up = (release: globalThis.PointerEvent) => {
      if (release.pointerId !== pointerId) return;
      cleanup();
      const target = document.elementFromPoint(release.clientX, release.clientY);
      if (binding.held) {
        chooseOnRelease(target, { x: release.clientX, y: release.clientY });
      } else if (outer && owner.contains(target)) {
        if (wasOpen) close(true);
        else invoke(tool, { x: release.clientX, y: release.clientY });
      }
    };
    const cancel = (sample: globalThis.PointerEvent) => {
      if (sample.pointerId !== pointerId) return;
      cleanup();
      if (binding.held) closeCancelledPress();
    };
    function cleanup() {
      if (press.current === binding) press.current = undefined;
      window.clearTimeout(timer);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("blur", cleanup);
    }
    if (outer) timer = window.setTimeout(() => { binding.held = true; display(); }, HOLD_MS);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("blur", cleanup);
  }
  const cancelPress = () => press.current?.end();
  const dismiss = useLatestCallback((event: Event) => {
    if (event.type === "blur") {
      nativeDrag.current = false;
      cancelPress();
    }
    if (event.type === "pointerdown" || event.type === "wheel") {
      if (event.type === "pointerdown") cancelHover();
      if (inside(event.target)) return;
    }
    if (!nativeDrag.current) close();
  });
  useEffect(() => {
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("blur", dismiss);
    return () => {
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("blur", dismiss);
      cancelPress();
      cancelHover();
      cancelLeave();
    };
  }, [dismiss]);

  useLayoutEffect(() => {
    if (!isOpen || !popup.current) return;
    const element = popup.current;
    const place = () => {
      const rect = button.current?.getBoundingClientRect();
      if (!rect) return;
      const right = rect.right + 12;
      const left = right + element.offsetWidth <= window.innerWidth - 12 ? right : rect.left - element.offsetWidth - 12;
      element.style.left = Math.max(8, Math.min(left, window.innerWidth - element.offsetWidth - 10)) + "px";
      element.style.top = Math.max(8, Math.min(rect.top, window.innerHeight - element.offsetHeight - 12)) + "px";
    };
    place();
    if (keyboardOpen.current) items()[0]?.focus({ preventScroll: true });
    const observer = new ResizeObserver(place);
    observer.observe(element);
    window.addEventListener("resize", place);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); };
  }, [isOpen, portalTarget]);

  const onMenuKey = useLatestCallback((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      cancelPress();
      close(true);
      return;
    }
    if (event.key === "Tab") { close(!!inside(event.target)); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || !inside(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const choices = items();
    if (!choices.length) return;
    const index = choices.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1
      : index < 0 ? (event.key === "ArrowUp" ? choices.length - 1 : 0)
      : (index + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
    const choice = choices[next];
    choice.focus({ preventScroll: true });
    choice.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
  useEffect(() => {
    if (!isOpen) return;
    window.addEventListener("keydown", onMenuKey, true);
    window.addEventListener("wheel", dismiss, true);
    return () => {
      window.removeEventListener("keydown", onMenuKey, true);
      window.removeEventListener("wheel", dismiss, true);
      cancelLeave();
    };
  }, [isOpen, onMenuKey, dismiss]);

  function dragTool(tool: CanvasToolDescriptor<T>, event: DragEvent<HTMLButtonElement>) {
    if (press.current?.held) { event.preventDefault(); return; }
    cancelPress();
    cancelLeave();
    if (!onDragTool || !tool.draggable || tool.locked || tool.disabled) { event.preventDefault(); return; }
    nativeDrag.current = true;
    onDragTool(tool.id, event);
    if (event.defaultPrevented) nativeDrag.current = false;
  }
  function endDrag() {
    nativeDrag.current = false;
    close();
  }
  return <>
    <button ref={button} type="button" className="canvas-tool-slot" data-canvas-tool-group={group}
      aria-label={current.buttonLabel ?? current.label} aria-description={current.locked ? "需要 Pro" : undefined}
      aria-disabled={current.disabled || undefined} aria-keyshortcuts={current.shortcut}
      aria-haspopup="menu" aria-expanded={isOpen} aria-controls={isOpen ? menuId : undefined}
      aria-pressed={active === current.id} data-tip={isOpen ? undefined : tooltip}
      draggable={!!current.draggable && !current.locked && !current.disabled}
      onDragStart={event => dragTool(current, event)} onDragEnd={endDrag}
      onPointerEnter={event => {
        cancelLeave(); cancelHover();
        if (!isOpen && event.buttons === 0 && !hoverBlocked())
          hover.current = window.setTimeout(() => { if (!hoverBlocked() && !press.current) display(); }, HOVER_MS);
      }}
      onPointerLeave={event => leaveGroup(event.relatedTarget)}
      onPointerDown={event => bindPress(event, current, true)}
      onKeyDown={event => {
        if (!["ArrowRight", "ArrowDown"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        display(true);
      }}
      onClick={event => {
        if (event.detail !== 0) return;
        if (isOpen) close(true);
        else invoke(current);
      }}>
      <CurrentIcon size={18} />{current.locked && <ProBadge />}<span className="canvas-tool-fold" aria-hidden="true" />
    </button>
    {isOpen && createPortal(
      <div ref={popup} id={menuId} role="menu" aria-label={label} data-canvas-tool-menu={group}
        className="app-context-menu context-menu-surface canvas-tool-menu"
        onPointerEnter={cancelLeave} onPointerLeave={event => leaveGroup(event.relatedTarget)}
        onPointerDown={event => { releasedChoice.current = undefined; event.stopPropagation(); }}
        onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}>
        <OverlayScrollArea className="context-menu-scroll" contentClassName="context-menu-content" label="工具菜单滚动条">
          {sections.map((section, index) => <div key={index} className="canvas-tool-menu-section" role="group" aria-label={section.label}>
            {section.label && <div className="canvas-tool-menu-heading"><span>{section.label}</span>{section.locked && <ProBadge />}</div>}
            {section.tools.map(tool => {
              const Icon = tool.icon;
              return <button type="button" className={`app-context-item canvas-tool-menu-item${current.id === tool.id ? " is-active" : ""}`} role="menuitem" tabIndex={-1}
                key={tool.id} aria-label={tool.label} aria-description={tool.locked ? "需要 Pro" : undefined}
                data-tool-choice={tool.id} aria-current={current.id === tool.id ? "true" : undefined} disabled={tool.disabled}
                draggable={!!tool.draggable && !tool.locked && !tool.disabled}
                onDragStart={event => dragTool(tool, event)} onDragEnd={endDrag}
                onPointerDown={tool.windingKey ? event => bindPress(event, tool, false) : undefined}
                onClick={event => {
                  if (releasedChoice.current === event.currentTarget && event.detail !== 0) return;
                  invoke(tool, event.detail ? { x: event.clientX, y: event.clientY } : undefined);
                }}>
                <Icon size={16} /><span className="canvas-tool-menu-label">{tool.label}</span>
                {tool.shortcut && <kbd>{tool.shortcut}</kbd>}{tool.locked && <ProBadge />}
              </button>;
            })}
          </div>)}
          {onUpgrade && <button type="button" className="app-context-item canvas-tool-menu-upgrade" role="menuitem"
            tabIndex={-1} data-tool-choice="upgrade" onClick={event => {
              if (releasedChoice.current !== event.currentTarget || event.detail === 0) upgrade();
            }}>
            <span>Pro 权益 · 7 天试用</span><ArrowRight size={14} aria-hidden="true" />
          </button>}
        </OverlayScrollArea>
      </div>, portalTarget)}
  </>;
}
