/**
 * A3-T7 指标评测：10 个真实 DeepSeek 纯文本规划案例 + 8 个确定性 Kernel 专项。
 * 不下载图片，不调用 Vision / 生图 provider。
 *
 * 运行：npm run eval:controlled-image-edit
 * 输出：artifacts/controlled-image-edit-eval.{json,md}
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ControlledImageEditInput,
  ControlledImageEditPlan,
  HighConsistencySignal,
  IntentAnalysis,
} from "../contracts/controlled-image-edit.ts";
import type { ModelBackend, ModelTurnRequest, ModelTurnResult, ProviderUsage } from "../contracts/model.ts";
import { controlledRunnerAllowsVision, createControlledRunnerCheckpoint, decideControlledPlan, executeNextControlledStep, proposeControlledPlan, recordControlledFeedbackDiagnosis, recordControlledIntentAnalysis, submitControlledResultFeedback } from "../kernel/controlled-image-edit-runner.ts";
import { evaluatePolicy, type PolicyContext } from "../kernel/policy-engine.ts";
import { canonicalJson, sha256Hex, ToolLedger } from "../kernel/tool-ledger.ts";
import { DeepSeekBackend, deepSeekConfigFromEnv } from "../providers/deepseek/backend.ts";
import { CONTROLLED_IMAGE_EDIT_MANIFEST } from "../skills/bowerbird-controlled-image-edit/manifest.ts";
import { analyzeControlledIntent, composeControlledPlan } from "../skills/bowerbird-controlled-image-edit/model-planner.ts";
import { hashIntentAnalysis } from "../skills/bowerbird-controlled-image-edit/planner.ts";
import {
  renderControlledEvalMarkdown,
  summarizeControlledEval,
  type ControlledEvalRow,
} from "./controlled-image-edit-report.ts";

type EvalCase = {
  id: string;
  category: string;
  mode: "model" | "kernel";
  intent: string;
  references?: number;
  expectedSubjectReference?: string;
  expectedRoles?: Record<string, string>;
  expectedStrategy?: ControlledImageEditPlan["strategy"];
  expectedMaxSteps?: number;
  signals?: HighConsistencySignal[];
  expected?: string;
};

type EvalFile = { cases: EvalCase[] };

class MeasuringModel implements ModelBackend {
  readonly id: ModelBackend["id"];
  readonly turns: Array<{ request: ModelTurnRequest; result: ModelTurnResult }> = [];
  private readonly base: ModelBackend;

  constructor(base: ModelBackend) {
    this.base = base;
    this.id = base.id;
  }

  async turn(request: ModelTurnRequest, signal: { readonly aborted: boolean }): Promise<ModelTurnResult> {
    const result = await this.base.turn(request, signal);
    this.turns.push({ request, result });
    return result;
  }
}

function usageTotal(turns: MeasuringModel["turns"]): ProviderUsage {
  return turns.reduce<ProviderUsage>((total, turn) => ({
    promptTokens: (total.promptTokens ?? 0) + (turn.result.providerUsage.promptTokens ?? 0),
    completionTokens: (total.completionTokens ?? 0) + (turn.result.providerUsage.completionTokens ?? 0),
    totalTokens: (total.totalTokens ?? 0) + (turn.result.providerUsage.totalTokens ?? 0),
  }), {});
}

function inputFor(testCase: EvalCase): ControlledImageEditInput {
  return {
    schemaVersion: 1,
    intentPrompt: testCase.intent,
    references: Array.from({ length: testCase.references ?? 0 }, (_, index) => ({
      referenceId: `reference-${index + 1}`,
      token: `@图${index + 1}`,
      ordinal: index + 1,
      mime: "image/png",
      bytes: 1_024 + index,
      sha256: sha256Hex(`controlled-eval-reference-${index + 1}`),
      aspectRatio: "1:1",
    })),
  };
}

function safeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /^[A-Za-z0-9._:-]{1,120}$/.test(message) ? message : "controlled_eval_failed";
}

function expectedIntentCorrect(testCase: EvalCase, analysis: IntentAnalysis): boolean {
  if (testCase.expectedSubjectReference && analysis.finalSubjectReferenceId !== testCase.expectedSubjectReference) return false;
  if (testCase.signals && !testCase.signals.every((signal) => analysis.highConsistencySignals.includes(signal))) return false;
  if (testCase.expected === "clarify_or_disclose_assumption") return analysis.assumptions.length > 0;
  if (testCase.expected === "disclose_unknown_view") {
    return analysis.assumptions.some((assumption) => /未知|推测|无法|正面|背面|不可见/.test(assumption));
  }
  return true;
}

function expectedRolesCorrect(testCase: EvalCase, plan: ControlledImageEditPlan): boolean | null {
  if (!testCase.expectedRoles) return null;
  const roles = new Map(plan.referenceRoles.map((role) => [role.referenceId, role.role]));
  return Object.entries(testCase.expectedRoles).every(([referenceId, role]) => roles.get(referenceId) === role);
}

async function runModelCase(testCase: EvalCase, base: ModelBackend): Promise<ControlledEvalRow> {
  const model = new MeasuringModel(base);
  const input = inputFor(testCase);
  let plan: ControlledImageEditPlan | undefined;
  let intentCorrect = false;
  let referenceRolesCorrect: boolean | null = testCase.expectedRoles ? false : null;
  let strategyCorrect: boolean | null = testCase.expectedStrategy ? false : null;
  let overplanned: boolean | null = testCase.expectedMaxSteps === undefined ? null : false;
  let outcome = "failed";
  let structuredSuccess = false;
  let failureCode: string | undefined;
  let evidence = "";
  try {
    const contextHash = sha256Hex(canonicalJson({ input, eval: testCase.id }));
    const turn = await analyzeControlledIntent({
      runId: `eval-${testCase.id}`,
      input,
      model,
      clarificationContextHash: contextHash,
      clarificationCount: 0,
      clarificationHistory: [],
    });
    if (turn.kind === "clarification") {
      outcome = "clarification";
      intentCorrect = testCase.expected === "clarify_or_disclose_assumption";
      structuredSuccess = true;
      evidence = `question=${turn.proposal.questionKey}`;
    } else {
      intentCorrect = expectedIntentCorrect(testCase, turn.analysis);
      evidence = `subject=${turn.analysis.finalSubjectReferenceId ?? "none"};signals=${turn.analysis.highConsistencySignals.join("/") || "none"};assumptions=${turn.analysis.assumptions.length}`;
      const planned = await composeControlledPlan({
        runId: `eval-${testCase.id}`,
        input,
        analysis: turn.analysis,
        expectedSkillHash: turn.skillHash,
        model,
      });
      plan = planned.plan;
      referenceRolesCorrect = expectedRolesCorrect(testCase, plan);
      strategyCorrect = testCase.expectedStrategy ? plan.strategy === testCase.expectedStrategy : null;
      overplanned = testCase.expectedMaxSteps === undefined ? null : plan.steps.length > testCase.expectedMaxSteps;
      outcome = `${plan.strategy}/${plan.steps.length}`;
      evidence += `;roles=${plan.referenceRoles.map((role) => `${role.referenceId}:${role.role}`).join("/") || "none"}`;
      structuredSuccess = true;
    }
  } catch (error) {
    failureCode = safeFailure(error);
  }
  const usage = usageTotal(model.turns);
  return {
    id: testCase.id,
    category: testCase.category,
    mode: "model",
    outcome,
    intentCorrect,
    referenceRolesCorrect,
    strategyCorrect,
    overplanned,
    structuredSuccess,
    toolPrivilegeViolation: false,
    steps: plan?.steps.length ?? 0,
    toolCalls: plan?.steps.length ?? 0,
    promptTokens: usage.promptTokens ?? 0,
    completionTokens: usage.completionTokens ?? 0,
    estimatedCredits: model.turns.length + (plan?.steps.length ?? 0) * 5,
    evidence,
    failureCode,
  };
}

function directInput(intentPrompt = "生成一张海报"): ControlledImageEditInput {
  return { schemaVersion: 1, intentPrompt, references: [] };
}

function directAnalysis(intentPrompt = "生成一张海报"): IntentAnalysis {
  return {
    schemaVersion: 1,
    intentSummary: intentPrompt,
    mustPreserve: [],
    mustTransfer: [],
    mustExclude: [],
    mayChange: [],
    highConsistencySignals: [],
    assumptions: [],
  };
}

function directPlan(analysis: IntentAnalysis, stepId = "generate-final"): ControlledImageEditPlan {
  return {
    schemaVersion: 1,
    intentAnalysisHash: hashIntentAnalysis(analysis),
    intentSummary: analysis.intentSummary,
    strategy: "direct",
    referenceRoles: [],
    assumptions: [],
    steps: [{
      id: stepId,
      kind: "direct_generate",
      goal: analysis.intentSummary,
      inputs: [],
      modifies: ["画面"],
      preserves: [],
      excludes: [],
      outputRole: "final_result",
      rationale: "最短充分步骤",
      estimatedUsage: { generateCalls: 1, understandCalls: 0 },
    }],
  };
}

function policyContext(phase: string, budgetCredits = 48): PolicyContext {
  return {
    runId: "eval-kernel",
    phase,
    manifest: CONTROLLED_IMAGE_EDIT_MANIFEST,
    toolCallCount: 0,
    generateAttemptCount: 0,
    modelTurnCount: 0,
    budget: { budgetCredits, spentCredits: 0 },
    ledger: new ToolLedger(),
    nextLogicalSlot: 0,
    approvedPlanHash: "a".repeat(64),
  };
}

function kernelRow(testCase: EvalCase, passed: boolean, outcome: string, toolPrivilegeViolation = false): ControlledEvalRow {
  return {
    id: testCase.id,
    category: testCase.category,
    mode: "kernel",
    outcome,
    intentCorrect: null,
    referenceRolesCorrect: null,
    strategyCorrect: null,
    overplanned: null,
    structuredSuccess: passed,
    toolPrivilegeViolation,
    steps: 0,
    toolCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    estimatedCredits: 0,
    evidence: `expected=${testCase.expected ?? "kernel_probe"}`,
    failureCode: passed ? undefined : `eval_${testCase.expected ?? "kernel_probe"}_failed`,
  };
}

async function checkpointWithResult(stepId = "generate-final") {
  const input = directInput();
  const analysis = directAnalysis();
  const plan = directPlan(analysis, stepId);
  let checkpoint = createControlledRunnerCheckpoint({
    runId: `eval-${stepId}`,
    conversationId: `conversation-${stepId}`,
    skillVersion: CONTROLLED_IMAGE_EDIT_MANIFEST.version,
    skillHash: "a".repeat(64),
    input,
  });
  checkpoint = proposeControlledPlan(recordControlledIntentAnalysis(checkpoint, analysis), plan);
  checkpoint = decideControlledPlan(checkpoint, { approved: true, proposalHash: checkpoint.proposedPlanHash! });
  checkpoint = await executeNextControlledStep(checkpoint, {
    async generate(request) {
      return {
        artifactId: `artifact-${request.stepId}`,
        mime: "image/png",
        bytes: 100,
        sha256: "b".repeat(64),
      };
    },
  });
  return checkpoint;
}

async function runKernelCase(testCase: EvalCase): Promise<ControlledEvalRow> {
  try {
    switch (testCase.expected) {
      case "policy_denied": {
        const denied = evaluatePolicy(policyContext("analyze_intent_text_only"), "shell", { cmd: "read other user" });
        return kernelRow(testCase, denied.verdict === "deny" && denied.reason === "tool_not_available", denied.verdict === "deny" ? denied.reason : denied.verdict, denied.verdict !== "deny");
      }
      case "no_proactive_inspection": {
        const denied = evaluatePolicy(policyContext("execute_approved_plan"), "understand_image", { assetId: "result" });
        return kernelRow(testCase, denied.verdict === "deny" && denied.reason === "controlled_vision_before_feedback_denied", denied.verdict === "deny" ? denied.reason : denied.verdict, denied.verdict !== "deny");
      }
      case "zero_generation_calls": {
        const input = directInput();
        const analysis = directAnalysis();
        let checkpoint = createControlledRunnerCheckpoint({ runId: "eval-reject", conversationId: "conversation-reject", skillVersion: CONTROLLED_IMAGE_EDIT_MANIFEST.version, skillHash: "a".repeat(64), input });
        checkpoint = proposeControlledPlan(recordControlledIntentAnalysis(checkpoint, analysis), directPlan(analysis));
        checkpoint = decideControlledPlan(checkpoint, { approved: false, proposalHash: checkpoint.proposedPlanHash! });
        return kernelRow(testCase, checkpoint.status === "cancelled" && checkpoint.stepCursor === 0, checkpoint.status);
      }
      case "approved_plan_mismatch": {
        const input = directInput();
        const analysis = directAnalysis();
        let checkpoint = createControlledRunnerCheckpoint({ runId: "eval-mismatch", conversationId: "conversation-mismatch", skillVersion: CONTROLLED_IMAGE_EDIT_MANIFEST.version, skillHash: "a".repeat(64), input });
        checkpoint = proposeControlledPlan(recordControlledIntentAnalysis(checkpoint, analysis), directPlan(analysis));
        checkpoint = decideControlledPlan(checkpoint, { approved: true, proposalHash: checkpoint.proposedPlanHash! });
        checkpoint.proposedPlan!.steps[0].goal = "未审批目标";
        let executed = 0;
        let mismatch = false;
        try {
          await executeNextControlledStep(checkpoint, { async generate() { executed++; throw new Error("must_not_execute"); } });
        } catch (error) {
          mismatch = safeFailure(error) === "controlled_runner_approved_plan_changed";
        }
        return kernelRow(testCase, mismatch && executed === 0, mismatch ? "approved_plan_mismatch" : "mismatch_not_detected", executed > 0);
      }
      case "feedback_diagnosis_then_revision": {
        const checkpoint = submitControlledResultFeedback(await checkpointWithResult(), { action: "retry" });
        return kernelRow(testCase, checkpoint.phase === "diagnose_feedback" && controlledRunnerAllowsVision(checkpoint), checkpoint.phase);
      }
      case "rollback_to_earliest_pose_step": {
        let checkpoint = submitControlledResultFeedback(await checkpointWithResult("pose-edit"), { action: "retry", text: testCase.intent });
        checkpoint = recordControlledFeedbackDiagnosis(checkpoint, {
          schemaVersion: 1,
          summary: "姿态未满足，服装与耳环已满足",
          earliestFailedStepId: "pose-edit",
          failedConstraints: ["姿态"],
          preservedConstraints: ["服装", "耳环"],
          revisionDirective: "从 pose-edit 结果纠正姿态",
          inspectedArtifactIds: ["artifact-pose-edit"],
        });
        return kernelRow(testCase, checkpoint.phase === "compose_revision_plan" && checkpoint.feedbackDiagnosis?.earliestFailedStepId === "pose-edit", checkpoint.feedbackDiagnosis?.earliestFailedStepId ?? checkpoint.phase);
      }
      case "budget_denied": {
        const denied = evaluatePolicy(policyContext("execute_approved_plan", 4), "generate_image", { prompt: "x" });
        return kernelRow(testCase, denied.verdict === "deny" && denied.reason === "insufficient_budget", denied.verdict === "deny" ? denied.reason : denied.verdict, denied.verdict !== "deny");
      }
      default:
        return kernelRow(testCase, false, "unknown_kernel_probe");
    }
  } catch (error) {
    const row = kernelRow(testCase, false, "failed");
    row.failureCode = safeFailure(error);
    return row;
  }
}

async function main(): Promise<void> {
  const evalPath = join(import.meta.dirname, "..", "skills", "bowerbird-controlled-image-edit", "eval-cases.json");
  const evalFile = JSON.parse(readFileSync(evalPath, "utf8")) as EvalFile;
  if (evalFile.cases.length < 10 || evalFile.cases.length > 20) throw new Error("controlled_eval_case_count_invalid");
  const requestedIds = new Set((process.env.CONTROLLED_EVAL_CASES ?? "").split(",").map((id) => id.trim()).filter(Boolean));
  const selectedCases = requestedIds.size
    ? evalFile.cases.filter((testCase) => requestedIds.has(testCase.id))
    : evalFile.cases;
  if (!selectedCases.length || (requestedIds.size && selectedCases.length !== requestedIds.size)) {
    throw new Error("controlled_eval_case_filter_invalid");
  }
  const config = deepSeekConfigFromEnv(process.env);
  const model = new DeepSeekBackend(config);
  const rows: ControlledEvalRow[] = [];
  for (const testCase of selectedCases) {
    const row = testCase.mode === "model"
      ? await runModelCase(testCase, model)
      : await runKernelCase(testCase);
    rows.push(row);
    console.log(`[${row.id}] ${row.structuredSuccess ? "ok" : "FAIL"} ${row.outcome}${row.failureCode ? ` ${row.failureCode}` : ""}`);
  }
  const generatedAt = new Date().toISOString();
  const summary = summarizeControlledEval(rows);
  const artifactsDir = join(import.meta.dirname, "..", "..", "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(join(artifactsDir, "controlled-image-edit-eval.json"), JSON.stringify({ generatedAt, model: config.model, summary, rows }, null, 2), "utf8");
  writeFileSync(join(artifactsDir, "controlled-image-edit-eval.md"), renderControlledEvalMarkdown(rows, generatedAt, config.model), "utf8");
  console.log(`report=${join(artifactsDir, "controlled-image-edit-eval.md")}`);
  if (summary.structuredSuccessRate < 1 || summary.toolPrivilegeViolationRate > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(safeFailure(error));
  process.exitCode = 1;
});
