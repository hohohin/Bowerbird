import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode, type Dispatch, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { usePortalTarget } from "../lib/portalTarget";
import { useContextMenuOwnership } from "../lib/contextMenuOwnership";
import { ChevronRight, Trash2 } from "lucide-react";
import { OverlayScrollArea } from "./CollectionScrollArea";

const MenuContext = createContext<{ owner: string; submenuPath: string[]; ancestors: string[]; setSubmenuPath: Dispatch<SetStateAction<string[]>> } | null>(null);
const items = (menu: Element) => [...menu.querySelectorAll<HTMLButtonElement>('button:is([role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]):not(:disabled)')];
function focusItem(item?: HTMLElement, keepAnchorStill = false) {
  if (!item) return;
  item.focus({ preventScroll: true });
  if (!keepAnchorStill) {
    item.scrollIntoView({ block: "nearest", inline: "nearest" });
    return;
  }
  const viewport = item.closest<HTMLElement>(".collection-scroll-viewport");
  if (!viewport) return;
  const bounds = viewport.getBoundingClientRect();
  const rect = item.getBoundingClientRect();
  if (rect.top < bounds.top) viewport.scrollTop += rect.top - bounds.top;
  else if (rect.bottom > bounds.bottom) viewport.scrollTop += rect.bottom - bounds.bottom;
}

