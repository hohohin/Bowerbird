import { useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store";

/**
 * Bowerbird 账号面板（独立于「环境状态」总览）：侧栏底部账号区「登录 / 管理账号」唤起，
 * 关掉即关掉，不回到环境状态。
 */
export function AccountOnboarding() {
  const open = useStore((s) => s.accountOnboardingForceOpen);
  const setOpen = useStore((s) => s.setAccountOnboardingForceOpen);
  const auth = useStore((s) => s.cloudAuth);
  const entitlement = useStore((s) => s.cloudEntitlement);
  const busy = useStore((s) => s.cloudBusy);
  const error = useStore((s) => s.cloudError);
  const startLogin = useStore((s) => s.startCloudEmailLogin);
  const logout = useStore((s) => s.logoutCloud);
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Bowerbird 账号">
      <div className="w-full max-w-lg rounded-lg border border-edge bg-panel p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-ink">Bowerbird 账号</h2>
            <p className="mt-1 text-xs text-muted">账号只同步订阅和积分；素材、提示词与本地数据库不上传。</p>
          </div>
          <button onClick={() => setOpen(false)} className="rounded px-2 py-1 text-muted hover:bg-panel2 hover:text-ink">✕</button>
        </div>

        {auth?.logged_in ? (
          <div className="mt-5 rounded bg-panel2 p-4">
            <div className="text-sm text-ink">{auth.email || auth.user_id}</div>
            <div className="mt-1 text-xs text-muted">当前档位：{entitlement?.tier?.toUpperCase() || "FREE"}</div>
            <div className="mt-3 grid grid-cols-3 gap-1 text-center text-[11px]">
              <div className="rounded bg-panel p-1.5"><div className="text-muted">每日</div><div className="text-ink">{entitlement?.balances.daily ?? 0}</div></div>
              <div className="rounded bg-panel p-1.5"><div className="text-muted">订阅</div><div className="text-ink">{entitlement?.balances.sub ?? 0}</div></div>
              <div className="rounded bg-panel p-1.5"><div className="text-muted">充值</div><div className="text-ink">{entitlement?.balances.topup ?? 0}</div></div>
            </div>
            {(entitlement?.recent_transactions?.length ?? 0) > 0 && (
              <div className="mt-3 border-t border-edge pt-2">
                <div className="text-[10px] uppercase tracking-wide text-muted">最近积分流水</div>
                <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto text-[11px]">
                  {entitlement!.recent_transactions.slice(0, 50).map((tx, index) => (
                    <li key={`${tx.created_at}-${index}`} className="flex items-center justify-between gap-2 text-muted">
                      <span className="truncate">{tx.kind}{tx.service ? ` · ${tx.service}` : ""}</span>
                      <span className={tx.amount >= 0 ? "text-green-400" : "text-red-300"}>{tx.amount >= 0 ? `+${tx.amount}` : tx.amount}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <button onClick={() => void logout()} disabled={busy} className="mt-3 rounded bg-panel px-3 py-1.5 text-xs text-ink hover:bg-red-500/20 hover:text-red-300 disabled:opacity-50">登出账号</button>
          </div>
        ) : (
          <div className="mt-5 space-y-3">
            <div className="rounded bg-panel2 p-4 text-xs text-muted">
              <div className="font-medium text-ink">邮箱魔法链接</div>
              <div className="mt-1">输入邮箱后，在本机浏览器打开邮件里的链接；完成验证会自动回到 Bowerbird。</div>
            </div>
            <div className="flex gap-2">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className="min-w-0 flex-1 rounded border border-edge bg-panel2 px-3 py-2 text-sm text-ink" />
              <button
                onClick={async () => {
                  try { await startLogin(email); setSent(true); } catch { /* store 显示错误 */ }
                }}
                disabled={busy || !auth?.cloud_available || !email}
                className="rounded bg-accent px-4 py-2 text-sm font-medium text-black disabled:opacity-40"
              >发送链接</button>
            </div>
            {auth && !auth.cloud_available && <p className="text-xs text-amber-300">当前版本未配置 Bowerbird Cloud；请安装官方构建。</p>}
            {sent && <p className="text-xs text-green-400">邮件已发送，请在本机浏览器完成验证。</p>}
            {error && <p className="text-xs text-red-300">{error}</p>}
          </div>
        )}

        <div className="mt-5 flex justify-end border-t border-edge pt-4">
          <button onClick={() => setOpen(false)} className="rounded bg-panel2 px-4 py-1.5 text-sm text-ink hover:bg-edge">关闭</button>
        </div>
      </div>
    </div>,
    document.body
  );
}
