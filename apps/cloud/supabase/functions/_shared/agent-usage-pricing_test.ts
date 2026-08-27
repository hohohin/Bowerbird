import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  agentUsageService,
  creditsForAgentUsage,
  estimateProviderCostMicros,
  normalizeAgentUsageItem,
  parseAgentUsagePricing,
} from "./agent-usage-pricing.ts";

const pricing = parseAgentUsagePricing({
  billing: "agent_usage",
  model_tokens: { provider: "deepseek", input_tokens_per_credit: 500_000, output_tokens_per_credit: 100_000, minimum_credits: 1 },
  vision_call: { provider: "ark", credits_per_call: 1 },
  image_generation: { ark: 5, jimeng: 0, codex: 0 },
}, 1);

Deno.test("versioned Agent usage pricing covers text, vision, managed image and BYO", () => {
  assertEquals(agentUsageService(1), "agent_usage_v1");
  assertEquals(creditsForAgentUsage(normalizeAgentUsageItem({
    callId: "text", kind: "model_tokens", provider: "deepseek", model: "deepseek-chat",
    inputUnits: 20_000, outputUnits: 2_000, imageCount: 0,
  }), pricing), 1);
  assertEquals(creditsForAgentUsage(normalizeAgentUsageItem({
    callId: "large-text", kind: "model_tokens", provider: "deepseek", model: "deepseek-chat",
    inputUnits: 500_000, outputUnits: 100_000, imageCount: 0,
  }), pricing), 2);
  assertEquals(creditsForAgentUsage(normalizeAgentUsageItem({
    callId: "vision", kind: "vision_call", provider: "ark", model: "vision", imageCount: 0,
  }), pricing), 1);
  assertEquals(creditsForAgentUsage(normalizeAgentUsageItem({
    callId: "image", kind: "image_generation", provider: "ark", model: "seedream", imageCount: 1,
  }), pricing), 5);
  assertEquals(creditsForAgentUsage(normalizeAgentUsageItem({
    callId: "byo", kind: "image_generation", provider: "codex", model: "codex-cli-imagegen", imageCount: 1,
  }), pricing), 0);
});

Deno.test("invalid units and provider-kind substitutions fail closed", () => {
  assertThrows(() => normalizeAgentUsageItem({
    callId: "bad", kind: "model_tokens", provider: "deepseek", model: "deepseek-chat", inputUnits: -1,
  }), Error, "agent_usage_item_invalid");
  assertThrows(() => creditsForAgentUsage(normalizeAgentUsageItem({
    callId: "forged", kind: "image_generation", provider: "jimeng", model: "seedream", imageCount: 0,
  }), pricing), Error, "agent_usage_binding_invalid");
  assertThrows(() => creditsForAgentUsage(normalizeAgentUsageItem({
    callId: "forged", kind: "model_tokens", provider: "ark", model: "vision", imageCount: 0,
  }), pricing), Error, "agent_usage_binding_invalid");
});

Deno.test("provider cost rates are optional but validated when present", () => {
  // 旧参数（无 provider_cost）仍可解析，成本估算关闭。
  assertEquals(pricing.providerCost, null);

  const rates = parseAgentUsagePricing({
    billing: "agent_usage",
    model_tokens: { provider: "deepseek", input_tokens_per_credit: 500_000, output_tokens_per_credit: 100_000, minimum_credits: 1 },
    vision_call: { provider: "ark", credits_per_call: 1 },
    image_generation: { ark: 5, jimeng: 0, codex: 0 },
    provider_cost: {
      currency: "CNY",
      deepseek_input_micros_per_million_tokens: 2_000_000,
      deepseek_output_micros_per_million_tokens: 6_000_000,
      ark_vision_micros_per_call: 30_000,
      image_micros_per_image: { ark: 250_000, jimeng: 0, codex: 0 },
    },
  }, 1).providerCost;
  assertEquals(rates !== null && rates.currency, "CNY");

  const usage = (over: Record<string, unknown>) => normalizeAgentUsageItem({
    callId: "c", kind: "model_tokens", provider: "deepseek", model: "deepseek-chat", imageCount: 0, ...over,
  });
  if (!rates) throw new Error("unreachable");
  assertEquals(estimateProviderCostMicros(usage({ inputUnits: 1_000_000, outputUnits: 0 }), rates), 2_000_000);
  assertEquals(estimateProviderCostMicros(usage({ inputUnits: 0, outputUnits: 500_000 }), rates), 3_000_000);
  assertEquals(estimateProviderCostMicros(usage({ inputUnits: 1, outputUnits: 0 }), rates), 2);
  assertEquals(estimateProviderCostMicros(usage({ inputUnits: 1, outputUnits: 1 }), rates), 8);
  assertEquals(estimateProviderCostMicros(normalizeAgentUsageItem({
    callId: "v", kind: "vision_call", provider: "ark", model: "vision", imageCount: 0,
  }), rates), 30_000);
  assertEquals(estimateProviderCostMicros(normalizeAgentUsageItem({
    callId: "i", kind: "image_generation", provider: "ark", model: "seedream", imageCount: 1,
  }), rates), 250_000);
  assertEquals(estimateProviderCostMicros(normalizeAgentUsageItem({
    callId: "b", kind: "image_generation", provider: "codex", model: "codex-cli-imagegen", imageCount: 1,
  }), rates), 0);

  assertThrows(() => parseAgentUsagePricing({
    billing: "agent_usage",
    model_tokens: { provider: "deepseek", input_tokens_per_credit: 500_000, output_tokens_per_credit: 100_000, minimum_credits: 1 },
    vision_call: { provider: "ark", credits_per_call: 1 },
    image_generation: { ark: 5, jimeng: 0, codex: 0 },
    provider_cost: { currency: "USD" },
  }, 1), Error, "agent_usage_pricing_invalid");
});
