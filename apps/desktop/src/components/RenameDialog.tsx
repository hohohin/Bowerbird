import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";

/**
 * 素材重命名弹窗（约定 13 全屏 Modal 形态，照 ConfirmDialog 范式 + 单 input）。
 * 确定后调 `rename_asset`：同步重命名磁盘文件（store/thumb）+ DB name/store_path/thumb_path
 * （扩展名保留；同名冲突后端追加 id 前缀）。刷新交由 library://assets-changed → App refresh，
 * 详情页/瀑布流自动跟随。Esc / 点遮罩 = 取消。
 */
export function RenameDialog({
  open,
  assetId,
  currentName,
  onClose,
}: {
  open: boolean;
  assetId: string;
  currentName: string;
  onClose: () => void;
}) {
  const [name, setName] = useState(currentName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // open 变化时重置为当前名（后续 open 复用同一个 dialog 实例时预填最新值）。
  useEffect(() => {
    if (!open) return;
    setName(currentName);
    setError(null);
    setBusy(false);
  }, [open, currentName]);

  // 打开即聚焦全选，直接输入替换。
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const trimmed = name.trim();

  async function submit() {
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.renameAsset(assetId, trimmed);
      onClose();
    } catch (e) {
      setError(typeof e === "string" ? e : "重命名失败");
      setBusy(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="重命名素材"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-lg border border-edge bg-panel p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-ink">重命名素材</h3>
        <p className="mt-1 text-xs text-muted">
          同时重命名库内磁盘文件（扩展名保留；同名时后端自动加标识不覆盖）。
        </p>
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
            if (e.key === "Escape") onClose();
          }}
          maxLength={64}
          placeholder="输入新名称"
          className="mt-3 w-full rounded-md border border-edge bg-panel2 px-3 py-1.5 text-sm text-ink outline-none ring-1 ring-edge focus:ring-accent"
        />
        {error && <p className="mt-2 text-xs text-red-300">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-md bg-panel2 px-3 py-1.5 text-xs text-ink hover:bg-edge disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={() => void submit()}
            disabled={!trimmed || busy}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-black hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "重命名中…" : "重命名"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
