export type AgentUsageKind = "model_tokens" | "vision_call" | "image_generation";
export type AgentUsageProvider = "deepseek" | "ark" | "jimeng" | "codex";

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
  if (!callId || callId.length > 160 || !["model_tokens", "vision_call", "image_generation"].includes(String(kind)) ||
      !["deepseek", "ark", "jimeng", "codex"].includes(String(provider)) || !model || model.length > 120 ||
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
  if (item.provider === "deepseek" || item.imageCount !== 1) throw new Error("agent_usage_binding_invalid");
  return pricing.imageGeneration[item.provider];
}
