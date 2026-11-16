import { createStore } from "zustand";
import { useStore } from "../store";
import { localChat, chatProviderUnavailable, type ChatDshAccount, type ChatProvider, type ChatDshSetup } from "./localChat";
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
  function check(key: Scope, refresh = false, read = load) {
    const current = store.getState();
    if (current.key === key && (!refresh || (current.pending && read === load) || key === null)) return;
    const request = ++revision;
    store.setState({ key, value: key === current.key ? current.value : null, pending: key !== null, error: null });
    if (key === null) return;
    void read().then(value => {
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
export function dshNeedsConfiguration(account: ChatDshAccount) {
  return account.state === "notInstalled" || (account.state !== "verified" && account.modelConfigured === false);
}
async function readDshStatus(knownAccount?: ChatDshAccount) {
  const status = await localChat.dshStatus();
  if (!status.localAvailable || status.localMode !== "auto") return status;
  const account = knownAccount ?? await localChat.dshAccount("status");
  if (dshNeedsConfiguration(account)) {
    return { ...status, localAvailable: false, localReason: "请在模型设置中完成本机 DSH 登录授权或配置可用模型。" };
  }
  return status;
}
export const chatDshStatus = capability(readDshStatus, "DSH 状态暂不可用，请重试。");
export function publishDshAccount(account: ChatDshAccount) {
  // Settings has a newer account result than any pending startup probe.
  chatDshStatus.check("local", true, () => readDshStatus(account));
}
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
  if (provider === "dsh-local") return { message, settings: canUseByo(entitlement) ? "dsh" : "account" };
  return { message, ...(provider === "dsh-cloud" && auth?.cloud_available && !auth.logged_in ? { settings: "account" as const } : {}) };
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

let connecting: { mode: ChatDshSetup["mode"]; result: ReturnType<typeof localChat.dshSetup> } | undefined;
export async function setupChatDsh(input: ChatDshSetup) {
  if (connecting) {
    if (input.mode === "auto" && connecting.mode === "auto") return connecting.result;
    throw new Error("本机 DSH 正在连接，请稍后重试。");
  }
  const result = localChat.dshSetup(input).then(status => {
    chatDshStatus.replace("local", status);
    return status;
  });
  connecting = { mode: input.mode, result };
  try { return await result; } finally { connecting = undefined; }
}
