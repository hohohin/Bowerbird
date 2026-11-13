import { canUseGenerationProvider } from "./entitlement";
import { cloudGenProviders, isCloudProvider, normalizeGenerationProvider } from "./genProviders";
import type { AuthSnapshot, CodexHealth, EntitlementSnapshot } from "./types";

export interface GenerationAvailabilityState {
  cloudAuth: AuthSnapshot | null;
  cloudEntitlement: EntitlementSnapshot | null;
  codexHealth: CodexHealth | null;
  dreaminaHealth: CodexHealth | null;
}

export interface ProviderIssue {
  message: string;
  settings?: "jimeng" | "codex" | "account";
}

export function cloudAccountIssue(auth: AuthSnapshot | null): ProviderIssue | null {
  if (!auth) return { message: "正在检查 Bowerbird 账号状态…" };
  if (!auth.cloud_available) return { message: "当前版本未配置 Bowerbird Cloud，请切换生成方式。" };
  return auth.logged_in ? null : { message: "尚未登录 Bowerbird 账号，请先登录。", settings: "account" };
}

/** Evaluate the provider that the request will actually submit, including saved defaults. */
export function generationProviderIssue(requestedProvider: string, state: GenerationAvailabilityState): ProviderIssue | null {
  const provider = normalizeGenerationProvider(requestedProvider);
  const { cloudAuth, cloudEntitlement } = state;
  if (isCloudProvider(provider)) {
    const access = cloudAccountIssue(cloudAuth);
    if (access) return access;
    if (!cloudEntitlement) return { message: "Bowerbird 账号权益尚未就绪，请刷新权益。", settings: "account" };
    if (!canUseGenerationProvider(cloudEntitlement, provider)) return { message: "当前账号未开通云端生成，请检查账号权益。", settings: "account" };
    const { daily, sub, topup } = cloudEntitlement.balances;
    if (daily + sub + topup <= 0) return { message: "Bcoin 积分不足，请补充积分或切换生成方式。", settings: "account" };
    // The entitlement model list covers images only. Video pricing is checked separately.
    if (!provider.startsWith("bowerbird-cloud-video_seedance25_")) {
      if (!cloudGenProviders(cloudEntitlement).some(model => model.key === provider)) return { message: "当前云端图片模型不可用，请重新选择模型。" };
      const service = cloudEntitlement.generation_services?.find(entry => `bowerbird-cloud-${entry.service}` === provider);
      if (service && daily + sub + topup < service.credits) return { message: `此模型至少需要 ${service.credits} Bcoin，积分不足。`, settings: "account" };
    }
    return null;
  }
  const jimeng = provider === "jimeng";
  if (!jimeng && provider !== "codex") return { message: "此生成方式不可用，请重新选择模型。" };
  if (!cloudEntitlement) return { message: "账号权益尚未就绪，请检查账号状态。", settings: "account" };
  if (!canUseGenerationProvider(cloudEntitlement, provider)) return { message: "自有订阅需要 Pro 或 Studio 权益，请检查当前账号方案。", settings: "account" };
  const health = jimeng ? state.dreaminaHealth : state.codexHealth;
  if (health?.ok) return null;
  const name = jimeng ? "即梦" : "ChatGPT";
  const settings = jimeng ? "jimeng" : "codex";
  if (!health) return { message: `正在检查${name}自有订阅状态…` };
  if (/未检测到(?:可用的)?\s*(?:dreamina|codex|即梦\s*CLI)|未安装|not installed/i.test(health.reason)) {
    return { message: `${name}自有订阅的本机工具尚未安装，请先配置。`, settings };
  }
  if (/未登录|未检测到有效登录态|登录.*(?:失效|过期)|not logged in|unauthorized|please log\s?in/i.test(health.reason)) {
    return { message: `${name}自有订阅未登录，请先登录授权。`, settings };
  }
  if (/检查网络|网络超时/.test(health.reason)) return { message: `暂时无法确认${name}自有订阅状态，请检查网络后重新检测。`, settings };
  return { message: `${name}自有订阅未就绪，请在设置中重新检测。`, settings };
}
