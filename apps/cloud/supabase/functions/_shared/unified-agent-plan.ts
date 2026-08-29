import {
  creditsForAgentUsage,
  type AgentUsagePricing,
} from "./agent-usage-pricing.ts";

const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STEP_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const STEP_KINDS = new Set<UnifiedAgentPlanStepKind>([
  "understand_asset",
  "generate_image",
  "compose_html",
  "render_html",
  "inspect_artifact",
  "finalize_output",
]);

export type UnifiedAgentPlanStepKind =
  | "understand_asset"
  | "generate_image"
  | "compose_html"
  | "render_html"
  | "inspect_artifact"
  | "finalize_output";

export type UnifiedAgentPlanStep = {
  id: string;
  kind: UnifiedAgentPlanStepKind;
  goal: string;
  inputAssetIds: string[];
  dependsOn: string[];
};

export type UnifiedAgentPlan = {
  schemaVersion: 1;
  title: string;
  summary: string;
  steps: UnifiedAgentPlanStep[];
};

/**
 * 计划审批使用上限式估算，不相信模型自报 token/credits。
 * 每个计划步骤最多按「工具调用前一轮 + 工具结果后一轮」两次模型请求估算；
 * 单轮输入/输出上限与 U2 Harness 的 Context/turn cap 对齐。实际 usage 仍逐 call 结算。
 */
export const UNIFIED_AGENT_PLAN_COST_POLICY_V1 = Object.freeze({
  version: 1 as const,
  maxAssets: 64,
  maxSteps: 12,
  modelTurnsPerStep: 2,
  modelInputUnitsPerTurn: 24_000,
  modelOutputUnitsPerTurn: 8_000,
});

export type UnifiedAgentPlanEstimate = {
  policyVersion: 1;
  modelTurns: number;
  modelCredits: number;
  visionCalls: number;
  visionCredits: number;
  imageCalls: number;
  imageCredits: number;
  htmlRenderCalls: number;
  htmlRenderCredits: number;
  totalCredits: number;
};

type JsonRecord = Record<string, unknown>;

function exactRecord(value: unknown, keys: readonly string[]): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("unified_plan_invalid");
  const record = value as JsonRecord;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("unified_plan_invalid");
  }
  return record;
}

function boundedText(value: unknown, max: number): string {
  if (typeof value !== "string") throw new Error("unified_plan_invalid");
  const text = value.trim();
  if (!text || text.length > max) throw new Error("unified_plan_invalid");
  return text;
}

function uniqueStrings(value: unknown, max: number, pattern: RegExp): string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("unified_plan_invalid");
  const strings = value.map((item) => {
    if (typeof item !== "string" || !pattern.test(item)) throw new Error("unified_plan_invalid");
    return item;
  });
  if (new Set(strings).size !== strings.length) throw new Error("unified_plan_invalid");
  return strings;
}

/** Edge 与 Worker Gateway 都以此闭集形状为准；未知字段（含 credits/runId/callId/URL）直接拒绝。 */
export function parseUnifiedAgentPlan(value: unknown): UnifiedAgentPlan {
  const plan = exactRecord(value, ["schemaVersion", "title", "summary", "steps"]);
  if (plan.schemaVersion !== 1 || !Array.isArray(plan.steps) || !plan.steps.length ||
      plan.steps.length > UNIFIED_AGENT_PLAN_COST_POLICY_V1.maxSteps) {
    throw new Error("unified_plan_invalid");
  }
  const steps = plan.steps.map((raw): UnifiedAgentPlanStep => {
    const step = exactRecord(raw, ["id", "kind", "goal", "inputAssetIds", "dependsOn"]);
    const id = boundedText(step.id, 64);
    if (!STEP_ID.test(id) || typeof step.kind !== "string" || !STEP_KINDS.has(step.kind as UnifiedAgentPlanStepKind)) {
      throw new Error("unified_plan_invalid");
    }
    return {
      id,
      kind: step.kind as UnifiedAgentPlanStepKind,
      goal: boundedText(step.goal, 1_000),
      inputAssetIds: uniqueStrings(step.inputAssetIds, UNIFIED_AGENT_PLAN_COST_POLICY_V1.maxAssets, ASSET_ID),
      dependsOn: uniqueStrings(step.dependsOn, UNIFIED_AGENT_PLAN_COST_POLICY_V1.maxSteps, STEP_ID),
    };
  });

  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.id) || step.dependsOn.some((dependency) => !seen.has(dependency))) {
      throw new Error("unified_plan_invalid");
    }
    seen.add(step.id);
  }
  const finalizeIndexes = steps.flatMap((step, index) => step.kind === "finalize_output" ? [index] : []);
  if (finalizeIndexes.length !== 1 || finalizeIndexes[0] !== steps.length - 1) {
    throw new Error("unified_plan_invalid");
  }
  return {
    schemaVersion: 1,
    title: boundedText(plan.title, 120),
    summary: boundedText(plan.summary, 2_000),
    steps,
  };
}

