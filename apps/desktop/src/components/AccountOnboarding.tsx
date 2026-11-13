import { useState } from "react";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { useStore } from "../store";
import { ModalShell } from "./ModalShell";
import { accountErrorMessage } from "../lib/accountError";
import { SettingsDialog } from "./SettingsDialog";

/**
 * Bowerbird 账号面板（独立于「环境状态」总览）：侧栏底部账号区「登录 / 管理账号」唤起，
 * 关掉即关掉，不回到环境状态。登录方式：微信扫码（主）+ 邮箱魔法链接（次）。
 */
export function AccountOnboarding() {
  const open = useStore((s) => s.accountOnboardingForceOpen);
  const subscription = useStore(s => s.subscriptionSettingsTarget);
  const setOpen = useStore((s) => s.setAccountOnboardingForceOpen);
  const auth = useStore((s) => s.cloudAuth);
  const busy = useStore((s) => s.cloudBusy);
  const error = useStore((s) => s.cloudError);
  const startLogin = useStore((s) => s.startCloudEmailLogin);
  const startWechatLogin = useStore((s) => s.startCloudWechatLogin);
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [wechatStarted, setWechatStarted] = useState(false);

  if (subscription) return <SettingsDialog initialSection="models" initialSubscription={subscription}
    onClose={() => useStore.setState({ subscriptionSettingsTarget: null })} />;
  if (!open) return null;
  if (auth?.logged_in) return <SettingsDialog initialSection="account" onClose={() => setOpen(false)} />;

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
          <div className="space-y-3">
            <div className="settings-card p-4 text-xs text-muted">
              <div className="font-medium text-ink">微信扫码登录</div>
              <div className="mt-1">在系统浏览器弹出微信二维码，手机确认后会自动返回 Bowerbird；账号积分与桌面/官网通用。</div>
            </div>
            <button
              type="button"
              onClick={async () => {
                try {
                  const qrconnectUrl = await startWechatLogin();
                  await openExternal(qrconnectUrl);
                  setWechatStarted(true);
                } catch { /* store 显示错误 */ }
              }}
              disabled={busy || !auth?.cloud_available}
              className="app-modal-button is-primary w-full"
            >
              {busy && <span className="app-spinner" aria-hidden="true" />}
              使用微信扫码登录
            </button>
            {wechatStarted && <p className="app-inline-status is-success">已打开系统浏览器，请用微信扫码确认；完成后会自动返回 Bowerbird。</p>}
            <div className="flex items-center gap-2 pt-1 text-[11px] text-muted">
              <span className="h-px flex-1 bg-edge" />
              或使用邮箱
              <span className="h-px flex-1 bg-edge" />
            </div>
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
                className="app-modal-button"
              >
                {busy && <span className="app-spinner" aria-hidden="true" />}
                发送链接
              </button>
            </div>
            {auth && !auth.cloud_available && <p className="app-inline-status is-warning">当前版本未配置 Bowerbird Cloud；请安装官方构建。</p>}
            {sent && <p className="app-inline-status is-success">邮件已发送，请在本机浏览器完成验证。</p>}
            {error && <p role="alert" className="app-inline-status is-error">{accountErrorMessage(error)}</p>}
          </div>
    </ModalShell>
  );
}
