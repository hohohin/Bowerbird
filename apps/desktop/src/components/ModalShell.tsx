import { type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

const FOCUSABLE = [
  "button:not(:disabled)",
  "input:not(:disabled)",
  "textarea:not(:disabled)",
  "select:not(:disabled)",
  "[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function ModalShell({
  title,
  eyebrow,
  description,
  children,
  footer,
  width = "sm",
  preventClose = false,
  onClose,
}: {
  title: string;
  eyebrow?: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: "sm" | "md" | "lg";
  preventClose?: boolean;
  onClose: () => void;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const preventCloseRef = useRef(preventClose);
  closeRef.current = onClose;
  preventCloseRef.current = preventClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const preferred = panel?.querySelector<HTMLElement>("[data-modal-autofocus]");
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    window.requestAnimationFrame(() => (preferred ?? first)?.focus());

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !preventCloseRef.current) {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;
      const firstItem = focusable[0];
      const lastItem = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, []);

  return createPortal(
    <div
      className="app-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !preventClose) onClose();
      }}
    >
      <div ref={panelRef} className="app-modal" data-width={width}>
        <header className="app-modal-header">
          <div className="min-w-0">
            {eyebrow && <div className="app-modal-eyebrow">{eyebrow}</div>}
            <h2 id={titleId} className="app-modal-title">{title}</h2>
            {description && <div className="app-modal-description">{description}</div>}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={preventClose}
            className="app-modal-close"
            title={preventClose ? "当前操作完成后可关闭" : "关闭"}
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </header>
        <div className="app-modal-body">{children}</div>
        {footer && <footer className="app-modal-footer">{footer}</footer>}
      </div>
    </div>,
    document.body
  );
}
