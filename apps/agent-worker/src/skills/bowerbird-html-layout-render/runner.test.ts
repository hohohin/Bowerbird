/**
 * HTML 排版 Run 引擎确定性断言 —— H3-T5。
 * 覆盖：完整流程（唯一模型回合 + 唯一 render + 停车）；等待期间无自动推进；
 * accept→succeeded / discard→cancelled；render ≤1 不变量；崩溃恢复（compose action
 * 重放不重复模型回合、render 幂等）；retry 非法输入 fail closed；Vision 在本 Skill
 * 全 phase 被 PolicyEngine 拒绝。
 */
import { deepEqual, equal, ok, rejects, throws } from "node:assert/strict";
import { test } from "node:test";

import type { ModelBackend, ModelTurnRequest, ModelTurnResult } from "../../contracts/model.ts";
import { evaluatePolicy, type PolicyContext } from "../../kernel/policy-engine.ts";
import type { BudgetSnapshot } from "../../contracts/run.ts";
import { ToolLedger } from "../../kernel/tool-ledger.ts";
import type { RenderHtmlResultV1 } from "../../contracts/render-html.ts";
import { advanceHtmlLayoutRun, type AdvanceHtmlLayoutRunRequest, type HtmlLayoutControl, type HtmlLayoutEffects } from "./runner.ts";
import type { HtmlLayoutRunnerCheckpoint } from "./checkpoint.ts";
import { decodeHtmlLayoutCheckpoint, encodeHtmlLayoutCheckpoint } from "./checkpoint.ts";
import { HTML_LAYOUT_RENDER_MANIFEST } from "./manifest.ts";
import { validateHtmlLayoutRenderInput, type HtmlLayoutRenderInputV1 } from "./schemas.ts";

const RUN = { runId: "run-html-1", conversationId: "conv-html-1", skillVersion: HTML_LAYOUT_RENDER_MANIFEST.version };

function input(): HtmlLayoutRenderInputV1 {
  return validateHtmlLayoutRenderInput({
    schemaVersion: 1,
    layoutPrompt: "把两张产品图排成中文长页",
    references: [
      { artifactId: "artifact-a", token: "@正面", ordinal: 1, mime: "image/png", bytes: 10, sha256: "a".repeat(64) },
      { artifactId: "artifact-b", token: "@侧面", ordinal: 2, mime: "image/jpeg", bytes: 20, sha256: "b".repeat(64) },
    ],
    viewport: { widthCssPx: 900, heightCssPx: 1200, deviceScaleFactor: 1 },
    capture: { mode: "full_page_and_slices", sliceHeightCssPx: 1200, overlapCssPx: 0 },
    background: "opaque",
  });
}

const COMPOSE_HTML = '<main><img src="asset:reference-1"><img src="asset:reference-2"></main>';

class FakeModel implements ModelBackend {
  readonly id = "fake" as const;
  turns = 0;
  html = COMPOSE_HTML;

  async turn(_request: ModelTurnRequest): Promise<ModelTurnResult> {
    this.turns += 1;
    return {
      kind: "action",
      action: "compose_html_document",
      arguments: { schemaVersion: 1, html: this.html, resourceArtifactIds: ["artifact-a", "artifact-b"] },
      providerUsage: { promptTokens: 10, completionTokens: 10 },
    };
  }
}

class FakeEffects implements HtmlLayoutEffects {
  composeCalls: string[] = [];
  renderCalls = 0;

  async saveHtmlDocument(action: { html: string }) {
    this.composeCalls.push(action.html);
    return { artifactId: "art-html-1", sha256: "c".repeat(64), bytes: action.html.length };
  }

  async renderHtml(htmlArtifactId: string) {
    equal(htmlArtifactId, "art-html-1");
    this.renderCalls += 1;
    return renderResult();
  }
}

