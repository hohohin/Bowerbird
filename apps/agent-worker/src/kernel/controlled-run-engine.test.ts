import { equal, rejects } from "node:assert/strict";
import { test } from "node:test";

import type { ControlledImageEditPlan, IntentAnalysis } from "../contracts/controlled-image-edit.ts";
import type { PreparedToolCall } from "../control-plane/agent-control-client.ts";
import { FakeModel } from "../fakes/fake-model.ts";
import { hashIntentAnalysis } from "../skills/bowerbird-controlled-image-edit/planner.ts";
import { encodeControlledCheckpoint } from "./controlled-checkpoint.ts";
import {
  controlledClarificationContextHash,
  createControlledRunnerCheckpoint,
  type ApprovedStepExecutor,
  type GenerateApprovedStepRequest,
  type GeneratedApprovedStep,
} from "./controlled-image-edit-runner.ts";
import { loadControlledImageEditSkill } from "../skills/bowerbird-controlled-image-edit/loader.ts";
import { advanceControlledRun, type ControlledRunControl } from "./controlled-run-engine.ts";
import {
  DurableToolDispatcher,
  SimulatedProcessCrash,
  type DurableToolAdapter,
  type DurableToolControl,
  type DurableToolIdentity,
} from "./durable-tool-dispatcher.ts";
import { sha256Hex } from "./tool-ledger.ts";

const intent: IntentAnalysis = {
  schemaVersion: 1,
  intentSummary: "生成一张极简蓝色海报",
  mustPreserve: [],
  mustTransfer: [],
  mustExclude: [],
  mayChange: [],
  highConsistencySignals: [],
  assumptions: [],
};

const plan: ControlledImageEditPlan = {
  schemaVersion: 1,
  intentAnalysisHash: hashIntentAnalysis(intent),
  intentSummary: intent.intentSummary,
  strategy: "direct",
  referenceRoles: [],
  assumptions: [],
  steps: [{
    id: "generate-final",
    kind: "direct_generate",
    goal: "生成最终海报",
    inputs: [],
    modifies: ["画面"],
    preserves: [],
    excludes: [],
    outputRole: "final_result",
    rationale: "任务没有参考图和高一致性约束，单步足够",
    estimatedUsage: { generateCalls: 1, understandCalls: 0 },
  }],
};

class MemoryRunControl implements ControlledRunControl {
  checkpoint?: Parameters<ControlledRunControl["saveCheckpoint"]>[0];
  approvals = 0;
  feedbackPauses = 0;
  finishes = 0;
  clarificationPauses = 0;

  async saveCheckpoint(checkpoint: Parameters<ControlledRunControl["saveCheckpoint"]>[0]): Promise<void> {
    this.checkpoint = JSON.parse(JSON.stringify(checkpoint));
  }

  async requestApproval(): Promise<void> { this.approvals++; }
  async requestClarification(): Promise<void> { this.clarificationPauses++; }
  async awaitResultFeedback(): Promise<void> { this.feedbackPauses++; }
  localTaskPauses = 0;
  async awaitLocalTask(): Promise<{ parked: boolean }> { this.localTaskPauses++; return { parked: true }; }
  async finish(): Promise<void> { this.finishes++; }
}

class MemoryToolControl implements DurableToolControl {
  readonly rows = new Map<string, PreparedToolCall & { argsHash: string }>();

  async prepareTool(args: DurableToolIdentity & { argsHash: string }): Promise<PreparedToolCall> {
    const row = this.rows.get(args.callId);
    if (row) {
      if (row.argsHash !== args.argsHash) throw new Error("call_id_args_hash_conflict");
      return { ...row, reused: true };
    }
    const created: PreparedToolCall & { argsHash: string } = {
      callId: args.callId, argsHash: args.argsHash, status: "prepared", reused: false,
    };
    this.rows.set(args.callId, created);
    return created;
  }

  async markToolSubmitted(args: Pick<DurableToolIdentity, "callId">): Promise<PreparedToolCall> {
    const row = this.required(args.callId);
    row.status = "submitted";
    return row;
  }

  async completeTool(args: Pick<DurableToolIdentity, "callId"> & {
    status: "succeeded" | "failed" | "outcome_unknown";
    resultObjectKey?: string;
    resultHash?: string;
  }): Promise<PreparedToolCall> {
    const row = this.required(args.callId);
    row.status = args.status;
    row.resultObjectKey = args.resultObjectKey;
    row.resultHash = args.resultHash;
    return row;
  }

  private required(callId: string) {
    const row = this.rows.get(callId);
    if (!row) throw new Error("tool_row_missing");
    return row;
  }
}

class RecoverableImageAdapter implements DurableToolAdapter<GenerateApprovedStepRequest, GeneratedApprovedStep> {
  executeCount = 0;
  readonly upstream = new Map<string, GeneratedApprovedStep>();
  readonly stored = new Map<string, GeneratedApprovedStep>();

