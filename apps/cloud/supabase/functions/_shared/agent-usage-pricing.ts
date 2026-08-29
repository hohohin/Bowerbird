export type AgentUsageKind = "model_tokens" | "vision_call" | "image_generation" | "html_render";
export type AgentUsageProvider = "deepseek" | "ark" | "jimeng" | "codex" | "renderer";

export type AgentUsageItem = {
  callId: string;
  kind: AgentUsageKind;
  provider: AgentUsageProvider;
  model: string;
  inputUnits: number;
  outputUnits: number;
  imageCount: number;
  resolution?: string;
  providerCostMicros?: number;
};

/** 上游成本的版本化估算费率（micro CNY）。块缺失时为 null：usage 落库不估算成本，
 *  只保留 worker 显式上报值。费率由 service_costs.parameters.provider_cost 提供，
 *  运营核对刊例价后可直接 UPDATE，无需改代码。 */
export type AgentProviderCostRates = {
  currency: "CNY";
  deepseekInputMicrosPerMillionTokens: number;
  deepseekOutputMicrosPerMillionTokens: number;
  arkVisionMicrosPerCall: number;
  imageMicrosPerImage: Record<"ark" | "jimeng" | "codex", number>;
};

export type AgentUsagePricing = {
  version: number;
  modelTokens: {
    provider: "deepseek";
    inputTokensPerCredit: number;
    outputTokensPerCredit: number;
    minimumCredits: number;
  };
  visionCall: { provider: "ark"; creditsPerCall: number };
  imageGeneration: Record<"ark" | "jimeng" | "codex", number>;
  /** 可选块：HTML 离线渲染计价（HTML-RENDER-PLAN §7.3 首版 0 积分；缺省视为 0，向后兼容旧费率行）。 */
  htmlRender?: { creditsPerCall: number };
  providerCost: AgentProviderCostRates | null;
};

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("agent_usage_pricing_invalid");
  return value as JsonRecord;
}

function positiveInt(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("agent_usage_pricing_invalid");
  return parsed;
}

function nonnegativeInt(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("agent_usage_pricing_invalid");
  return parsed;
}

function parseProviderCost(value: unknown): AgentProviderCostRates | null {
  // Optional block: absent/null keeps cost estimation off (backward compatible).
  if (value === undefined || value === null) return null;
  const root = record(value);
  if (root.currency !== "CNY") throw new Error("agent_usage_pricing_invalid");
  const image = record(root.image_micros_per_image);
  return {
    currency: "CNY",
    deepseekInputMicrosPerMillionTokens: nonnegativeInt(root.deepseek_input_micros_per_million_tokens),
    deepseekOutputMicrosPerMillionTokens: nonnegativeInt(root.deepseek_output_micros_per_million_tokens),
    arkVisionMicrosPerCall: nonnegativeInt(root.ark_vision_micros_per_call),
    imageMicrosPerImage: {
      ark: nonnegativeInt(image.ark),
      jimeng: nonnegativeInt(image.jimeng),
      codex: nonnegativeInt(image.codex),
    },
  };
}

export function agentUsageService(pricingVersion: number): string {
  if (!Number.isSafeInteger(pricingVersion) || pricingVersion <= 0) throw new Error("agent_usage_pricing_version_invalid");
  return `agent_usage_v${pricingVersion}`;
}

export function parseAgentUsagePricing(parameters: unknown, pricingVersion: number): AgentUsagePricing {
  const root = record(parameters);
  const model = record(root.model_tokens);
  const vision = record(root.vision_call);
  const image = record(root.image_generation);
  if (root.billing !== "agent_usage" || model.provider !== "deepseek" || vision.provider !== "ark") {
    throw new Error("agent_usage_pricing_invalid");
  }
  let htmlRender: AgentUsagePricing["htmlRender"];
  if (root.html_render !== undefined && root.html_render !== null) {
    htmlRender = { creditsPerCall: nonnegativeInt(record(root.html_render).credits_per_call) };
  }
  return {
    version: positiveInt(pricingVersion),
    modelTokens: {
      provider: "deepseek",
      inputTokensPerCredit: positiveInt(model.input_tokens_per_credit),
      outputTokensPerCredit: positiveInt(model.output_tokens_per_credit),
      minimumCredits: positiveInt(model.minimum_credits),
    },
    visionCall: { provider: "ark", creditsPerCall: positiveInt(vision.credits_per_call) },
    imageGeneration: {
      ark: positiveInt(image.ark),
      jimeng: nonnegativeInt(image.jimeng),
      codex: nonnegativeInt(image.codex),
    },
    ...(htmlRender ? { htmlRender } : {}),
    providerCost: parseProviderCost(root.provider_cost),
  };
}

