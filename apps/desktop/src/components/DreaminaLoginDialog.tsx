import { useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";

/**
 * 即梦登录引导（约定 13 Modal，open/onClose 受控）。
 *
 * dreamina login 非 headless 依赖 stdout 是真 TTY 才走完 OAuth + 写 token；app 内 spawn
 * （Stdio::piped）非 TTY 会让进程早退、不写 token（PROJECT.md 踩坑「dreamina OAuth app
 * spawn 不写 token」）。故这里一键拉起一个真正的系统终端窗口（真 TTY）跑 `dreamina login`，
 * dreamina 完整走完授权并写登录态；用户授权后回 app「重新检测」（user_credit 检测正常）。
 * 对称 codex 的 open_codex_session。
 */
export function DreaminaLoginDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const setDreaminaHealth = useStore((s) => s.setDreaminaHealth);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [launched, setLaunched] = useState(false);

  if (!open) return null;

  async function openTerminal() {
    setLaunching(true);
    try {
      await api.openDreaminaLogin();
      setLaunched(true);
    } catch {
      setLaunched(false);
    } finally {
      setLaunching(false);
    }
  }

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
          点击下方按钮会打开系统终端自动运行登录命令（dreamina 授权需在真实终端环境完成）。
        </p>

        <div className="mt-4 space-y-3">
          <div className="rounded bg-panel2 p-2">
            <div className="text-[10px] uppercase tracking-wide text-muted">第 1 步 · 打开终端登录</div>
            <div className="mt-1.5 flex items-center gap-2">
              <button
                onClick={openTerminal}
                disabled={launching}
                className="flex-1 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-black hover:opacity-90 disabled:opacity-50"
              >
                {launching ? "正在打开…" : "打开终端登录"}
              </button>
              <button
                onClick={copyCmd}
                className="shrink-0 rounded bg-edge px-2 py-1.5 text-[11px] text-ink hover:opacity-80"
                title="若按钮无法打开终端，可手动复制此命令到终端运行"
              >
                {copied ? "已复制 ✓" : "复制命令"}
              </button>
            </div>
            {launched && (
              <div className="mt-1.5 text-[11px] text-accent">
                ✓ 终端已打开，请在其中完成授权后回到这里。
              </div>
            )}
          </div>
          <div className="rounded bg-panel2 p-2 text-xs text-muted">
            <div className="text-[10px] uppercase tracking-wide text-muted">第 2 步 · 完成授权</div>
            <div className="mt-1">
              在弹出的终端窗口里按提示完成授权（即梦/抖音 app 扫码，或打开终端显示的链接）。
            </div>
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
