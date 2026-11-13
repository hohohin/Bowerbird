import { useId, useState } from "react";
import { useStore as useSnapshot } from "zustand";
import { useStore } from "../../store";
import { CHAT_PROVIDERS, CHAT_PROVIDER_LABELS, chatUsesCloud, isChatProvider, type ChatProvider } from "../../lib/localChat";
import { chatDshStatus, chatProviderAccessIssue, chatQuote, refreshChatCapabilities, setupChatDsh } from "../../lib/chatCapabilities";
import { userErrorMessage } from "../../lib/userError";
import { ModelSelect } from "./ModelSelect";
import { ModalShell } from "../ModalShell";

export function useChatProviderAccess() {
  const auth = useStore(state => state.cloudAuth);
  const entitlement = useStore(state => state.cloudEntitlement);
  const health = useStore(state => state.codexHealth);
  const quoteSnapshot = useSnapshot(chatQuote.store);
  const dshSnapshot = useSnapshot(chatDshStatus.store);
  const { value: quote, error } = quoteSnapshot;
  const { value: dsh, error: dshError } = dshSnapshot;
  const balance = entitlement ? entitlement.balances.daily + entitlement.balances.sub + entitlement.balances.topup : 0;
  const issue = (provider: ChatProvider) => chatProviderAccessIssue(provider,
    { cloudAuth: auth, cloudEntitlement: entitlement, codexHealth: health }, quoteSnapshot, dshSnapshot);
  const cloudPrice = quote?.dsh_vps_v2_available && quote.available && quote.unit_cost === 0 ? `${quote.unit_cost} Bcoin` : null;
  return { quote, cloudPrice, error, dsh, dshError, balance: entitlement ? balance : null, loggedIn: !!auth?.logged_in, retry: refreshChatCapabilities, setup: setupChatDsh,
    issue, reason: (provider: ChatProvider) => issue(provider)?.message ?? null };
}

export function ChatDshSetupDialog({ access, onClose }: {
  access: ReturnType<typeof useChatProviderAccess>; onClose: () => void;
}) {
  const [url, setUrl] = useState(access.dsh?.localUrl ?? "http://127.0.0.1:3080");
  const [authUrl, setAuthUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  async function setup() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const status = await access.setup({ mode: "local", url: url.trim(), ...(authUrl.trim() ? { authUrl: authUrl.trim() } : {}) });
      // Keep the dialog open when the connection works but still needs a DSH restart, so the
      // note is actually read before it closes.
      if (status.localAvailable && !status.localNote) onClose();
      else if (!status.localAvailable) setError(userErrorMessage(status.localReason, "本机 DSH 暂未就绪，请重试。"));
    } catch (reason) { setError(userErrorMessage(reason, "DSH 设置未完成，请重试。")); }
    finally { setBusy(false); }
  }
  return <ModalShell title="DSH 设置" onClose={onClose} preventClose={busy} footer={<>
    <button type="button" className="app-modal-button" disabled={busy} onClick={onClose}>取消</button>
    <button type="button" className="app-modal-button is-primary" disabled={busy || !url.trim()} onClick={() => void setup()}>{busy ? "正在连接…" : "连接"}</button>
  </>}>
    <fieldset disabled={busy} className="space-y-4">
        <div><label htmlFor={`${id}-url`} className="text-sm">服务地址</label><input id={`${id}-url`} className="app-form-input mt-2 px-3 text-sm" type="url" value={url} onChange={event => setUrl(event.target.value)} spellCheck={false} /></div>
        <div><label htmlFor={`${id}-auth`} className="text-sm">登录链接（可选）</label><input id={`${id}-auth`} className="app-form-input mt-2 px-3 text-sm" type="password" autoComplete="off" value={authUrl} onChange={event => setAuthUrl(event.target.value)} spellCheck={false} /></div>
      {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
      {access.dsh?.localAvailable && access.dsh.localNote && <p className="text-sm text-amber-200">{access.dsh.localNote}</p>}
    </fieldset>
  </ModalShell>;
}

export function ChatProviderSelect({ value, onChange, access, disabled }: {
  value: ChatProvider; onChange?: (provider: ChatProvider) => void; access: ReturnType<typeof useChatProviderAccess>; disabled?: boolean;
}) {
  const cloud = chatUsesCloud(value);
  const [settings, setSettings] = useState(false);
  return <><ModelSelect value={value} kind="对话" label={CHAT_PROVIDER_LABELS[value]} source={cloud ? "cloud" : "personal"}
    quotaDetail={cloud ? access.cloudPrice ?? "Bowerbird Bcoin" : value === "dsh-local" ? "使用本机 DSH 的登录配置" : "使用本机 Codex 的自有订阅额度"}
    options={CHAT_PROVIDERS.map(provider => ({ key: provider, label: CHAT_PROVIDER_LABELS[provider],
      source: chatUsesCloud(provider) ? "cloud" : "personal", reason: disabled ? "正在发送，请稍候"
        : !onChange && provider !== value ? "此处无法切换服务" : access.reason(provider) ?? undefined }))}
    onChange={key => { if (isChatProvider(key)) onChange?.(key); }}
    cloudBalance={access.balance} cloudLoggedIn={access.loggedIn}
    footer={closeMenu => <div className="flex items-center justify-between gap-3"><button type="button" disabled={disabled} onClick={() => { closeMenu(); setSettings(true); }}>DSH 设置</button>
      {access.cloudPrice}<button type="button" onClick={access.retry}>重新检查</button></div>} />
    {settings && <ChatDshSetupDialog access={access} onClose={() => setSettings(false)} />}</>;
}
