import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { usePortalTarget } from "../lib/portalTarget";
import "./SourceBrowserPopover.css";

const OPEN_EVENT = "source-browser:popover-open";

export function SourceBrowserPopover({ id, button, title, onClose, className = "", children }: {
  id: string;
  button: RefObject<HTMLButtonElement>;
  title: string;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const target = usePortalTarget();
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  const dismiss = () => {
    closeRef.current();
    button.current?.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    const anchor = button.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const browser = anchor.closest(".explore-browser");
    const update = () => {
      const gap = 8;
      const { innerWidth, innerHeight } = window;
      const anchorRect = anchor.getBoundingClientRect();
      const browserRect = browser?.getBoundingClientRect() ?? anchorRect;
      const rightSpace = innerWidth - browserRect.right - 2 * gap;
      const leftSpace = browserRect.left - 2 * gap;
      const fitsRight = rightSpace >= 240;
      const fitsLeft = !fitsRight && leftSpace >= 240;
      const width = Math.min(390, fitsRight ? rightSpace : fitsLeft ? leftSpace : innerWidth - 2 * gap);
      const left = fitsRight ? browserRect.right + gap : fitsLeft ? browserRect.left - width - gap
        : Math.max(gap, Math.min(anchorRect.right - width, innerWidth - width - gap));
      const top = Math.max(gap, Math.min(anchorRect.bottom + gap, innerHeight - 180));
      setPosition({ left, top, width, maxHeight: innerHeight - top - gap });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(anchor);
    if (browser) observer.observe(browser);
    window.addEventListener("resize", update);
    window.addEventListener("explorer:layout", update);
    const frame = window.requestAnimationFrame(() => panel.focus({ preventScroll: true }));

    const pointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !panel.contains(event.target) && !anchor.contains(event.target)) closeRef.current();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const activeDialog = document.activeElement?.closest('[role="dialog"], [role="alertdialog"], [role="menu"]');
      if (activeDialog && activeDialog !== panel) return;
      event.preventDefault();
      closeRef.current();
      anchor.focus({ preventScroll: true });
    };
    const otherPopoverOpened = () => closeRef.current();
    document.dispatchEvent(new Event(OPEN_EVENT));
    document.addEventListener(OPEN_EVENT, otherPopoverOpened);
    document.addEventListener("pointerdown", pointerDown, true);
    window.addEventListener("keydown", keyDown);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("explorer:layout", update);
      window.cancelAnimationFrame(frame);
      document.removeEventListener(OPEN_EVENT, otherPopoverOpened);
      document.removeEventListener("pointerdown", pointerDown, true);
      window.removeEventListener("keydown", keyDown);
    };
  }, [button]);

  return createPortal(<div ref={panelRef} id={id} role="dialog" aria-labelledby={titleId} tabIndex={-1}
    className={`source-browser-popover ${className}`} style={position}>
    <header className="source-browser-popover-header">
      <h2 id={titleId}>{title}</h2>
      <button type="button" onClick={dismiss} aria-label={`关闭${title}`}><X size={16} aria-hidden /></button>
    </header>
    <div className="source-browser-popover-body">{children}</div>
  </div>, target);
}