  async execute(callId: string): Promise<GeneratedApprovedStep> {
    this.executeCount++;
    const value = {
      artifactId: `artifact-${callId.slice(0, 12)}`,
      mime: "image/png",
      bytes: 128,
      sha256: sha256Hex(`image:${callId}`),
    };
    this.upstream.set(callId, value);
    return value;
  }

  async reconcile(callId: string): Promise<GeneratedApprovedStep | null> {
    return this.upstream.get(callId) ?? null;
  }

  async persist(callId: string, result: GeneratedApprovedStep) {
    this.stored.set(callId, result);
    return {
      value: result,
      resultObjectKey: `runs/run-1/tool-results/${callId}.json`,
      resultHash: sha256Hex(JSON.stringify(result)),
    };
  }

  async restore(record: PreparedToolCall): Promise<GeneratedApprovedStep> {
    const value = this.stored.get(record.callId);
    if (!value) throw new Error("tool_result_missing");
    return value;
  }
}

function executor(dispatcher: DurableToolDispatcher<GenerateApprovedStepRequest, GeneratedApprovedStep>): ApprovedStepExecutor {
  return {
    generate: async (request) => await dispatcher.dispatch({
      runId: request.runId,
      leaseId: "lease-1",
      callId: request.callId,
      phase: "execute_approved_plan",
      toolName: "generate_image",
    }, request),
  };
}

test("RunEngine pauses for approval, survives kill after submit, and resumes exactly once", async () => {
  const runControl = new MemoryRunControl();
  const toolControl = new MemoryToolControl();
  const image = new RecoverableImageAdapter();
  const model = new FakeModel([
    { kind: "action", action: "record_intent_analysis", arguments: { analysis: intent }, providerUsage: { totalTokens: 10 } },
    { kind: "action", action: "submit_plan_for_approval", arguments: { plan }, providerUsage: { totalTokens: 10 } },
  ]);
  const claim = {
    runId: "run-1",
    conversationId: "conversation-1",
    skillVersion: "0.1.1",
    approvedPlanHash: null,
    resultFeedbackAction: null,
  } as const;
  const first = await advanceControlledRun({
    claim,
    input: { schemaVersion: 1, intentPrompt: intent.intentSummary, references: [] },
    model,
    executor: executor(new DurableToolDispatcher(toolControl, image)),
    control: runControl,
  });
  equal(first.outcome, "awaiting_approval");
  equal(runControl.approvals, 1);
  equal(model.remaining(), 0);

  const recoveredPause = await advanceControlledRun({
    claim,
    checkpoint: first.checkpoint,
    model: new FakeModel([]),
    executor: executor(new DurableToolDispatcher(toolControl, image)),
    control: runControl,
  });
  equal(recoveredPause.outcome, "awaiting_approval");
  equal(runControl.approvals, 2);

  const approvedHash = first.checkpoint.proposedPlanHash!;
  const crashingDispatcher = new DurableToolDispatcher(toolControl, image, {
    afterExecute: () => { throw new SimulatedProcessCrash(); },
  });
  await rejects(() => advanceControlledRun({
    claim: { ...claim, approvedPlanHash: approvedHash },
    checkpoint: first.checkpoint,
    model: new FakeModel([]),
    executor: executor(crashingDispatcher),
    control: runControl,
  }), /simulated_process_crash/);
  equal(image.executeCount, 1);
  equal(runControl.checkpoint?.stepCursor, 0);

  const resumed = await advanceControlledRun({
    claim: { ...claim, approvedPlanHash: approvedHash },
    checkpoint: runControl.checkpoint,
    model: new FakeModel([]),
    executor: executor(new DurableToolDispatcher(toolControl, image)),
    control: runControl,
  });
  equal(resumed.outcome, "awaiting_result_feedback");
  equal(image.executeCount, 1);
  equal(resumed.checkpoint.stepCursor, 1);
  equal(resumed.checkpoint.artifacts.filter((item) => item.role === "final_result").length, 1);
  equal(runControl.feedbackPauses, 1);

  const recoveredFeedbackPause = await advanceControlledRun({
    claim: { ...claim, approvedPlanHash: approvedHash },
    checkpoint: resumed.checkpoint,
    model: new FakeModel([]),
    executor: executor(new DurableToolDispatcher(toolControl, image)),
    control: runControl,
  });
  equal(recoveredFeedbackPause.outcome, "awaiting_result_feedback");
  equal(runControl.feedbackPauses, 2);

  const accepted = await advanceControlledRun({
    claim: { ...claim, approvedPlanHash: approvedHash, resultFeedbackAction: "accept" },
    checkpoint: resumed.checkpoint,
    model: new FakeModel([]),
    executor: executor(new DurableToolDispatcher(toolControl, image)),
    control: runControl,
  });
  equal(accepted.outcome, "succeeded");
  equal(runControl.finishes, 1);
  equal(image.executeCount, 1);

  const recoveredFinish = await advanceControlledRun({
    claim: { ...claim, approvedPlanHash: approvedHash, resultFeedbackAction: "accept" },
    checkpoint: accepted.checkpoint,
    model: new FakeModel([]),
    executor: executor(new DurableToolDispatcher(toolControl, image)),
    control: runControl,
  });
  equal(recoveredFinish.outcome, "succeeded");
  equal(runControl.finishes, 2);
});

