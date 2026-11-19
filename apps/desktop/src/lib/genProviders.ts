import type { EntitlementSnapshot } from "../lib/types";

export interface GenProviderOption {
  key: string;
  label: string;
}

export const H3_IMAGE = "minimax-h3-image";
const DREAMINA_MODELS = [
  { key: "dreamina-web55", label: "Seedream 5.5" },
  { key: "dreamina-web50pro", label: "Seedream 5.0 Pro" },
  { key: "dreamina-web50flash", label: "Seedream 5.0 Flash" },
  { key: "dreamina-web50lite", label: "Seedream 5.0 Lite" },
  { key: "dreamina-web47", label: "Seedream 4.7" },
  { key: "dreamina-web40", label: "Seedream 4.0" },
];
const SELECTABLE_DREAMINA = DREAMINA_MODELS.filter(model => !["dreamina-web50flash", "dreamina-web50lite"].includes(model.key));
export function restoredImageProvider(provider: string, version?: string | null): string {
  if ((provider === "jimeng" || provider === "dreamina") && version)
    return SELECTABLE_DREAMINA.find(model => dreaminaCliVersion(model.key) === version)?.key ?? provider;
  return provider;
}
export function dreaminaCliVersion(key: string): string | undefined {
  return ({ "dreamina-web50pro": "5.0Pro", "dreamina-web47": "4.7", "dreamina-web40": "4.0" } as Record<string, string>)[key];
}
export function dreaminaWebModel(key: string | null | undefined) {
  return DREAMINA_MODELS.find(model => model.key === key);
}
const H3_IMAGE_OPTION = { key: H3_IMAGE, label: "MiniMax-H3-Image" };

/** 本地 BYO 引擎（CLI 子进程，随客户端发布，不参与云端动态档位）。 */
export const BYO_PROVIDERS: readonly GenProviderOption[] = [
  { key: "codex", label: "gpt-image-2" },
  { key: "jimeng", label: "Seedream 5.0 Pro" },
  H3_IMAGE_OPTION,
  ...SELECTABLE_DREAMINA,
];

/**
 * 云端档位兜底（与服务端 0018 的 service_costs 种子对齐）：entitlement 未提供
 * generation_services 时（离线/旧 Edge）用它渲染，保证下拉永远可用。
 */
export const DEFAULT_CLOUD_PROVIDERS: readonly GenProviderOption[] = [
  { key: "bowerbird-cloud-image_hd", label: "Seedream 5.0 Pro" },
  { key: "bowerbird-cloud-image_lite", label: "Seedream 5.0 Lite" },
];

/** 遗留 provider key → 展示标签（动态档位之前的持久化 job/turn 会带这些 key）。 */
const LEGACY_CLOUD_LABELS: Record<string, string> = {
  "bowerbird-cloud-image_seedream55": "Seedream 5.5",
  "bowerbird-cloud-image_seedream55_1k": "Seedream 5.5 1K",
  "bowerbird-cloud-image_seedream55_15k": "Seedream 5.5 1.5K",
  "bowerbird-cloud-image_hd": "Seedream 5.0 Pro",
  "bowerbird-cloud-image_fast": "Seedream 5.0 Pro · 快速",
  "bowerbird-cloud-image_lite": "Seedream 5.0 Lite",
  "bowerbird-cloud-image_sd": "Seedream 5.0 Lite",
  "bowerbird-cloud-image_gpt25_sunburst": "gpt-image-2.5-sunburst",
  "bowerbird-cloud-image_gpt25_flare": "gpt-image-2.5-flare",
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
  return provider === "jimeng" || provider === "dreamina" || !!dreaminaCliVersion(provider ?? "") || isCloudProProvider(provider)
    || ["bowerbird-cloud-image_seedream55", "bowerbird-cloud-image_seedream55_1k", "bowerbird-cloud-image_seedream55_15k"].includes(provider ?? "");
}

/** Only select 5.5 after the server advertises it as active. */
export function defaultCloudProvider(entitlement: EntitlementSnapshot | null): string {
  return entitlement?.generation_services?.some(s => s.service === "image_seedream55")
    ? "bowerbird-cloud-image_seedream55" : "bowerbird-cloud-image_hd";
}

/** 云端动态档位（key = `bowerbird-cloud-<service>`）；云端未提供时用内置兜底。 */
export function cloudGenProviders(
  entitlement: EntitlementSnapshot | null,
): GenProviderOption[] {
  const services = entitlement?.generation_services;
  if (!services?.length) return [...DEFAULT_CLOUD_PROVIDERS];
  return services.filter(s => s.service !== "image_fast").map((s) => {
    const key = `bowerbird-cloud-${s.service}`;
    return { key, label: LEGACY_CLOUD_LABELS[key] ?? s.label };
  });
}

/** 完整下拉列表：本地 BYO 在前，云端档位在后。 */
export function genProviders(entitlement: EntitlementSnapshot | null): GenProviderOption[] {
  return [BYO_PROVIDERS[0], ...SELECTABLE_DREAMINA, ...cloudGenProviders(entitlement), H3_IMAGE_OPTION];
}

/** 是否已知 provider key（BYO 枚举或任意 cloud 档位 key——云端上新档位后无需改这里）。 */
export function isKnownGenProvider(key: string): boolean {
  if (BYO_PROVIDERS.some((p) => p.key === key) || dreaminaWebModel(key)) return true;
  return isCloudProvider(key);
}

/** Cloud 档位展示标签；非 cloud provider 返回 null。历史 key 走静态回退。 */
export function cloudProviderLabel(
  provider: string | null | undefined,
  entitlement: EntitlementSnapshot | null = null,
): string | null {
  if (!isCloudProvider(provider)) return null;
  const key = canonicalProviderKey(provider!);
  if (LEGACY_CLOUD_LABELS[key]) return LEGACY_CLOUD_LABELS[key];
  const entry = cloudGenProviders(entitlement).find((p) => p.key === key);
  if (entry) return entry.label;
  return "Bowerbird Cloud";
}

export function dreaminaModelLabel(version = "5.0Pro"): string {
  return `Seedream ${version.replace(/(pro|lite)$/i, suffix => ` ${suffix.toLowerCase() === "pro" ? "Pro" : "Lite"}`)}`;
}

/** Display names only; routing keys and stored history remain unchanged. */
export function imageProviderLabel(provider: string | null | undefined, entitlement: EntitlementSnapshot | null = null, dreaminaVersion: string | null = "5.0Pro"): string {
  if (provider === H3_IMAGE) return H3_IMAGE_OPTION.label;
  if (provider === "comfy-h3") return "本地 H3 视频";
  const webModel = dreaminaWebModel(provider);
  if (webModel) return webModel.label;
  if (provider === "codex" || provider === "codex-cli") return "gpt-image-2";
  if (provider === "jimeng" || provider === "dreamina") return dreaminaVersion ? dreaminaModelLabel(dreaminaVersion) : "Seedream · 即梦";
  return cloudProviderLabel(provider, entitlement) ?? provider ?? "模型未记录";
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

/** Resolve legacy session keys for display, readiness checks and new submissions. */
export function normalizeGenerationProvider(provider: string): string {
  if (provider === "dreamina") return "jimeng";
  if (provider === "codex-cli" || provider === "default" || !provider) return "codex";
  return canonicalProviderKey(provider);
}
