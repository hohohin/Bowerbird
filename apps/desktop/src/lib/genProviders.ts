import type { EntitlementSnapshot } from "../lib/types";

export interface GenProviderOption {
  key: string;
  label: string;
}

/** 本地 BYO 引擎（CLI 子进程，随客户端发布，不参与云端动态档位）。 */
export const BYO_PROVIDERS: readonly GenProviderOption[] = [
  { key: "codex", label: "codex" },
  { key: "jimeng", label: "即梦" },
];

/**
 * 云端档位兜底（与服务端 0018 的 service_costs 种子对齐）：entitlement 未提供
 * generation_services 时（离线/旧 Edge）用它渲染，保证下拉永远可用。
 */
export const DEFAULT_CLOUD_PROVIDERS: readonly GenProviderOption[] = [
  { key: "bowerbird-cloud-image_hd", label: "Bowerbird Cloud Pro" },
  { key: "bowerbird-cloud-image_fast", label: "Bowerbird Cloud Fast" },
  { key: "bowerbird-cloud-image_lite", label: "Bowerbird Cloud Lite" },
];

/** 遗留 provider key → 展示标签（动态档位之前的持久化 job/turn 会带这些 key）。 */
const LEGACY_CLOUD_LABELS: Record<string, string> = {
  "bowerbird-cloud": "Bowerbird Cloud Pro",
  "bowerbird-cloud-fast": "Bowerbird Cloud Fast",
  "bowerbird-cloud-lite": "Bowerbird Cloud Lite",
  "bowerbird-cloud-standard": "Bowerbird Cloud Lite",
};

/** 是否 Cloud 生图档位（key 前缀约定，含全部遗留与动态 key）。 */
export function isCloudProvider(provider: string | null | undefined): boolean {
  return !!provider && provider.startsWith("bowerbird-cloud");
}

/** Bowerbird Cloud Pro：`image_hd` 档，兼容旧 `bowerbird-cloud` 键。 */
export function isCloudProProvider(provider: string | null | undefined): boolean {
  return isCloudProvider(provider) && canonicalProviderKey(provider!) === "bowerbird-cloud-image_hd";
}

/** 是否按官方紧凑坐标格式发送标注：即梦与 Cloud Pro 支持，其余 provider 只保留“标记位置”。 */
export function supportsAnnotationCoordinates(provider: string | null | undefined): boolean {
  return provider === "jimeng" || provider === "dreamina" || isCloudProProvider(provider);
}

/** 云端动态档位（key = `bowerbird-cloud-<service>`）；云端未提供时用内置兜底。 */
export function cloudGenProviders(
  entitlement: EntitlementSnapshot | null,
): GenProviderOption[] {
  const services = entitlement?.generation_services;
  if (!services?.length) return [...DEFAULT_CLOUD_PROVIDERS];
  return services.map((s) => ({ key: `bowerbird-cloud-${s.service}`, label: s.label }));
}

/** 完整下拉列表：本地 BYO 在前，云端档位在后。 */
export function genProviders(entitlement: EntitlementSnapshot | null): GenProviderOption[] {
  return [...BYO_PROVIDERS, ...cloudGenProviders(entitlement)];
}

/** 是否已知 provider key（BYO 枚举或任意 cloud 档位 key——云端上新档位后无需改这里）。 */
export function isKnownGenProvider(key: string): boolean {
  if (BYO_PROVIDERS.some((p) => p.key === key)) return true;
  return isCloudProvider(key);
}

/** Cloud 档位展示标签；非 cloud provider 返回 null。历史 key 走静态回退。 */
export function cloudProviderLabel(
  provider: string | null | undefined,
  entitlement: EntitlementSnapshot | null = null,
): string | null {
  if (!isCloudProvider(provider)) return null;
  const entry = cloudGenProviders(entitlement).find((p) => p.key === provider);
  if (entry) return entry.label;
  return LEGACY_CLOUD_LABELS[provider!] ?? "Bowerbird Cloud";
}

/**
 * 遗留 cloud key 归一化为动态 key（`bowerbird-cloud-<service>`），供 localStorage
 * 默认值与编辑坞初值使用；非 cloud key 原样返回。
 */
export function canonicalProviderKey(key: string): string {
  if (!isCloudProvider(key)) return key;
  if (key === "bowerbird-cloud") return "bowerbird-cloud-image_hd";
  if (key === "bowerbird-cloud-fast") return "bowerbird-cloud-image_fast";
  if (key === "bowerbird-cloud-lite" || key === "bowerbird-cloud-standard") {
    return "bowerbird-cloud-image_lite";
  }
  return key;
}
