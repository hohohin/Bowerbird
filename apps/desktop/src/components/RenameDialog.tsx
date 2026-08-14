import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { notifySuccess } from "../lib/notify";
import { ModalShell } from "./ModalShell";

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

  if (!open) return null;

  const trimmed = name.trim();

  async function submit() {
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.renameAsset(assetId, trimmed);
      notifySuccess("素材名称已更新");
      onClose();
    } catch (e) {
      setError(typeof e === "string" ? e : "重命名失败");
      setBusy(false);
    }
  }

  return (
    <ModalShell
      title="重命名素材"
      eyebrow="Asset name"
      description="同时更新素材库中的本地文件名；扩展名会保留，同名文件不会被覆盖。"
      onClose={onClose}
      preventClose={busy}
      footer={
        <>
          <button onClick={onClose} disabled={busy} className="app-modal-button">
            取消
          </button>
          <button
            onClick={() => void submit()}
            disabled={!trimmed || busy}
            className="app-modal-button is-primary"
          >
            {busy && <span className="app-spinner" aria-hidden />}
            {busy ? "重命名中…" : "保存名称"}
          </button>
        </>
      }
    >
      <label className="block text-[11px] font-medium text-muted" htmlFor="rename-asset-input">
        素材名称
      </label>
        <input
          id="rename-asset-input"
          ref={inputRef}
          data-modal-autofocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
            if (e.key === "Escape") onClose();
          }}
          maxLength={64}
          placeholder="输入新名称"
          className="app-form-input mt-2 px-3 text-sm"
        />
      <div className="mt-2 flex items-center justify-between gap-3 text-[10px] text-faint">
        <span>最多 64 个字符</span>
        <span>{name.length}/64</span>
      </div>
      {error && (
        <p className="mt-3 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}
    </ModalShell>
  );
}
