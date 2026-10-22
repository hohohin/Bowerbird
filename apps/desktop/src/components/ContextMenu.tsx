import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type Dispatch, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Trash2 } from "lucide-react";
import { OverlayScrollArea } from "./CollectionScrollArea";

const OPEN_MENU = "bowerbird:context-menu-open";
const MenuContext = createContext<{ owner: string; submenu: string | null; setSubmenu: Dispatch<SetStateAction<string | null>> } | null>(null);
const items = (menu: Element) => [...menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')];
function focusItem(item?: HTMLElement) {
  item?.focus({ preventScroll: true });
  item?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** One menu family owns keyboard input, dismissal and focus, including its portalled submenu. */
export function ContextMenu({ x, y, label, children, onClose, className = "", contentClassName = "", trigger }: {
  x: number; y: number; label: string; children: ReactNode; onClose: () => void;
  className?: string; contentClassName?: string; trigger?: HTMLElement | null;
}) {
  const owner = useId();
  const root = useRef<HTMLDivElement>(null);
  const origin = useRef(trigger ?? document.elementFromPoint(x, y)?.closest<HTMLElement>('button, [tabindex]') ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const close = useRef(onClose); close.current = onClose;
  const [submenu, setSubmenu] = useState<string | null>(null);
  const subRef = useRef(submenu); subRef.current = submenu;
  const belongs = (target: EventTarget | null) => target instanceof Element && target.closest('[data-context-owner]')?.getAttribute('data-context-owner') === owner;
  useLayoutEffect(() => {
    const element = root.current!;
    const position = () => {
      const rect = element.getBoundingClientRect();
      element.style.left = `${Math.max(8, Math.min(x, innerWidth - rect.width - 8))}px`;
      element.style.top = `${Math.max(8, Math.min(y, innerHeight - rect.height - 8))}px`;
    };
    position();
    const observer = new ResizeObserver(position); observer.observe(element);
    window.addEventListener("resize", position);
    return () => { observer.disconnect(); window.removeEventListener("resize", position); };
  }, [x, y]);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent(OPEN_MENU, { detail: owner }));
    const another = (event: Event) => { if ((event as CustomEvent).detail !== owner) close.current(); };
    const outside = (event: Event) => { if (!belongs(event.target)) close.current(); };
    const blur = () => close.current();
    const key = (event: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"], [role="alertdialog"]') && !belongs(document.activeElement)) return;
      const active = document.activeElement as HTMLElement | null;
      const current = (belongs(active) ? active?.closest('[role="menu"]') : root.current) as HTMLElement | null;
      if (!current) return;
      if (event.key === "Escape" || event.key === "ArrowLeft") {
        if (subRef.current) {
          event.preventDefault(); event.stopImmediatePropagation();
          const parent = document.getElementById(subRef.current);
          setSubmenu(null); parent?.focus({ preventScroll: true });
        } else if (event.key === "Escape") {
          event.preventDefault(); event.stopImmediatePropagation(); close.current();
        } else { event.preventDefault(); event.stopImmediatePropagation(); }
        return;
      }
      if (event.key === "Tab") {
        event.stopImmediatePropagation();
        origin.current?.focus({ preventScroll: true }); close.current(); return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault(); event.stopImmediatePropagation();
        if (active?.getAttribute("aria-haspopup") === "menu") active.click();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const buttons = items(current), index = buttons.indexOf(active as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      focusItem(buttons[next]);
    };
    const frame = requestAnimationFrame(() => focusItem(items(root.current!)[0]));
    window.addEventListener(OPEN_MENU, another);
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("wheel", outside, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", blur);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener(OPEN_MENU, another); window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("wheel", outside, true); window.removeEventListener("keydown", key, true); window.removeEventListener("blur", blur);
      if ((belongs(document.activeElement) || document.activeElement === document.body) && origin.current?.isConnected) origin.current.focus({ preventScroll: true });
    };
  }, [owner]);
  return <MenuContext.Provider value={{ owner, submenu, setSubmenu }}>{createPortal(
    <div ref={root} role="menu" aria-label={label} data-context-owner={owner}
      className={`app-context-menu context-menu-surface ${className}`} style={{ left: x, top: y }}
      onPointerDown={event => event.stopPropagation()} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}>
      <OverlayScrollArea className="context-menu-scroll" contentClassName={`context-menu-content ${contentClassName}`} label="菜单滚动条">{children}</OverlayScrollArea>
    </div>, document.body)}</MenuContext.Provider>;
}

export function ContextSubmenu({ label, children, icon, disabled = false, title, menuLabel = label }: {
  label: string; children: ReactNode; icon?: ReactNode; disabled?: boolean; title?: string; menuLabel?: string;
}) {
  const context = useContext(MenuContext)!;
  const id = useId(), panelId = useId();
  const button = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const focusOnOpen = useRef(false);
  const open = context.submenu === id && !disabled;
  const cancel = () => clearTimeout(timer.current);
  const leave = () => { cancel(); timer.current = setTimeout(() => {
    if (panel.current?.contains(document.activeElement)) button.current?.focus({ preventScroll: true });
    context.setSubmenu(current => current === id ? null : current);
  }, 250); };
  useEffect(() => cancel, []);
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const anchor = button.current!.getBoundingClientRect(), rect = panel.current!.getBoundingClientRect();
      const right = anchor.right + 4, left = anchor.left - rect.width - 4;
      panel.current!.style.left = `${Math.max(8, Math.min(right + rect.width <= innerWidth - 8 ? right : left, innerWidth - rect.width - 8))}px`;
      panel.current!.style.top = `${Math.max(8, Math.min(anchor.top, innerHeight - rect.height - 8))}px`;
    };
    position();
    if (focusOnOpen.current) { focusItem(items(panel.current!)[0]); focusOnOpen.current = false; }
    const observer = new ResizeObserver(position); observer.observe(panel.current!);
    window.addEventListener("resize", position); window.addEventListener("scroll", position, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [open]);
  return <>
    <button ref={button} id={id} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? panelId : undefined} disabled={disabled} title={title} className="app-context-item px-2 py-1.5"
      onPointerEnter={() => { cancel(); if (!disabled) timer.current = setTimeout(() => context.setSubmenu(id), 120); }} onPointerLeave={leave}
      onClick={() => {
        cancel(); focusOnOpen.current = true;
        if (open) { focusItem(items(panel.current!)[0]); focusOnOpen.current = false; }
        else context.setSubmenu(id);
      }}>
      {icon}<span className="min-w-0 flex-1">{label}</span><ChevronRight className="context-menu-chevron" size={13} aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={panel} id={panelId} role="menu" aria-label={menuLabel} data-context-owner={context.owner}
      className="app-context-menu context-menu-surface context-submenu" onPointerEnter={cancel} onPointerLeave={leave}
      onPointerDown={event => event.stopPropagation()} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}>
      <OverlayScrollArea className="context-menu-scroll" contentClassName="context-menu-content" label="子菜单滚动条">{children}</OverlayScrollArea>
    </div>, document.body)}
  </>;
}

export function DeleteSubmenu({ children, disabled }: { children: ReactNode; disabled?: boolean }) {
  return <ContextSubmenu label="删除" disabled={disabled} icon={<Trash2 size={13} aria-hidden="true" />}>{children}</ContextSubmenu>;
}