function renderResult(): RenderHtmlResultV1 & { manifestArtifactId: string } {
  return {
    schemaVersion: 1,
    rendererFingerprint: "bwr1-test",
    sourceHtmlSha256: "d".repeat(64),
    argsHash: "e".repeat(64),
    document: { widthCssPx: 900, heightCssPx: 2400, widthDevicePx: 900, heightDevicePx: 2400 },
    renderMs: 40,
    outputs: [
      { artifactId: "art-full", role: "full_page_screenshot", clipDevicePx: { x: 0, y: 0, width: 900, height: 2400 }, mime: "image/png", bytes: 100, sha256: "1".repeat(64) },
      { artifactId: "art-s1", role: "slice_screenshot", index: 1, clipDevicePx: { x: 0, y: 0, width: 900, height: 1200 }, mime: "image/png", bytes: 50, sha256: "2".repeat(64) },
      { artifactId: "art-s2", role: "slice_screenshot", index: 2, clipDevicePx: { x: 0, y: 1200, width: 900, height: 1200 }, mime: "image/png", bytes: 50, sha256: "3".repeat(64) },
    ],
    manifestArtifactId: "art-manifest",
  };
}

class FakeControl implements HtmlLayoutControl {
  readonly checkpoints: HtmlLayoutRunnerCheckpoint[] = [];
  awaitReviewCalls = 0;
  finishCalls = 0;
  cancelCalls = 0;

  async saveCheckpoint(checkpoint: HtmlLayoutRunnerCheckpoint, _progress: number): Promise<void> {
    // 每次落盘都必须通过 checkpoint codec 的完整校验（编码即校验）。
    encodeHtmlLayoutCheckpoint(checkpoint);
    this.checkpoints.push(checkpoint);
  }
  async awaitUserReview(): Promise<void> {
    this.awaitReviewCalls += 1;
  }
  async finish(): Promise<void> {
    this.finishCalls += 1;
  }
  async cancel(): Promise<void> {
    this.cancelCalls += 1;
  }
}

function advance(args: Partial<AdvanceHtmlLayoutRunRequest> & { model: ModelBackend; effects: HtmlLayoutEffects; control: FakeControl }) {
  return advanceHtmlLayoutRun({
    claim: { ...RUN, resultFeedbackAction: null },
    input: input(),
    ...args,
  } as AdvanceHtmlLayoutRunRequest);
}

test("full flow: one model turn, one render, then parks awaiting user review", async () => {
  const model = new FakeModel();
  const effects = new FakeEffects();
  const control = new FakeControl();
  const result = await advance({ model, effects, control });
  equal(result.outcome, "awaiting_user_review");
  equal(model.turns, 1, "唯一模型回合");
  equal(effects.renderCalls, 1, "唯一一次 render");
  equal(effects.composeCalls.length, 1);
  equal(control.awaitReviewCalls, 1);
  equal(result.checkpoint.status, "awaiting_user_review");
  equal(result.checkpoint.renderCallCount, 1);
  equal(result.checkpoint.artifacts.length, 4); // html + 整页 + 2 切片（manifest 单记 id）
  equal(result.checkpoint.pendingCompose, null);
});

test("re-claim while awaiting without a decision does not auto-advance", async () => {
  const model = new FakeModel();
  const effects = new FakeEffects();
  const control = new FakeControl();
  const first = await advance({ model, effects, control });

  const second = await advance({ model, effects, control, checkpoint: first.checkpoint });
  equal(second.outcome, "awaiting_user_review");
  equal(model.turns, 1, "不重复模型回合");
  equal(effects.renderCalls, 1, "不重复 render");
  equal(control.awaitReviewCalls, 2, "幂等重放停车请求");
});

test("accept finishes the run; discard (cancel signal) cancels it", async () => {
  const model = new FakeModel();
  const effects = new FakeEffects();
  const control = new FakeControl();
  const parked = await advance({ model, effects, control });

  const accepted = await advance({
    model,
    effects,
    control,
    checkpoint: parked.checkpoint,
    claim: { ...RUN, resultFeedbackAction: "accept" },
  });
  equal(accepted.outcome, "succeeded");
  equal(accepted.checkpoint.status, "succeeded");
  equal(control.finishCalls, 1);
  equal(effects.renderCalls, 1);

  const model2 = new FakeModel();
  const effects2 = new FakeEffects();
  const control2 = new FakeControl();
  const parked2 = await advance({ model: model2, effects: effects2, control: control2 });
  const discarded = await advance({
    model: model2,
    effects: effects2,
    control: control2,
    checkpoint: parked2.checkpoint,
    signal: { cancelRequested: true, leaseLost: false, stopRequested: false },
  });
  equal(discarded.outcome, "cancelled");
  equal(discarded.checkpoint.status, "cancelled");
  equal(control2.cancelCalls, 1);
  equal(effects2.renderCalls, 1, "放弃不新增任何调用");
});

