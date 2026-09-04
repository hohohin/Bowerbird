import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { parseAgentUsagePricing } from "./agent-usage-pricing.ts";
import {
  canonicalUnifiedAgentPlanJson,
  estimateUnifiedAgentPlanCredits,
  hashUnifiedAgentPlan,
  hashUnifiedAgentPlanArguments,
  parseUnifiedAgentPlan,
  type UnifiedAgentPlan,
} from "./unified-agent-plan.ts";

const pricing = parseAgentUsagePricing({
  billing: "agent_usage",
  model_tokens: { provider: "deepseek", input_tokens_per_credit: 500_000, output_tokens_per_credit: 100_000, minimum_credits: 1 },
  vision_call: { provider: "ark", credits_per_call: 1 },
  image_generation: { ark: 5, jimeng: 0, codex: 0 },
  html_render: { credits_per_call: 0 },
}, 1);

function mixedPlan(): UnifiedAgentPlan {
  return {
    schemaVersion: 1,
    title: "产品长图",
    summary: "理解产品后生成缺图并完成 HTML 长图。",
    steps: [
      { id: "understand", kind: "understand_asset", goal: "理解产品", inputAssetIds: ["asset-product"], dependsOn: [] },
      { id: "generate", kind: "generate_image", goal: "生成辅助图", inputAssetIds: ["asset-product"], dependsOn: ["understand"] },
      { id: "compose", kind: "compose_html", goal: "合成 HTML", inputAssetIds: ["asset-product"], dependsOn: ["generate"] },
      { id: "render", kind: "render_html", goal: "离线渲染", inputAssetIds: [], dependsOn: ["compose"] },
      { id: "inspect", kind: "inspect_artifact", goal: "检查结果", inputAssetIds: [], dependsOn: ["render"] },
      { id: "finalize", kind: "finalize_output", goal: "提交结果", inputAssetIds: [], dependsOn: ["inspect"] },
    ],
  };
}

function structuredPlan(): UnifiedAgentPlan {
  return {
    schemaVersion: 2,
    title: "产品长图",
    summary: "明确素材职责与信息架构后完成产品长图。",
    contentPlan: {
      assetAssignments: [{
        assetId: "asset-product",
        roles: ["product", "copy_source"],
        rationale: "产品主体与可核验文案来源。",
      }],
      informationArchitecture: [{
        id: "hero",
        purpose: "展示产品主体与核心卖点",
        sourceAssetIds: ["asset-product"],
        copySource: "asset_observation",
      }],
      missingAssets: [{
        id: "support-background",
        purpose: "补充氛围背景",
        decision: "generate",
        resolutionStepId: "generate",
      }],
      visualProfile: {
        profileId: "profile-quiet-luxury",
        version: 3,
        hash: "a".repeat(64),
        applied: ["大量留白", "暖灰与深棕"],
        ignoredContentThemes: ["咖啡器具"],
      },
    },
    steps: mixedPlan().steps,
  };
}

Deno.test("unified plan parser is closed, ordered and requires one final terminal step", () => {
  assertEquals(parseUnifiedAgentPlan(mixedPlan()), mixedPlan());
  assertThrows(() => parseUnifiedAgentPlan({ ...mixedPlan(), estimatedCredits: 1 }), Error, "unified_plan_invalid");
  const modelCredits = structuredClone(mixedPlan()) as UnifiedAgentPlan & { steps: Array<UnifiedAgentPlan["steps"][number] & { estimatedCredits?: number }> };
  modelCredits.steps[0]!.estimatedCredits = 1;
  assertThrows(() => parseUnifiedAgentPlan(modelCredits), Error, "unified_plan_invalid");
  const forward = structuredClone(mixedPlan());
  forward.steps[0]!.dependsOn = ["generate"];
  assertThrows(() => parseUnifiedAgentPlan(forward), Error, "unified_plan_invalid");
  const missingFinal = structuredClone(mixedPlan());
  missingFinal.steps.pop();
  assertThrows(() => parseUnifiedAgentPlan(missingFinal), Error, "unified_plan_invalid");
});

