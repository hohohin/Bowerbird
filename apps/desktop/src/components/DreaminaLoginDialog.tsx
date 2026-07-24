import { useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";

/**
 * 即梦登录引导（约定 13 Modal，open/onClose 受控）。
 *
 * ⚠️ app 内 spawn dreamina login 的 OAuth 在 Windows GUI 子进程下**不写登录态**（多次调试未定位根因，
 * 见 PROJECT.md 踩坑「dreamina OAuth app spawn 不写 token」）。故本 Dialog 引导用户在终端
 * `dreamina login`（可靠，用户 Phase 0 验证）+ 浏览器授权，再回 app「重新检测」（user_credit 检测正常）。
 */
export function DreaminaLoginDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const setDreaminaHealth = useStore((s) => s.setDreaminaHealth);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!open) return null;

  async function recheck() {
    setChecking(true);
    try {
      setDreaminaHealth(await api.dreaminaHealth());
    } catch {
      setDreaminaHealth({ ok: false, reason: "dreamina 状态检测失败" });
    } finally {
      setChecking(false);
    }
  }

  function copyCmd() {
    navigator.clipboard.writeText("dreamina login").then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-lg border border-edge bg-panel p-6 shadow-2xl">
        <h2 className="text-lg font-semibold text-ink">登录即梦账号</h2>
        <p className="mt-1 text-xs text-muted">
          app 内登录暂不可用（dreamina OAuth 在 app 子进程下不写登录态），请在终端完成：
        </p>

        <div className="mt-4 space-y-3">
          <div className="rounded bg-panel2 p-2">
            <div className="text-[10px] uppercase tracking-wide text-muted">第 1 步 · 终端运行</div>
            <div className="mt-1 flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-edge px-2 py-1 font-mono text-[11px] text-ink">
                dreamina login
              </code>
              <button
                onClick={copyCmd}
                className="shrink-0 rounded bg-edge px-2 py-0.5 text-[11px] text-ink hover:opacity-80"
              >
                {copied ? "已复制 ✓" : "复制"}
              </button>
            </div>
          </div>
          <div className="rounded bg-panel2 p-2 text-xs text-muted">
            <div className="text-[10px] uppercase tracking-wide text-muted">第 2 步 · 浏览器授权</div>
            <div className="mt-1">终端会输出授权链接，点开完成即梦/抖音账号授权。</div>
          </div>
          <div className="rounded bg-panel2 p-2">
            <div className="text-[10px] uppercase tracking-wide text-muted">第 3 步 · 回 app 检测</div>
            <button
              onClick={recheck}
              disabled={checking}
              className="mt-1 w-full rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-black hover:opacity-90 disabled:opacity-50"
            >
              {checking ? "检测中…" : "我已登录，重新检测"}
            </button>
          </div>
        </div>

        <div className="mt-5 flex justify-end">
          <button
            onClick={onClose}
            className="rounded-md bg-panel2 px-4 py-1.5 text-sm text-ink hover:bg-edge"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