test("user retry triggers one vision diagnosis, a new approval, and only then one corrective generation", async () => {
  const runControl = new MemoryRunControl();
  const toolControl = new MemoryToolControl();
  const image = new RecoverableImageAdapter();
  const approvedExecutor = executor(new DurableToolDispatcher(toolControl, image));
  const claim = {
    runId: "run-1",
    conversationId: "conversation-1",
    skillVersion: "0.1.1",
    approvedPlanHash: null,
    resultFeedbackAction: null,
  } as const;
  const planned = await advanceControlledRun({
    claim,
    input: { schemaVersion: 1, intentPrompt: intent.intentSummary, references: [] },
    model: new FakeModel([
      { kind: "action", action: "record_intent_analysis", arguments: { analysis: intent }, providerUsage: {} },
      { kind: "action", action: "submit_plan_for_approval", arguments: { plan }, providerUsage: {} },
    ]),
    executor: approvedExecutor,
    control: runControl,
  });
  const firstResult = await advanceControlledRun({
    claim: { ...claim, approvedPlanHash: planned.checkpoint.proposedPlanHash! },
    checkpoint: planned.checkpoint,
    model: new FakeModel([]),
    executor: approvedExecutor,
    control: runControl,
  });
  equal(firstResult.outcome, "awaiting_result_feedback");

  const revisionPlan: ControlledImageEditPlan = {
    ...plan,
    intentSummary: "按用户反馈只修订上一版最终图",
    steps: [{
      id: "revision-1-final",
      kind: "direct_generate",
      goal: "修复背景，同时保持上一版已满足内容",
      inputs: [{ type: "step", stepId: "generate-final" }],
      modifies: ["用户指出的失败约束"],
      preserves: ["上一版已满足内容"],
      excludes: [],
      outputRole: "final_result",
      rationale: "只重做最早失败步骤",
      estimatedUsage: { generateCalls: 1, understandCalls: 0 },
    }],
  };
  const invalidRevisionPlan: ControlledImageEditPlan = {
    ...revisionPlan,
    steps: [{ ...revisionPlan.steps[0], inputs: [] }],
  };
  let diagnosisCalls = 0;
  const revision = await advanceControlledRun({
    claim: {
      ...claim,
      approvedPlanHash: planned.checkpoint.proposedPlanHash!,
      resultFeedbackAction: "retry",
      feedbackText: "背景仍不够浅蓝",
    },
    checkpoint: firstResult.checkpoint,
    model: new FakeModel([
      { kind: "action", action: "submit_plan_for_approval", arguments: { plan: invalidRevisionPlan }, providerUsage: {} },
      { kind: "action", action: "submit_plan_for_approval", arguments: { plan: revisionPlan }, providerUsage: {} },
    ]),
    executor: approvedExecutor,
    diagnoser: {
      diagnose: async ({ checkpoint }) => {
        diagnosisCalls++;
        return {
          schemaVersion: 1,
          summary: "背景颜色未满足",
          earliestFailedStepId: "generate-final",
          failedConstraints: ["浅蓝背景"],
          preservedConstraints: ["主体"],
          revisionDirective: "仅调整背景颜色",
          inspectedArtifactIds: checkpoint.artifacts.filter((item) => item.role === "final_result").map((item) => item.artifactId),
        };
      },
    },
    control: runControl,
  });
  equal(revision.outcome, "awaiting_approval");
  equal(diagnosisCalls, 1);
  equal(revision.checkpoint.revisionIndex, 1);
  equal(revision.checkpoint.understandCallCount, 1);
  equal(revision.checkpoint.artifacts.filter((item) => item.role === "final_result").length, 0);
  equal(image.executeCount, 1);
  encodeControlledCheckpoint(revision.checkpoint);

  const revisedResult = await advanceControlledRun({
    claim: {
      ...claim,
      approvedPlanHash: revision.checkpoint.proposedPlanHash!,
      resultFeedbackAction: "retry",
      feedbackText: "背景仍不够浅蓝",
    },
    checkpoint: revision.checkpoint,
    model: new FakeModel([]),
    executor: approvedExecutor,
    control: runControl,
  });
  equal(revisedResult.outcome, "awaiting_result_feedback");
  equal(image.executeCount, 2);
  equal(revisedResult.checkpoint.artifacts.filter((item) => item.role === "final_result").length, 1);
  equal(revisedResult.checkpoint.artifacts.filter((item) => item.role === "stage_result").length, 1);
});

