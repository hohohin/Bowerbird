/**
 * 智能精修 eval（M0）—— 验证四项能力 + 「至多精修一次」封顶。
 *   1. 结构化意图（parse_intent 产出 intent artifact，且 allowedActions 正确）
 *   2. 参考图职责（assign_reference_roles 产出 roles artifact）
 *   3. 分维度评分（score_dimensions 产出 score artifact，覆盖 5 维）
 *   4a. 必要时精修一次（完整 happy path，generateAttempts===1，succeeded）
 *   4b. 第二次精修在模型外被拒（PolicyEngine max_generate_attempts_exceeded）
 */

import { test } from "node:test";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { FakeModel } from "../fakes/fake-model.ts";
import { FakeTools, type InputManifestEntry } from "../fakes/fake-tools.ts";
import { runSkill } from "./runner.ts";
import { SMART_REFINEMENT_MANIFEST } from "../skills/smart-refinement/manifest.ts";
import { evaluatePolicy } from "../kernel/policy-engine.ts";
import { ToolLedger } from "../kernel/tool-ledger.ts";
import type { ContextBlock, ModelTurnRequest, ModelTurnResult, ProviderUsage } from "../contracts/model.ts";

function entries(): InputManifestEntry[] {
  return [
    { assetId: "target-1", sourceClass: "generated_confirmed", sections: [{ title: "构图", body: "居中" }], dimensions: { composition: "居中", palette: "暖色调" } },
    { assetId: "ref-1", sourceClass: "imported", sections: [{ title: "光影", body: "侧光" }], dimensions: { light: "侧光" } },
    { assetId: "ref-2", sourceClass: "imported", sections: [{ title: "氛围", body: "宁静" }], dimensions: { mood: "宁静" } },
  ];
}
const budget = (credits: number) => ({ budgetCredits: credits, spentCredits: 0 });
const NO_USAGE: ProviderUsage = {};
const action = (name: string, args?: unknown): ModelTurnResult => ({ kind: "action", action: name, arguments: args ?? {}, providerUsage: { ...NO_USAGE } });
const message = (): ModelTurnResult => ({ kind: "message", text: "(probe end)", providerUsage: { ...NO_USAGE } });

function findCallId(req: ModelTurnRequest, kind: string): string {
  for (const b of req.context as ContextBlock[]) {
    if (b.kind === "tool_result") {
      const body = b.body as { callId: string; kind: string };
      if (body.kind === kind) return body.callId;
    }
  }
  throw new Error(`artifact kind=${kind} not in context`);
}
function allCallIds(req: ModelTurnRequest): string[] {
  return (req.context as ContextBlock[])
    .filter((b) => b.kind === "tool_result")
    .map((b) => (b.body as { callId: string }).callId);
}

test("智能精修 1/4：结构化意图", async () => {
  const trace = await runSkill({
    manifest: SMART_REFINEMENT_MANIFEST,
    model: new FakeModel([action("parse_intent", { intent: { subject: "产品", style: "极简", mood: "清爽", goal: "清爽极简产品图" } }), message()]),
    tools: new FakeTools(entries()),
    budget: budget(12),
  });
  const intent = trace.artifacts.find((a) => a.kind === "intent");
  ok(intent, "parse_intent 产出 intent artifact");
  ok(
    trace.entries.some((e) => e.kind === "action_ok" && e.action === "parse_intent"),
    "parse_intent 被执行且推进 phase",
  );
});

test("智能精修 2/4：参考图职责", async () => {
  const trace = await runSkill({
    manifest: SMART_REFINEMENT_MANIFEST,
    model: new FakeModel([
      action("parse_intent", { intent: { goal: "g" } }),
      action("assign_reference_roles", { assignments: [{ assetId: "ref-1", role: "style" }, { assetId: "ref-2", role: "mood" }] }),
      message(),
    ]),
    tools: new FakeTools(entries()),
    budget: budget(12),
  });
  const roles = trace.artifacts.find((a) => a.kind === "reference_roles");
  ok(roles, "assign_reference_roles 产出 roles artifact");
});

