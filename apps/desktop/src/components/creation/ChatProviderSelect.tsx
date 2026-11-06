import { useEffect, useId, useState } from "react";
import { useStore } from "../../store";
import { canUseByo, effectivePolicy } from "../../lib/entitlement";
import { CHAT_PROVIDERS, CHAT_PROVIDER_LABELS, chatProviderUnavailable, chatUsesCloud, isChatProvider, localChat, type ChatDshSetup, type ChatDshStatus, type ChatProvider, type ChatQuote } from "../../lib/localChat";
import { userErrorMessage } from "../../lib/userError";
import { ModelSelect } from "./ModelSelect";
import { ModalShell } from "../ModalShell";

export function useChatProviderAccess(active: boolean) {
  const auth = useStore(state => state.cloudAuth);
  const entitlement = useStore(state => state.cloudEntitlement);
  const health = useStore(state => state.codexHealth);
  const [quote, setQuote] = useState<ChatQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dsh, setDsh] = useState<ChatDshStatus | null>(null);
  const [dshError, setDshError] = useState<string | null>(null);
  const [attempt, retry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setQuote(null); setError(null);
    if (active && auth?.cloud_available && auth.logged_in) localChat.quote()
      .then(value => { if (!cancelled) setQuote(value); })
      .catch(reason => { if (!cancelled) setError(userErrorMessage(reason, "Cloud 对话报价暂不可用，请重试。")); });
    return () => { cancelled = true; };
  }, [active, auth?.cloud_available, auth?.logged_in, auth?.user_id, attempt]);
  useEffect(() => {
    let cancelled = false;
    setDshError(null);
    if (active) localChat.dshStatus()
      .then(value => { if (!cancelled) setDsh(value); })
      .catch(reason => { if (!cancelled) { setDsh(null); setDshError(userErrorMessage(reason, "DSH 状态暂不可用，请重试。")); } });
    return () => { cancelled = true; };
  }, [active, attempt]);
  const balance = entitlement ? entitlement.balances.daily + entitlement.balances.sub + entitlement.balances.topup : 0;
  const state = { cloudAvailable: !!auth?.cloud_available, loggedIn: !!auth?.logged_in,
    cloudAllowed: effectivePolicy(entitlement).can_use_cloud, localAllowed: canUseByo(entitlement), codexReady: !!health?.ok, balance };
  return { quote, error, dsh, dshError, balance: entitlement ? balance : null, loggedIn: state.loggedIn, retry: () => retry(value => value + 1),
    setup: async (input: ChatDshSetup) => { const value = await localChat.dshSetup(input); setDsh(value); setDshError(null); return value; },
    reason: (provider: ChatProvider) => chatUsesCloud(provider) && error ? error
      : chatProviderUnavailable(provider, state, quote, dsh) ?? ((provider === "dsh-local" || provider === "dsh-cloud") ? dshError : null) };
}

export function ChatDshSetupDialog({ access, initialMode, onClose }: {
  access: ReturnType<typeof useChatProviderAccess>; initialMode: "local" | "managed"; onClose: () => void;
}) {
  const [mode, setMode] = useState(initialMode);
  const [url, setUrl] = useState(access.dsh?.localUrl ?? "http://127.0.0.1:3080");
  const [authUrl, setAuthUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  async function setup() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const status = await access.setup({ mode, ...(mode === "local" ? { url: url.trim(), ...(authUrl.trim() ? { authUrl: authUrl.trim() } : {}) } : {}) });
      if (mode === "local" ? status.localAvailable : status.managedAvailable) onClose();
      else setError(userErrorMessage((mode === "local" ? status.localReason : status.managedReason) ?? "DSH 暂未就绪，请重试。", "DSH 暂未就绪，请重试。"));
    } catch (reason) { setError(userErrorMessage(reason, "DSH 设置未完成，请重试。")); }
    finally { setBusy(false); }
  }
  return <ModalShell title="DSH 设置" onClose={onClose} preventClose={busy} footer={<>
    <button type="button" className="app-modal-button" disabled={busy} onClick={onClose}>取消</button>
    <button type="button" className="app-modal-button is-primary" disabled={busy || (mode === "local" && !url.trim())} onClick={() => void setup()}>{busy ? "正在连接…" : mode === "local" ? "连接" : "准备 DSH"}</button>
  </>}>
    <fieldset disabled={busy} className="space-y-4">
      <div className="flex gap-2">{(["local", "managed"] as const).map(value => <button key={value} type="button" className={`app-modal-button${mode === value ? " is-primary" : ""}`} aria-pressed={mode === value} onClick={() => { setMode(value); setError(null); }}>{value === "local" ? "本机 DSH" : "DSH · Cloud"}</button>)}</div>
      {mode === "local" && <>
        <div><label htmlFor={`${id}-url`} className="text-sm">服务地址</label><input id={`${id}-url`} className="app-form-input mt-2 px-3 text-sm" type="url" value={url} onChange={event => setUrl(event.target.value)} spellCheck={false} /></div>
        <div><label htmlFor={`${id}-auth`} className="text-sm">登录链接（可选）</label><input id={`${id}-auth`} className="app-form-input mt-2 px-3 text-sm" type="password" autoComplete="off" value={authUrl} onChange={event => setAuthUrl(event.target.value)} spellCheck={false} /></div>
      </>}
      {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
    </fieldset>
  </ModalShell>;
}

export function ChatProviderSelect({ value, onChange, access, disabled }: {
  value: ChatProvider; onChange?: (provider: ChatProvider) => void; access: ReturnType<typeof useChatProviderAccess>; disabled?: boolean;
}) {
  const cloud = chatUsesCloud(value);
  const [settings, setSettings] = useState(false);
  const quoted = access.quote?.available && access.quote.unit_cost === 0;
  return <><ModelSelect value={value} kind="对话" label={CHAT_PROVIDER_LABELS[value]} source={cloud ? "cloud" : "personal"}
    quotaDetail={cloud ? quoted ? `${access.quote!.unit_cost} Bcoin` : "Bowerbird Bcoin" : value === "dsh-local" ? "使用本机 DSH 的登录配置" : "使用本机 Codex 的自有订阅额度"}
    options={CHAT_PROVIDERS.map(provider => ({ key: provider, label: CHAT_PROVIDER_LABELS[provider],
      source: chatUsesCloud(provider) ? "cloud" : "personal", reason: disabled ? "正在发送，请稍候" : access.reason(provider) ?? undefined }))}
    onChange={key => { if (isChatProvider(key)) onChange?.(key); }}
    cloudBalance={access.balance} cloudLoggedIn={access.loggedIn}
    footer={closeMenu => <div className="flex items-center justify-between gap-3"><button type="button" disabled={disabled} onClick={() => { closeMenu(); setSettings(true); }}>DSH 设置</button>
      {access.error || access.dshError ? <button type="button" onClick={access.retry}>重新检查</button> : quoted ? `${access.quote!.unit_cost} Bcoin` : null}</div>} />
    {settings && <ChatDshSetupDialog access={access} initialMode={value === "dsh-cloud" ? "managed" : "local"} onClose={() => setSettings(false)} />}</>;
}