export function normalizeAgentUsageItem(raw: unknown): AgentUsageItem {
  const item = record(raw);
  const callId = typeof item.callId === "string" ? item.callId : "";
  const kind = item.kind;
  const provider = item.provider;
  const model = typeof item.model === "string" ? item.model.trim() : "";
  const inputUnits = Number(item.inputUnits ?? 0);
  const outputUnits = Number(item.outputUnits ?? 0);
  const imageCount = Number(item.imageCount ?? 0);
  if (!callId || callId.length > 160 ||
      !["model_tokens", "vision_call", "image_generation", "html_render"].includes(String(kind)) ||
      !["deepseek", "ark", "jimeng", "codex", "renderer"].includes(String(provider)) || !model || model.length > 120 ||
      !Number.isSafeInteger(inputUnits) || inputUnits < 0 || inputUnits > 10_000_000 ||
      !Number.isSafeInteger(outputUnits) || outputUnits < 0 || outputUnits > 10_000_000 ||
      !Number.isSafeInteger(imageCount) || imageCount < 0 || imageCount > 8) {
    throw new Error("agent_usage_item_invalid");
  }
  const resolution = typeof item.resolution === "string" && item.resolution.trim()
    ? item.resolution.trim().slice(0, 40)
    : undefined;
  const providerCostMicros = item.providerCostMicros === undefined ? undefined : Number(item.providerCostMicros);
  if (providerCostMicros !== undefined && (!Number.isSafeInteger(providerCostMicros) || providerCostMicros < 0)) {
    throw new Error("agent_usage_item_invalid");
  }
  return {
    callId,
    kind: kind as AgentUsageKind,
    provider: provider as AgentUsageProvider,
    model,
    inputUnits,
    outputUnits,
    imageCount,
    resolution,
    providerCostMicros,
  };
}

export function creditsForAgentUsage(item: AgentUsageItem, pricing: AgentUsagePricing): number {
  if (item.kind === "model_tokens") {
    if (item.provider !== pricing.modelTokens.provider || item.imageCount !== 0) throw new Error("agent_usage_binding_invalid");
    return Math.max(
      pricing.modelTokens.minimumCredits,
      Math.ceil(item.inputUnits / pricing.modelTokens.inputTokensPerCredit +
        item.outputUnits / pricing.modelTokens.outputTokensPerCredit),
    );
  }
  if (item.kind === "vision_call") {
    if (item.provider !== pricing.visionCall.provider || item.imageCount !== 0) throw new Error("agent_usage_binding_invalid");
    return pricing.visionCall.creditsPerCall;
  }
  if (item.kind === "html_render") {
    if (item.provider !== "renderer" || item.imageCount !== 0) throw new Error("agent_usage_binding_invalid");
    return pricing.htmlRender?.creditsPerCall ?? 0;
  }
  if (item.provider === "deepseek" || item.provider === "renderer" || item.imageCount !== 1) {
    throw new Error("agent_usage_binding_invalid");
  }
  return pricing.imageGeneration[item.provider];
}

/** A8-T2 毛利数据链：provider 不返回成本时，由版本化费率估算 micro CNY 上游成本。 */
export function estimateProviderCostMicros(item: AgentUsageItem, rates: AgentProviderCostRates): number {
  if (item.kind === "model_tokens") {
    // 整数优先相乘、最后除 1M，避免浮点误差把整数值抬高到下一个 ceil 档。
    return Math.ceil(
      (item.inputUnits * rates.deepseekInputMicrosPerMillionTokens +
        item.outputUnits * rates.deepseekOutputMicrosPerMillionTokens) / 1_000_000,
    );
  }
  if (item.kind === "vision_call") return rates.arkVisionMicrosPerCall;
  // html_render：容器内自有算力，无上游 provider 成本。
  if (item.kind === "html_render") return 0;
  // deepseek/renderer 生图组合在 creditsForAgentUsage 已 fail closed，这里不会被触达。
  if (item.provider === "deepseek" || item.provider === "renderer") return 0;
  return rates.imageMicrosPerImage[item.provider];
}