function checkedAdd(total: number, value: number): number {
  const next = total + value;
  if (!Number.isSafeInteger(next) || next < 0) throw new Error("unified_plan_estimate_invalid");
  return next;
}

export function estimateUnifiedAgentPlanCredits(
  planValue: unknown,
  pricing: AgentUsagePricing,
  imageProvider: "ark" | "jimeng" | "codex",
): UnifiedAgentPlanEstimate {
  const plan = parseUnifiedAgentPlan(planValue);
  const policy = UNIFIED_AGENT_PLAN_COST_POLICY_V1;
  const modelTurns = plan.steps.length * policy.modelTurnsPerStep;
  const modelCreditsPerTurn = creditsForAgentUsage({
    callId: "planned-model-turn",
    kind: "model_tokens",
    provider: "deepseek",
    model: "planned-unified-agent-turn",
    inputUnits: policy.modelInputUnitsPerTurn,
    outputUnits: policy.modelOutputUnitsPerTurn,
    imageCount: 0,
  }, pricing);
  const modelCredits = modelTurns * modelCreditsPerTurn;

  let visionCalls = 0;
  let imageCalls = 0;
  let htmlRenderCalls = 0;
  for (const step of plan.steps) {
    if (step.kind === "understand_asset" || step.kind === "inspect_artifact") visionCalls++;
    if (step.kind === "generate_image") imageCalls++;
    if (step.kind === "render_html") htmlRenderCalls++;
  }
  const visionCreditsPerCall = creditsForAgentUsage({
    callId: "planned-vision",
    kind: "vision_call",
    provider: "ark",
    model: "planned-vision",
    inputUnits: 0,
    outputUnits: 0,
    imageCount: 0,
  }, pricing);
  const imageCreditsPerCall = creditsForAgentUsage({
    callId: "planned-image",
    kind: "image_generation",
    provider: imageProvider,
    model: "planned-image-generation",
    inputUnits: 0,
    outputUnits: 0,
    imageCount: 1,
  }, pricing);
  const htmlRenderCreditsPerCall = creditsForAgentUsage({
    callId: "planned-render",
    kind: "html_render",
    provider: "renderer",
    model: "planned-offline-renderer",
    inputUnits: 0,
    outputUnits: 0,
    imageCount: 0,
  }, pricing);
  const visionCredits = visionCalls * visionCreditsPerCall;
  const imageCredits = imageCalls * imageCreditsPerCall;
  const htmlRenderCredits = htmlRenderCalls * htmlRenderCreditsPerCall;
  let totalCredits = checkedAdd(modelCredits, visionCredits);
  totalCredits = checkedAdd(totalCredits, imageCredits);
  totalCredits = checkedAdd(totalCredits, htmlRenderCredits);
  return {
    policyVersion: 1,
    modelTurns,
    modelCredits,
    visionCalls,
    visionCredits,
    imageCalls,
    imageCredits,
    htmlRenderCalls,
    htmlRenderCredits,
    totalCredits,
  };
}

export function canonicalUnifiedAgentPlanJson(planValue: unknown): string {
  const plan = parseUnifiedAgentPlan(planValue);
  return canonicalJson(plan);
}

export async function hashUnifiedAgentPlan(planValue: unknown): Promise<string> {
  return await sha256Hex(canonicalUnifiedAgentPlanJson(planValue));
}

export async function hashUnifiedAgentPlanArguments(planValue: unknown): Promise<string> {
  const plan = parseUnifiedAgentPlan(planValue);
  return await sha256Hex(canonicalJson({ plan }));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as JsonRecord;
  return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