Deno.test("server estimate prices bounded model turns and tool kinds from versioned pricing", () => {
  assertEquals(estimateUnifiedAgentPlanCredits(mixedPlan(), pricing, "ark"), {
    policyVersion: 1,
    modelTurns: 12,
    modelCredits: 12,
    visionCalls: 2,
    visionCredits: 2,
    imageCalls: 1,
    imageCredits: 5,
    htmlRenderCalls: 1,
    htmlRenderCredits: 0,
    totalCredits: 19,
  });
  const byo = estimateUnifiedAgentPlanCredits(mixedPlan(), pricing, "codex");
  assertEquals(byo.imageCredits, 0);
  assertEquals(byo.totalCredits, 14);
});

Deno.test("structured plan v2 is closed and keeps cost semantics on executable steps", () => {
  const structured = structuredPlan();
  assertEquals(parseUnifiedAgentPlan(structured), structured);
  assertEquals(
    estimateUnifiedAgentPlanCredits(structured, pricing, "ark"),
    estimateUnifiedAgentPlanCredits(mixedPlan(), pricing, "ark"),
  );

  const wrongResolution = structuredClone(structured);
  if (wrongResolution.schemaVersion !== 2) throw new Error("fixture_invalid");
  wrongResolution.contentPlan.missingAssets[0]!.resolutionStepId = "compose";
  assertThrows(() => parseUnifiedAgentPlan(wrongResolution), Error, "unified_plan_invalid");

  const unknownField = structuredClone(structured) as UnifiedAgentPlan & { contentPlan: Record<string, unknown> };
  unknownField.contentPlan.estimatedCredits = 0;
  assertThrows(() => parseUnifiedAgentPlan(unknownField), Error, "unified_plan_invalid");
});

Deno.test("Xiaohongshu derivation is a zero-specialized-cost plan step in the same approved chain", () => {
  const base = mixedPlan();
  const derived: UnifiedAgentPlan = {
    ...base,
    steps: [
      ...base.steps.slice(0, -1),
      { id: "compose_xhs", kind: "compose_xiaohongshu", goal: "派生渠道草稿", inputAssetIds: [], dependsOn: ["inspect"] },
      { ...base.steps.at(-1)!, dependsOn: ["compose_xhs"] },
    ],
  };
  assertEquals(parseUnifiedAgentPlan(derived), derived);
  const baseEstimate = estimateUnifiedAgentPlanCredits(base, pricing, "ark");
  const derivedEstimate = estimateUnifiedAgentPlanCredits(derived, pricing, "ark");
  assertEquals(derivedEstimate.modelTurns, baseEstimate.modelTurns + 2);
  assertEquals(derivedEstimate.visionCalls, baseEstimate.visionCalls);
  assertEquals(derivedEstimate.imageCalls, baseEstimate.imageCalls);
  assertEquals(derivedEstimate.htmlRenderCalls, baseEstimate.htmlRenderCalls);
});

Deno.test("canonical plan JSON ignores object insertion order but not step order", () => {
  const plan = mixedPlan();
  const reordered = {
    steps: plan.steps.map((step) => ({
      dependsOn: step.dependsOn,
      inputAssetIds: step.inputAssetIds,
      goal: step.goal,
      kind: step.kind,
      id: step.id,
    })),
    summary: plan.summary,
    title: plan.title,
    schemaVersion: plan.schemaVersion,
  };
  assertEquals(canonicalUnifiedAgentPlanJson(plan), canonicalUnifiedAgentPlanJson(reordered));
  const reversed = structuredClone(plan);
  reversed.steps.reverse();
  assertThrows(() => canonicalUnifiedAgentPlanJson(reversed), Error, "unified_plan_invalid");
});

Deno.test("plan and argument hashes are stable and bind different envelopes", async () => {
  const planHash = await hashUnifiedAgentPlan(mixedPlan());
  const argsHash = await hashUnifiedAgentPlanArguments(mixedPlan());
  assertEquals(planHash.length, 64);
  assertEquals(argsHash.length, 64);
  assertEquals(planHash === argsHash, false);
  assertEquals(await hashUnifiedAgentPlan(mixedPlan()), planHash);
});