/** One menu family owns keyboard input, dismissal and focus, including its portalled submenu. */
export function ContextMenu({ x = 0, y = 0, anchor, label, children, onClose, className = "", contentClassName = "", trigger }: {
  label: string; children: ReactNode; onClose: () => void;
  className?: string; contentClassName?: string; trigger?: HTMLElement | null;
} & ({ x: number; y: number; anchor?: never } | { anchor: HTMLElement; x?: never; y?: never })) {
  const owner = useId();
  const portalTarget = usePortalTarget();
  const root = useRef<HTMLDivElement>(null);
  const origin = useRef(anchor ?? trigger ?? document.elementFromPoint(x, y)?.closest<HTMLElement>('button, [tabindex]') ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const close = useRef(onClose); close.current = onClose;
  const superseded = useContextMenuOwnership(owner, true, onClose);
  const [submenuPath, setSubmenuPath] = useState<string[]>([]);
  const subRef = useRef(submenuPath); subRef.current = submenuPath;
  const belongs = (target: EventTarget | null) => target instanceof Element && target.closest('[data-context-owner]')?.getAttribute('data-context-owner') === owner;
  useLayoutEffect(() => {
    const element = root.current!;
    const position = () => {
      const rect = element.getBoundingClientRect();
      const button = anchor?.getBoundingClientRect();
      const below = button ? button.bottom + 4 : y;
      const opensAbove = button && below + rect.height > innerHeight - 8 && button.top > innerHeight - button.bottom;
      const preferredTop = opensAbove ? button.top - rect.height - 4 : below;
      const left = `${Math.max(8, Math.min(button?.left ?? x, innerWidth - rect.width - 8))}px`;
      const top = `${Math.max(8, Math.min(preferredTop, innerHeight - rect.height - 8))}px`;
      if (element.style.left !== left) element.style.left = left;
      if (element.style.top !== top) element.style.top = top;
    };
    position();
    if (anchor) {
      // A button can move during an animation or scroll without changing size.
      let frame = requestAnimationFrame(function trackAnchor() {
        position();
        frame = requestAnimationFrame(trackAnchor);
      });
      return () => cancelAnimationFrame(frame);
    }
    const observer = new ResizeObserver(position); observer.observe(element);
    window.addEventListener("resize", position);
    return () => { observer.disconnect(); window.removeEventListener("resize", position); };
  }, [x, y, anchor, portalTarget]);
  useEffect(() => {
    const outside = (event: Event) => {
      if (event.type === "pointerdown" && event.target instanceof Node && anchor?.contains(event.target)) return;
      if (!belongs(event.target)) close.current();
    };
    const blur = () => close.current();
    const key = (event: KeyboardEvent) => {
      if (superseded.current) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]') && !belongs(document.activeElement) && document.activeElement !== origin.current) return;
      const active = document.activeElement as HTMLElement | null;
      const current = (belongs(active) ? active?.closest('[role="menu"]') : root.current) as HTMLElement | null;
      if (!current) return;
      if (event.key === "Escape" || event.key === "ArrowLeft") {
        const path = subRef.current;
        const submenu = path[path.length - 1];
        if (submenu) {
          event.preventDefault(); event.stopImmediatePropagation();
          const parent = document.getElementById(submenu);
          setSubmenuPath(path => path.slice(0, -1)); parent?.focus({ preventScroll: true });
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
      focusItem(buttons[next], !!anchor);
    };
    const frame = requestAnimationFrame(() => {
      if (root.current && !superseded.current) focusItem(items(root.current)[0], !!anchor);
    });
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("wheel", outside, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", blur);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("wheel", outside, true); window.removeEventListener("keydown", key, true); window.removeEventListener("blur", blur);
      if (!superseded.current && (belongs(document.activeElement) || document.activeElement === document.body) && origin.current?.isConnected) origin.current.focus({ preventScroll: true });
    };
  }, [owner, anchor]);
  return <MenuContext.Provider value={{ owner, submenuPath, ancestors: [], setSubmenuPath }}>{createPortal(
    <div ref={root} role="menu" aria-label={label} data-context-owner={owner}
      className={`app-context-menu context-menu-surface ${className}`} style={{ left: x, top: y }}
      onPointerDown={event => event.stopPropagation()} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}>
      <OverlayScrollArea className="context-menu-scroll" contentClassName={`context-menu-content ${contentClassName}`} label="菜单滚动条">{children}</OverlayScrollArea>
    </div>, portalTarget)}</MenuContext.Provider>;
}

export function ContextSubmenu({ label, children, icon, disabled = false, disabledReason, title, menuLabel = label }: {
  label: string; children: ReactNode | (() => ReactNode); icon?: ReactNode; disabled?: boolean; disabledReason?: string; title?: string; menuLabel?: string;
}) {
  const context = useContext(MenuContext)!;
  const portalTarget = usePortalTarget();
  const id = useId(), panelId = useId();
  const button = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const focusOnOpen = useRef(false);
  const depth = context.ancestors.length;
  const open = context.submenuPath[depth] === id && !disabled;
  const path = [...context.ancestors, id];
  const cancel = () => clearTimeout(timer.current);
  const show = () => context.setSubmenuPath(current => current[depth] === id ? current : path);
  const leave = (event: PointerEvent) => {
    cancel();
    const next = event.relatedTarget instanceof Element ? event.relatedTarget.closest<HTMLElement>("[data-context-submenu]") : null;
    if (next && context.submenuPath.indexOf(next.dataset.contextSubmenu ?? "") >= depth) return;
    timer.current = setTimeout(() => {
      if (panel.current?.contains(document.activeElement)) button.current?.focus({ preventScroll: true });
      context.setSubmenuPath(current => current[depth] === id ? current.slice(0, depth) : current);
    }, 250);
  };
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
      aria-controls={open ? panelId : undefined} aria-label={disabledReason ? label : undefined} aria-description={disabledReason}
      disabled={disabled} title={title} className="app-context-item px-2 py-1.5"
      onPointerEnter={() => { cancel(); if (!disabled) timer.current = setTimeout(show, 120); }} onPointerLeave={leave}
      onClick={() => {
        cancel(); focusOnOpen.current = true;
        if (open) { focusItem(items(panel.current!)[0]); focusOnOpen.current = false; }
        else show();
      }}>
      {icon}<span className="min-w-0 flex-1">{label}{disabledReason && <small className="context-menu-reason">{disabledReason}</small>}</span><ChevronRight className="context-menu-chevron" size={13} aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={panel} id={panelId} role="menu" aria-label={menuLabel} data-context-owner={context.owner} data-context-submenu={id}
      className="app-context-menu context-menu-surface context-submenu" onPointerEnter={cancel} onPointerLeave={leave}
      onPointerDown={event => event.stopPropagation()} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}>
      <MenuContext.Provider value={{ ...context, ancestors: path }}>
        <OverlayScrollArea className="context-menu-scroll" contentClassName="context-menu-content" label="子菜单滚动条">{typeof children === "function" ? children() : children}</OverlayScrollArea>
      </MenuContext.Provider>
    </div>, portalTarget)}
  </>;
}

export function DeleteSubmenu({ children, disabled }: { children: ReactNode; disabled?: boolean }) {
  return <ContextSubmenu label="删除" disabled={disabled} icon={<Trash2 size={13} aria-hidden="true" />}>{children}</ContextSubmenu>;
}
