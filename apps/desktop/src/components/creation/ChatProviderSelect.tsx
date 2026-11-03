import { useEffect, useState } from "react";
import { useStore } from "../../store";
import { canUseByo, effectivePolicy } from "../../lib/entitlement";
import { CHAT_PROVIDER_LABELS, chatProviderUnavailable, localChat, type ChatProvider, type ChatQuote } from "../../lib/localChat";
import { userErrorMessage } from "../../lib/userError";
import { ModelSelect } from "./ModelSelect";

export function useChatProviderAccess(active: boolean) {
  const auth = useStore(state => state.cloudAuth);
  const entitlement = useStore(state => state.cloudEntitlement);
  const health = useStore(state => state.codexHealth);
  const [quote, setQuote] = useState<ChatQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, retry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setQuote(null); setError(null);
    if (active && auth?.cloud_available && auth.logged_in) localChat.quote()
      .then(value => { if (!cancelled) setQuote(value); })
      .catch(reason => { if (!cancelled) setError(userErrorMessage(reason, "Cloud 对话报价暂不可用，请重试。")); });
    return () => { cancelled = true; };
  }, [active, auth?.cloud_available, auth?.logged_in, auth?.user_id, attempt]);
  const balance = entitlement ? entitlement.balances.daily + entitlement.balances.sub + entitlement.balances.topup : 0;
  const state = { cloudAvailable: !!auth?.cloud_available, loggedIn: !!auth?.logged_in,
    cloudAllowed: effectivePolicy(entitlement).can_use_cloud, localAllowed: canUseByo(entitlement), codexReady: !!health?.ok, balance };
  return { quote, error, balance: entitlement ? balance : null, loggedIn: state.loggedIn, retry: () => retry(value => value + 1),
    reason: (provider: ChatProvider) => provider === "deepseek-cloud" && error ? error : chatProviderUnavailable(provider, state, quote) };
}

export function ChatProviderSelect({ value, onChange, access, disabled }: {
  value: ChatProvider; onChange?: (provider: ChatProvider) => void; access: ReturnType<typeof useChatProviderAccess>; disabled?: boolean;
}) {
  const cloud = value === "deepseek-cloud";
  const quoted = access.quote?.available && access.quote.unit_cost === 0;
  return <ModelSelect value={value} kind="对话" label={CHAT_PROVIDER_LABELS[value]} source={cloud ? "cloud" : "personal"}
    quotaDetail={cloud ? quoted ? `${access.quote!.unit_cost} Bcoin` : "Bowerbird Bcoin" : "使用本机 Codex 的自有订阅额度"}
    options={(["codex-local", "deepseek-cloud"] as const).map(provider => ({ key: provider, label: CHAT_PROVIDER_LABELS[provider],
      source: provider === "deepseek-cloud" ? "cloud" : "personal", reason: disabled ? "正在发送，请稍候" : access.reason(provider) ?? undefined }))}
    onChange={key => { if (key === "codex-local" || key === "deepseek-cloud") onChange?.(key); }}
    cloudBalance={access.balance} cloudLoggedIn={access.loggedIn}
    footer={access.error ? <button type="button" onClick={access.retry}>重新获取报价</button>
      : quoted ? `DeepSeek · ${access.quote!.unit_cost} Bcoin` : undefined} />;
}
