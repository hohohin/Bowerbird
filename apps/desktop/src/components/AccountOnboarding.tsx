import { useState } from "react";
import { useStore } from "../store";
import { ModalShell } from "./ModalShell";

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

  return (
    <ModalShell
      title="Bowerbird 账号"
      eyebrow="Account"
      description="账号只同步订阅和积分；素材库与本地数据库默认不上传。使用 Cloud / Agent 时，仅本次明确提交的文字和参考图会临时上传。"
      width="md"
      preventClose={busy}
      onClose={() => setOpen(false)}
      footer={(
        <button type="button" onClick={() => setOpen(false)} disabled={busy} className="app-modal-button">
          关闭
        </button>
      )}
    >
        {auth?.logged_in ? (
          <div className="settings-card p-4">
            <div className="text-sm text-ink">{auth.email || auth.user_id}</div>
            <div className="mt-1 text-xs text-muted">当前档位：{entitlement?.tier?.toUpperCase() || "FREE"}</div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center text-[11px]">
              <div className="rounded-lg border border-edge bg-canvas/70 p-2"><div className="text-muted">每日</div><div className="mt-0.5 text-sm font-semibold text-ink">{entitlement?.balances.daily ?? 0}</div></div>
              <div className="rounded-lg border border-edge bg-canvas/70 p-2"><div className="text-muted">订阅</div><div className="mt-0.5 text-sm font-semibold text-ink">{entitlement?.balances.sub ?? 0}</div></div>
              <div className="rounded-lg border border-edge bg-canvas/70 p-2"><div className="text-muted">充值</div><div className="mt-0.5 text-sm font-semibold text-ink">{entitlement?.balances.topup ?? 0}</div></div>
            </div>
            {(entitlement?.recent_transactions?.length ?? 0) > 0 && (
              <div className="mt-3 border-t border-edge pt-2">
                <div className="text-[10px] uppercase tracking-wide text-muted">最近积分流水</div>
                <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto text-[11px]">
                  {entitlement!.recent_transactions.slice(0, 50).map((tx, index) => (
                    <li key={`${tx.created_at}-${index}`} className="flex items-center justify-between gap-2 text-muted">
                      <span className="truncate">{tx.meta?.entity_type === "agent_run" ? `Agent Run · ${tx.meta.final_status}` : tx.kind}{tx.service ? ` · ${tx.service}` : ""}</span>
                      <span className={tx.amount >= 0 ? "text-green-400" : "text-red-300"}>{tx.amount >= 0 ? `+${tx.amount}` : tx.amount}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <button type="button" onClick={() => void logout()} disabled={busy} className="app-modal-button is-danger mt-3">
              {busy && <span className="app-spinner" aria-hidden="true" />}
              登出账号
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="settings-card p-4 text-xs text-muted">
              <div className="font-medium text-ink">邮箱魔法链接</div>
              <div className="mt-1">输入邮箱后，在本机浏览器打开邮件里的链接；完成验证会自动回到 Bowerbird。</div>
            </div>
            <div className="flex gap-2">
              <input data-modal-autofocus type="email" value={email} onChange={(e) => { setEmail(e.target.value); setSent(false); }} placeholder="you@example.com" className="app-form-input min-w-0 flex-1 px-3 py-2 text-sm" />
              <button
                type="button"
                onClick={async () => {
                  try { await startLogin(email); setSent(true); } catch { /* store 显示错误 */ }
                }}
                disabled={busy || !auth?.cloud_available || !email}
                className="app-modal-button is-primary"
              >
                {busy && <span className="app-spinner" aria-hidden="true" />}
                发送链接
              </button>
            </div>
            {auth && !auth.cloud_available && <p className="app-inline-status is-warning">当前版本未配置 Bowerbird Cloud；请安装官方构建。</p>}
            {sent && <p className="app-inline-status is-success">邮件已发送，请在本机浏览器完成验证。</p>}
            {error && <p className="app-inline-status is-error">{error}</p>}
          </div>
        )}
    </ModalShell>
  );
}
