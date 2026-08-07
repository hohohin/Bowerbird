import { useState } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { useStore } from "../store";
import { api } from "../lib/api";
import type { DreaminaDeviceFlow } from "../lib/types";

/**
 * 即梦登录引导（约定 13 Modal，open/onClose 受控）。
 *
 * 方案 B（2026-08-07，替代「打开终端」）：app 内 spawn `dreamina login --headless`（不依赖真
 * TTY，打印 verification_uri/user_code/device_code 后退出，spike 实测稳定），拿到字段后**自动
 * 打开系统浏览器**到授权页 + 展示授权码 → 用户完成授权 → `dreamina_check_login` 用 device_code
 * 补完写 token。全程 app 内完成，小白无需碰终端。
 */
export function DreaminaLoginDialog({ open: dialogOpen, onClose }: { open: boolean; onClose: () => void }) {
  const setDreaminaHealth = useStore((s) => s.setDreaminaHealth);
  const [checking, setChecking] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [flow, setFlow] = useState<DreaminaDeviceFlow | null>(null);
  const [authDone, setAuthDone] = useState(false);
  const [error, setError] = useState("");

  if (!dialogOpen) return null;

  async function startLogin() {
    setLaunching(true);
    setError("");
    setFlow(null);
    setAuthDone(false);
    try {
      const f = await api.dreaminaLoginHeadless();
      setFlow(f);
      // 一步化：拿到授权链接自动打开浏览器（shell:allow-open 已授权，CodexOnboarding 同款）。
      void open(f.verification_uri).catch((e) => setError(`打开浏览器失败：${e}`));
    } catch (e) {
      setError(String(e));
    } finally {
      setLaunching(false);
    }
  }

  async function finishAuth() {
    setChecking(true);
    setError("");
    try {
      if (flow) {
        const h = await api.dreaminaCheckLogin(flow.device_code);
        setDreaminaHealth(h);
        if (h.ok) {
          setAuthDone(true);
          onClose();
          return;
        }
        setError(h.reason || "授权未完成，请确认已在浏览器完成授权后重试");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setChecking(false);
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-lg border border-edge bg-panel p-6 shadow-2xl">
        <h2 className="text-lg font-semibold text-ink">登录即梦账号</h2>

        <div className="mt-4 space-y-3">
          <div className="rounded bg-panel2 p-2">
            <div className="text-[10px] uppercase tracking-wide text-muted">第 1 步 · 打开授权页面</div>
            <button
              onClick={startLogin}
              disabled={launching}
              className="mt-1.5 w-full rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-black hover:opacity-90 disabled:opacity-50"
            >
              {launching ? "正在获取授权信息…" : "打开授权页面登录"}
            </button>
            {flow && (
              <div className="mt-2 rounded bg-panel p-2 text-[11px] text-muted">
                已打开浏览器。若未自动打开，请访问：
                <div className="mt-1 break-all text-accent">{flow.verification_uri}</div>
              </div>
            )}
          </div>

          <div className="rounded bg-panel2 p-2 text-xs text-muted">
            <div className="text-[10px] uppercase tracking-wide text-muted">第 2 步 · 完成授权</div>
            <div className="mt-1">
              在浏览器里登录你的即梦账号并完成授权。
              {flow && (
                <>
                  {" "}如需输入授权码：
                  <span className="font-mono text-ink">{flow.user_code}</span>
                </>
              )}
            </div>
          </div>

          <div className="rounded bg-panel2 p-2">
            <div className="text-[10px] uppercase tracking-wide text-muted">第 3 步 · 完成</div>
            <button
              onClick={finishAuth}
              disabled={checking || !flow}
              className="mt-1 w-full rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-black hover:opacity-90 disabled:opacity-50"
            >
              {checking ? "检测中…" : "我已完成授权，登录"}
            </button>
            {authDone && <div className="mt-1.5 text-[11px] text-accent">✓ 登录成功</div>}
          </div>

          {error && (
            <div className="rounded bg-red-500/15 p-2 text-xs text-red-300">{error}</div>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={recheck}
            disabled={checking}
            className="rounded-md bg-panel2 px-3 py-1.5 text-sm text-ink hover:bg-edge disabled:opacity-50"
          >
            {checking ? "检测中…" : "重新检测"}
          </button>
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
