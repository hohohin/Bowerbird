import { useStore as useSnapshot } from "zustand";
import { useStore } from "../../store";
import { CHAT_PROVIDERS, CHAT_PROVIDER_LABELS, chatUsesCloud, isChatProvider, type ChatProvider } from "../../lib/localChat";
import { chatDshStatus, chatProviderAccessIssue, chatQuote, refreshChatCapabilities } from "../../lib/chatCapabilities";
import { canUseByo } from "../../lib/entitlement";
import { ModelSelect } from "./ModelSelect";

export function useChatProviderAccess() {
  const auth = useStore(state => state.cloudAuth);
  const entitlement = useStore(state => state.cloudEntitlement);
  const health = useStore(state => state.codexHealth);
  const quoteSnapshot = useSnapshot(chatQuote.store);
  const dshSnapshot = useSnapshot(chatDshStatus.store);
  const { value: quote, error } = quoteSnapshot;
  const { value: dsh } = dshSnapshot;
  const balance = entitlement ? entitlement.balances.daily + entitlement.balances.sub + entitlement.balances.topup : 0;
  const issue = (provider: ChatProvider) => chatProviderAccessIssue(provider,
    { cloudAuth: auth, cloudEntitlement: entitlement, codexHealth: health }, quoteSnapshot, dshSnapshot);
  const cloudPrice = quote?.dsh_vps_v2_available && quote.available && quote.unit_cost === 0 ? `${quote.unit_cost} Bcoin` : null;
  return { quote, cloudPrice, error, dsh, localAllowed: canUseByo(entitlement), balance: entitlement ? balance : null, loggedIn: !!auth?.logged_in, retry: refreshChatCapabilities,
    issue, reason: (provider: ChatProvider) => issue(provider)?.message ?? null };
}

export function ChatProviderSelect({ value, onChange, access, disabled }: {
  value: ChatProvider; onChange?: (provider: ChatProvider) => void; access: ReturnType<typeof useChatProviderAccess>; disabled?: boolean;
}) {
  const cloud = chatUsesCloud(value);
  return <ModelSelect value={value} kind="对话" label={CHAT_PROVIDER_LABELS[value]} source={cloud ? "cloud" : "personal"}
    quotaDetail={cloud ? access.cloudPrice ?? "Bowerbird Bcoin" : value === "dsh-local" ? "使用本机 DSH 的登录配置" : "使用本机 Codex 的自有订阅额度"}
    options={CHAT_PROVIDERS.map(provider => ({ key: provider, label: CHAT_PROVIDER_LABELS[provider],
      source: chatUsesCloud(provider) ? "cloud" : "personal", reason: disabled ? "正在发送，请稍候"
        : !onChange && provider !== value ? "此处无法切换服务" : access.reason(provider) ?? undefined }))}
    onChange={key => { if (isChatProvider(key)) onChange?.(key); }}
    cloudBalance={access.balance} cloudLoggedIn={access.loggedIn} />;
}
