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
  if (!open) return null;

  return (
    <ModalShell
      title={title}
      eyebrow={danger ? "Danger zone" : "Confirm action"}
      description={message}
      onClose={onCancel}
      footer={
        <>
          <button data-modal-autofocus onClick={onCancel} className="app-modal-button">
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={`app-modal-button ${danger ? "is-danger" : "is-primary"}`}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="rounded-xl border border-edge bg-panel2/60 px-3 py-2.5 text-xs leading-5 text-muted">
        操作执行后将立即生效，请确认当前选择无误。
      </div>
    </ModalShell>
  );
}
