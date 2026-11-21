import { type HTMLAttributes, type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { usePortalTarget } from "../lib/portalTarget";
import { X } from "lucide-react";

const FOCUSABLE = [
  "button",
  "input",
  "textarea",
  "select",
  "[href]",
  "details > summary:first-of-type",
  "[tabindex]",
].join(",");

function isVisibleFocusTarget(element: HTMLElement) {
  return !element.matches(":disabled")
    && !element.closest("[hidden], [inert], details:not([open]) > :not(summary:first-of-type)")
    && element.getClientRects().length > 0
    && getComputedStyle(element).visibility === "visible";
}

export function ModalShell({
  title,
  eyebrow,
  description,
  headerActions,
  showCloseButton = true,
  panelProps,
  children,
  footer,
  width = "sm",
  className = "",
  preventClose = false,
  onClose,
}: {
  title: string;
  eyebrow?: string;
  description?: ReactNode;
  headerActions?: ReactNode;
  showCloseButton?: boolean;
  panelProps?: HTMLAttributes<HTMLDivElement>;
  children: ReactNode;
  footer?: ReactNode;
  width?: "sm" | "md" | "lg";
  className?: string;
  preventClose?: boolean;
  onClose: () => void;
}) {
  const titleId = useId();
  const portalTarget = usePortalTarget();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const preventCloseRef = useRef(preventClose);
  closeRef.current = onClose;
  preventCloseRef.current = preventClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    if (!panel) return;
    const focusableItems = () => Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter(item => item.tabIndex >= 0 && isVisibleFocusTarget(item));
    const frame = window.requestAnimationFrame(() => {
      const preferred = Array.from(panel.querySelectorAll<HTMLElement>("[data-modal-autofocus]"))
        .find(isVisibleFocusTarget);
      (preferred ?? focusableItems()[0] ?? panel).focus({ preventScroll: true });
    });

    function onKeyDown(event: KeyboardEvent) {
      if (!panel || event.defaultPrevented) return;
      // A second modal (e.g. subscription settings above a composition) owns its own keys.
      const active = document.activeElement;
      const activeDialog = active?.closest('[role="dialog"]');
      if (activeDialog && !activeDialog.contains(panel)) return;
      if (event.key === "Escape" && !preventCloseRef.current) {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      if (!activeDialog) {
        const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]'))
          .filter(isVisibleFocusTarget);
        if (panel.closest('[role="dialog"]') !== dialogs[dialogs.length - 1]) return;
      }
      const focusable = focusableItems();
      const firstItem = focusable[0];
      const lastItem = focusable[focusable.length - 1];
      const atBoundary = event.shiftKey ? active === firstItem || active === panel : active === lastItem;
      if (!firstItem || !panel.contains(active) || atBoundary) {
        event.preventDefault();
        const target = (event.shiftKey ? lastItem : firstItem) ?? panel;
        target.focus();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
      previous?.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <div
      className={`app-modal-backdrop ${className}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !preventClose) onClose();
      }}
    >
      <div tabIndex={-1} {...panelProps} ref={panelRef} className="app-modal" data-width={width}>
        <header className="app-modal-header">
          <div className="min-w-0">
            {eyebrow && <div className="app-modal-eyebrow">{eyebrow}</div>}
            <h2 id={titleId} className="app-modal-title">{title}</h2>
            {description && <div className="app-modal-description">{description}</div>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {headerActions}
            {showCloseButton && <button
              type="button"
              onClick={onClose}
              disabled={preventClose}
              className="app-modal-close"
              title={preventClose ? "当前操作完成后可关闭" : "关闭"}
              aria-label="关闭"
            >
              <X size={16} />
            </button>}
          </div>
        </header>
        <div className="app-modal-body">{children}</div>
        {footer && <footer className="app-modal-footer">{footer}</footer>}
      </div>
    </div>,
    portalTarget
  );
}
