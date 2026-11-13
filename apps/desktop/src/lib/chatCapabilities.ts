import { createStore } from "zustand";
import { useStore } from "../store";
import { localChat, chatProviderUnavailable, type ChatProvider, type ChatDshSetup } from "./localChat";
import { generationProviderIssue, type GenerationAvailabilityState, type ProviderIssue } from "./generationAvailability";
import { canUseByo, effectivePolicy } from "./entitlement";
import type { AuthSnapshot } from "./types";
import { userErrorMessage } from "./userError";

// One snapshot per capability for this application session. Changing scope
// drops the previous account's value and invalidates any late response.
type Scope = string | AuthSnapshot | null;

function capability<T>(load: () => Promise<T>, fallback: string) {
  const store = createStore<{ key: Scope; value: T | null; error: string | null; pending: boolean }>(
    () => ({ key: null, value: null, error: null, pending: false }),
  );
  let revision = 0;
  function check(key: Scope, refresh = false) {
    const current = store.getState();
    if (current.key === key && (!refresh || current.pending || key === null)) return;
    const request = ++revision;
    store.setState({ key, value: key === current.key ? current.value : null, pending: key !== null, error: null });
    if (key === null) return;
    void load().then(value => {
      if (request === revision) store.setState({ value, pending: false });
    }).catch(reason => {
      if (request === revision) store.setState({ value: null, error: userErrorMessage(reason, fallback), pending: false });
    });
  }
  function replace(key: string, value: T) {
    ++revision;
    store.setState({ key, value, error: null, pending: false });
  }
  return { store, check, replace };
}

export const codexModelCatalog = capability(localChat.models, "Codex 模型列表读取失败，请重试。");
export const chatDshStatus = capability(localChat.dshStatus, "DSH 状态暂不可用，请重试。");
export const chatQuote = capability(localChat.quote, "Cloud 对话报价暂不可用，请重试。");

/** The selector, send button and workflow must use the same active chat service. */
export function chatProviderAccessIssue(provider: ChatProvider, state: Omit<GenerationAvailabilityState, "dreaminaHealth">,
  quote = chatQuote.store.getState(), dsh = chatDshStatus.store.getState()): ProviderIssue | null {
  if (provider === "codex-local") return generationProviderIssue("codex", { ...state, dreaminaHealth: null });
  const { cloudAuth: auth, cloudEntitlement: entitlement } = state;
  const balances = entitlement?.balances;
  const message = (provider === "dsh-cloud" ? quote.error : dsh.error) ?? chatProviderUnavailable(provider, {
    cloudAvailable: !!auth?.cloud_available, loggedIn: !!auth?.logged_in, cloudAllowed: effectivePolicy(entitlement).can_use_cloud,
    localAllowed: canUseByo(entitlement), codexReady: !!state.codexHealth?.ok, balance: balances ? balances.daily + balances.sub + balances.topup : 0,
  }, quote.value, dsh.value);
  if (!message) return null;
  return { message, ...(provider === "dsh-cloud" && auth?.cloud_available && !auth.logged_in || provider === "dsh-local" && !canUseByo(entitlement) ? { settings: "account" as const } : {}) };
}

function checkChatCapabilities(refresh = false) {
  const { cloudAuth, codexHealth } = useStore.getState();
  chatDshStatus.check("local", refresh);
  codexModelCatalog.check(codexHealth?.ok ? "local" : null, refresh);
  // Older sessions can have a token with no user ID. In that case a replacement
  // auth snapshot must fetch its own quote, even when both snapshots lack an ID.
  chatQuote.check(cloudAuth?.logged_in && cloudAuth.cloud_available ? cloudAuth.user_id ?? cloudAuth : null, refresh);
}

export function refreshChatCapabilities() { checkChatCapabilities(true); }

export function startChatCapabilityChecks() {
  checkChatCapabilities();
  return useStore.subscribe((next, previous) => {
    if (next.cloudAuth !== previous.cloudAuth || next.codexHealth !== previous.codexHealth) checkChatCapabilities();
  });
}

export async function setupChatDsh(input: ChatDshSetup) {
  const status = await localChat.dshSetup(input);
  chatDshStatus.replace("local", status);
  return status;
}