test("RunEngine parks for one clarification, applies IntentPatch, then requires a fresh plan approval", async () => {
  const skill = loadControlledImageEditSkill();
  const input = { schemaVersion: 1 as const, intentPrompt: intent.intentSummary, references: [] };
  const initial = createControlledRunnerCheckpoint({
    runId: "run-clarify",
    conversationId: "conversation-clarify",
    skillVersion: skill.version,
    skillHash: skill.instructionHash,
    input,
  });
  const contextHash = controlledClarificationContextHash(initial);
  const control = new MemoryRunControl();
  const claim = {
    runId: initial.runId,
    conversationId: initial.conversationId,
    skillVersion: skill.version,
    approvedPlanHash: null,
    resultFeedbackAction: null,
  } as const;
  const first = await advanceControlledRun({
    claim,
    checkpoint: initial,
    model: new FakeModel([{
      kind: "action",
      action: "request_clarification",
      arguments: { proposal: {
        questionKey: "choose.strategy",
        contextHash,
        question: "输出应采用直接生成还是受控多步？",
        recommendedAnswer: "直接生成",
        options: ["直接生成", "受控多步"],
        optionPatches: [
          { answer: "直接生成", patches: [{ field: "strategy", op: "set", value: "direct" }] },
          { answer: "受控多步", patches: [{ field: "strategy", op: "set", value: "controlled" }] },
        ],
        affectedIntentFields: ["strategy"],
        rationale: "路线会改变步骤数量和成本。",
      } },
      providerUsage: {},
    }]),
    executor: { generate: async () => { throw new Error("unexpected_generate"); } },
    control,
  });
  equal(first.outcome, "awaiting_clarification");
  equal(control.clarificationPauses, 1);
  equal(control.approvals, 0);

  const resumed = await advanceControlledRun({
    claim,
    checkpoint: first.checkpoint,
    clarificationPatch: {
      sourceQuestionKey: "choose.strategy",
      contextHash,
      patches: [{ field: "strategy", op: "set", value: "direct" }],
    },
    model: new FakeModel([
      { kind: "action", action: "record_intent_analysis", arguments: { analysis: intent }, providerUsage: {} },
      { kind: "action", action: "submit_plan_for_approval", arguments: { plan }, providerUsage: {} },
    ]),
    executor: { generate: async () => { throw new Error("unexpected_generate"); } },
    control,
  });
  equal(resumed.outcome, "awaiting_approval");
  equal(control.approvals, 1);
  equal(resumed.checkpoint.intentOverrides?.strategy, "direct");
  equal(resumed.checkpoint.clarificationHistory?.[0].status, "answered");
  equal(resumed.checkpoint.approvedPlanHash, undefined);
});

test("malformed clarification gets one corrective model retry and never parks", async () => {
  const skill = loadControlledImageEditSkill();
  const input = { schemaVersion: 1 as const, intentPrompt: intent.intentSummary, references: [] };
  const initial = createControlledRunnerCheckpoint({
    runId: "run-malformed-clarify",
    conversationId: "conversation-malformed-clarify",
    skillVersion: skill.version,
    skillHash: skill.instructionHash,
    input,
  });
  const contextHash = controlledClarificationContextHash(initial);
  const control = new MemoryRunControl();
  const result = await advanceControlledRun({
    claim: {
      runId: initial.runId,
      conversationId: initial.conversationId,
      skillVersion: skill.version,
      approvedPlanHash: null,
      resultFeedbackAction: null,
    },
    checkpoint: initial,
    model: new FakeModel([
      {
        kind: "action",
        action: "request_clarification",
        arguments: { proposal: {
          questionKey: "bad.options",
          contextHash,
          question: "选择路线？",
          recommendedAnswer: "不存在的选项",
          options: ["直接", "受控"],
          optionPatches: [
            { answer: "直接", patches: [{ field: "strategy", op: "set", value: "direct" }] },
            { answer: "受控", patches: [{ field: "strategy", op: "set", value: "controlled" }] },
          ],
          affectedIntentFields: ["strategy"],
          rationale: "路线不同。",
        } },
        providerUsage: {},
      },
      { kind: "action", action: "record_intent_analysis", arguments: { analysis: intent }, providerUsage: {} },
      { kind: "action", action: "submit_plan_for_approval", arguments: { plan }, providerUsage: {} },
    ]),
    executor: { generate: async () => { throw new Error("unexpected_generate"); } },
    control,
  });
  equal(result.outcome, "awaiting_approval");
  equal(control.clarificationPauses, 0);
  equal(control.approvals, 1);
});
