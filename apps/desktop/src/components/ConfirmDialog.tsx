import { type ReactNode } from "react";
import { ModalShell } from "./ModalShell";

/**
 * 通用二次确认弹窗（约定 13 全屏 Modal 形态）。
 * 取代此前「输入确认口令」的绕过 window.confirm 方案——WKWebView 拦截原生对话框，
 * 统一复用 ModalShell：Esc / 点遮罩 = onCancel，并自动处理焦点循环与恢复。
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel = "取消",
  danger = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;

  return (
    <ModalShell
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button data-modal-autofocus onClick={onCancel} className="app-modal-button">
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            disabled={confirmDisabled}
            className={`app-modal-button ${danger ? "is-danger" : "is-primary"}`}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="text-[13px] leading-6 text-muted">
        <p>{message}</p>
      </div>
    </ModalShell>
  );
}
