import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  agentUsageService,
  creditsForAgentUsage,
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