test("crash after model turn replays the pinned compose action without a second model turn", async () => {
  const model = new FakeModel();
  const effects = new FakeEffects();
  const control = new FakeControl();

  // 手工推进到 compose：模型回合完成后、副作用前崩溃（模拟 pendingCompose 已落盘）。
  const crashEffects = {
    saveHtmlDocument: async () => {
      throw new Error("simulated_crash_before_compose_persist");
    },
    renderHtml: () => {
      throw new Error("unreachable");
    },
  };
  await rejects(() => advance({ model, effects: crashEffects, control }), /simulated_crash/);
  equal(model.turns, 1);
  const crashed = control.checkpoints.at(-1)!;
  ok(crashed.pendingCompose, "action 已钉进 checkpoint");
  equal(crashed.phase, "compose_html_document");

  // 恢复：不重跑模型，直接用原文重放副作用并完成全流程。
  const resumed = await advance({ model, effects, control, checkpoint: crashed });
  equal(resumed.outcome, "awaiting_user_review");
  equal(model.turns, 1, "崩溃恢复不重复模型回合");
  deepEqual(effects.composeCalls, [COMPOSE_HTML]);
  equal(effects.renderCalls, 1);
});

test("render count invariant: missing renderResult with count=1 fails closed", async () => {
  const model = new FakeModel();
  const effects = new FakeEffects();
  const control = new FakeControl();
  const parked = await advance({ model, effects, control });
  const tampered: HtmlLayoutRunnerCheckpoint = { ...parked.checkpoint, renderResult: null, status: "running", phase: "render_once" };
  throws(() => encodeHtmlLayoutCheckpoint(tampered), /html_layout_checkpoint_render_count_inconsistent|html_layout_checkpoint_phase_render_missing|html_layout_checkpoint_status_phase_mismatch/);
});

test("retry feedback is rejected: no revision loop", async () => {
  const model = new FakeModel();
  const effects = new FakeEffects();
  const control = new FakeControl();
  const parked = await advance({ model, effects, control });
  await rejects(
    () => advance({ model, effects, control, checkpoint: parked.checkpoint, claim: { ...RUN, resultFeedbackAction: "retry" } }),
    /html_layout_retry_unsupported/,
  );
});

test("checkpoint codec round-trips and pins identity", async () => {
  const model = new FakeModel();
  const effects = new FakeEffects();
  const control = new FakeControl();
  const parked = await advance({ model, effects, control });
  const encoded = encodeHtmlLayoutCheckpoint(parked.checkpoint);
  const decoded = decodeHtmlLayoutCheckpoint(encoded.bytes, {
    runId: RUN.runId,
    conversationId: RUN.conversationId,
    skillVersion: RUN.skillVersion,
    skillHash: parked.checkpoint.skillHash,
    sha256: encoded.sha256,
  });
  deepEqual(decoded, parked.checkpoint);
  throws(
    () => decodeHtmlLayoutCheckpoint(encoded.bytes, {
      runId: "other-run",
      conversationId: RUN.conversationId,
      skillVersion: RUN.skillVersion,
      skillHash: parked.checkpoint.skillHash,
      sha256: encoded.sha256,
    }),
    /html_layout_checkpoint_run_mismatch/,
  );
});

test("policy: understand_image and generate_image denied in every html-layout phase", () => {
  const budget: BudgetSnapshot = { budgetCredits: 15, spentCredits: 0 };
  for (const phase of HTML_LAYOUT_RENDER_MANIFEST.phases) {
    const ctx: PolicyContext = {
      runId: RUN.runId,
      phase: phase.name,
      manifest: HTML_LAYOUT_RENDER_MANIFEST,
      toolCallCount: 0,
      generateAttemptCount: 0,
      modelTurnCount: 1,
      budget,
      ledger: new ToolLedger(),
      nextLogicalSlot: 1,
    };
    for (const action of ["understand_image", "generate_image", "inspect_generated_image"]) {
      const verdict = evaluatePolicy(ctx, action, {});
      equal(verdict.verdict, "deny", `${action} 在 ${phase.name} 必须被拒`);
    }
  }
});