test("智能精修 3/4：分维度评分", async () => {
  const trace = await runSkill({
    manifest: SMART_REFINEMENT_MANIFEST,
    model: new FakeModel([
      action("parse_intent", { intent: { goal: "g" } }),
      action("assign_reference_roles", { assignments: [] }),
      action("score_dimensions", {
        scores: [
          { dim: "composition", score: 6 },
          { dim: "light", score: 5 },
          { dim: "palette", score: 7 },
          { dim: "mood", score: 8 },
          { dim: "material", score: 6 },
        ],
      }),
      message(),
    ]),
    tools: new FakeTools(entries()),
    budget: budget(12),
  });
  const score = trace.artifacts.find((a) => a.kind === "score");
  ok(score, "score_dimensions 产出 score artifact");
});

test("智能精修 4a/4：必要时精修一次（happy path）", async () => {
  const model = new FakeModel([
    action("parse_intent", { intent: { subject: "产品", style: "极简", mood: "清爽", goal: "清爽极简" } }),
    action("assign_reference_roles", { assignments: [{ assetId: "ref-1", role: "style" }] }),
    action("score_dimensions", { scores: [{ dim: "palette", score: 5 }] }),
    action("submit_refine_plan", { changes: "提亮高光、统一清爽极简", estimatedAdditionalCredits: 5 }),
    action("refine_once", { prompt: "清爽极简产品图", referenceAssetIds: ["ref-1", "ref-2"] }),
    (req: ModelTurnRequest) => action("inspect_generated_image", { artifactCallId: findCallId(req, "generated_image") }),
    (req: ModelTurnRequest) => action("finish_run", { artifactCallIds: allCallIds(req) }),
  ]);
  const trace = await runSkill({
    manifest: SMART_REFINEMENT_MANIFEST,
    model,
    tools: new FakeTools(entries()),
    budget: budget(12),
    autoApprove: true,
  });
  equal(trace.status, "succeeded", "完整精修流程成功");
  equal(trace.finalPhase, "done");
  equal(trace.generateAttempts, 1, "只精修一次");
  equal(trace.approved, true, "经过审批");
  ok(trace.artifacts.some((a) => a.kind === "generated_image"), "产出生成图 artifact");
  ok(trace.rejections.length === 0, "无拒绝");
});

test("智能精修 4b/4：第二次精修在模型外被拒", () => {
  // 已用掉 maxGenerateAttempts=1 → 再请求 refine_once 被 PolicyEngine 拒。
  const verdict = evaluatePolicy(
    {
      runId: "r",
      phase: "refine",
      manifest: SMART_REFINEMENT_MANIFEST,
      toolCallCount: 6,
      generateAttemptCount: 1,
      modelTurnCount: 8,
      budget: budget(12),
      ledger: new ToolLedger(),
      nextLogicalSlot: 1,
      approvedPlanHash: "plan-hash",
    },
    "refine_once",
    { prompt: "again" },
  );
  equal(verdict.verdict, "deny");
  if (verdict.verdict === "deny") {
    equal(verdict.reason, "max_generate_attempts_exceeded");
    equal(verdict.errorClass, "policy_denied");
  }
});

test("智能精修：allowedActions 受 phase 约束", async () => {
  // 用函数回合捕获第一帧请求，确认 phase=parse_intent 时只允许 parse_intent。
  let captured: ModelTurnRequest | null = null;
  await runSkill({
    manifest: SMART_REFINEMENT_MANIFEST,
    model: new FakeModel([
      (req: ModelTurnRequest) => {
        captured = req;
        return action("parse_intent", { intent: { goal: "g" } });
      },
      message(),
    ]),
    tools: new FakeTools(entries()),
    budget: budget(12),
  });
  ok(captured);
  equal(captured!.phase, "parse_intent");
  deepStrictEqual(captured!.allowedActions.map((a) => a.name), ["parse_intent"]);
});
