import { useEffect } from "react";
import { createPortal } from "react-dom";

/**
 * 通用二次确认弹窗（约定 13 全屏 Modal 形态）。
 * 取代此前「输入确认口令」的绕过 window.confirm 方案——WKWebView 拦截原生对话框，
 * 故沿用 Onboarding 的 createPortal + fixed inset-0 遮罩 + 居中卡片范式。
 * Esc / 点遮罩 = onCancel；卡片 onClick stopPropagation 防穿透。
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel = "取消",
  danger = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-lg border border-edge bg-panel p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        <p className="mt-2 text-xs text-muted">{message}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md bg-panel2 px-3 py-1.5 text-xs text-ink hover:bg-edge"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={
              danger
                ? "rounded-md bg-red-500/30 px-3 py-1.5 text-xs font-semibold text-red-200 hover:bg-red-500/40"
                : "rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-black hover:opacity-90"
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
