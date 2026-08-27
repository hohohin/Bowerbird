/**
 * render_html 的 Kernel 门控测试 —— H2-T3（HTML-RENDER-PLAN §6.1）。
 * 覆盖：全局注册表条目形状、现役 controlled-image-edit 全 phase 拒绝（fail closed）、
 * 显式声明 render_once phase 的合成 manifest 放行、跨 Run 守卫、审批前置不受影响。
 */
import { deepEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";

import { evaluatePolicy, GLOBAL_TOOL_REGISTRY, type PolicyContext } from "./policy-engine.ts";
import { CONTROLLED_IMAGE_EDIT_MANIFEST } from "../skills/bowerbird-controlled-image-edit/manifest.ts";
import { RENDER_HTML_INPUT_SCHEMA } from "../contracts/render-html.ts";
import type { SkillManifest } from "../contracts/skill.ts";
import type { BudgetSnapshot } from "../contracts/run.ts";
import { ToolLedger } from "./tool-ledger.ts";

function budget(): BudgetSnapshot {
  return { budgetCredits: 20, spentCredits: 0 };
}

function ledger(): ToolLedger {
  return new ToolLedger();
}

function ctxFor(manifest: SkillManifest, phase: string): PolicyContext {
  return {
    runId: "run-h2",
    phase,
    manifest,
    toolCallCount: 0,
    generateAttemptCount: 0,
    modelTurnCount: 1,
    budget: budget(),
    ledger: ledger(),
    nextLogicalSlot: 1,
  };
}

const RENDER_INPUT = {
  schemaVersion: 1,
  htmlArtifactId: "art-html-1",
  resourceArtifactIds: ["art-res-1"],
  viewport: { widthCssPx: 800, heightCssPx: 600, deviceScaleFactor: 1 },
  capture: { mode: "full_page" },
  background: "opaque",
};

/** 合成 manifest：只有 render_once phase 显式 allowlist 了 render_html。 */
function htmlSkillManifest(): SkillManifest {
  return {
    id: "bowerbird-html-layout-render",
    version: "0.0.1-test",
    kernelMinVersion: "0.0.1",
    snapshotSchemaVersion: 1,
    title: "HTML 排版截图（测试）",
    description: "test",
    inputSchema: { type: "object" },
    artifactSchema: { type: "object" },
    initialPhase: "prepare_inputs",
    terminalPhases: ["succeeded"],
    phases: [
      { name: "prepare_inputs", allowedActions: ["record_intent_analysis"], maxTurns: 2, transitions: [{ action: "record_intent_analysis", to: "render_once" }] },
      { name: "render_once", allowedActions: ["render_html"], maxTurns: 2, transitions: [{ action: "render_html", to: "awaiting_user_review" }] },
      { name: "awaiting_user_review", allowedActions: [], maxTurns: 0, transitions: [] },
    ],
    budgetTiers: [{ id: "std", credits: 10, label: "标准" }],
    allowedProviders: ["deepseek"],
    maxRunSeconds: 600,
    maxModelTurns: 10,
    maxToolCalls: 10,
    maxGenerateAttempts: 0,
    clarifications: { maxPerRun: 0, intentFields: [] },
  };
}

test("global registry exposes render_html as renderer-kind tool with closed schema", () => {
  const spec = GLOBAL_TOOL_REGISTRY.find((tool) => tool.name === "render_html");
  ok(spec, "render_html 必须在全局白名单");
  equal(spec!.kind, "renderer");
  deepEqual(spec!.argumentSchema, RENDER_HTML_INPUT_SCHEMA);
  const props = (spec!.argumentSchema.properties ?? {}) as Record<string, unknown>;
  ok(!("url" in props) && !("path" in props) && !("command" in props), "schema 不得出现 URL/路径/命令字段");
  equal(spec!.argumentSchema.additionalProperties, false);
});

test("controlled-image-edit denies render_html in every phase (fail closed by default)", () => {
  for (const phase of CONTROLLED_IMAGE_EDIT_MANIFEST.phases) {
    const verdict = evaluatePolicy(ctxFor(CONTROLLED_IMAGE_EDIT_MANIFEST, phase.name), "render_html", RENDER_INPUT);
    equal(verdict.verdict, "deny");
    if (verdict.verdict === "deny") equal(verdict.reason, "render_phase_not_allowed");
  }
});

test("html skill allows render_html only in the phase that declares it", () => {
  const manifest = htmlSkillManifest();
  const allowed = evaluatePolicy(ctxFor(manifest, "render_once"), "render_html", RENDER_INPUT);
  equal(allowed.verdict, "allow");
  if (allowed.verdict === "allow") {
    ok(/^[0-9a-f]{64}$/.test(allowed.callId));
    ok(/^[0-9a-f]{64}$/.test(allowed.argsHash));
    equal(allowed.cost, 0, "首版渲染 0 积分");
  }
  const deniedPhase = evaluatePolicy(ctxFor(manifest, "prepare_inputs"), "render_html", RENDER_INPUT);
  equal(deniedPhase.verdict, "deny");
  if (deniedPhase.verdict === "deny") equal(deniedPhase.reason, "render_phase_not_allowed");
});

test("cross-run guard still applies to render_html args", () => {
  const manifest = htmlSkillManifest();
  const verdict = evaluatePolicy(ctxFor(manifest, "render_once"), "render_html", { ...RENDER_INPUT, runId: "other-run" });
  equal(verdict.verdict, "deny");
  if (verdict.verdict === "deny") equal(verdict.reason, "cross_run_access_denied");
});

test("render_html does not consume generate attempts and needs no plan approval", () => {
  const manifest = htmlSkillManifest();
  const ctx = ctxFor(manifest, "render_once");
  ctx.approvedPlanHash = undefined; // 无审批 hash 也允许：render_once 不属于生图审批链
  const verdict = evaluatePolicy(ctx, "render_html", RENDER_INPUT);
  equal(verdict.verdict, "allow");
});
