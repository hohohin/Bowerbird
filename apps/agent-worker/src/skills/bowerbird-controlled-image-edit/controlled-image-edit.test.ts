import { test } from "node:test";
import { deepEqual, equal, ok, throws } from "node:assert/strict";
import type {
  ControlledImageEditInput,
  ControlledImageEditPlan,
  ControlledPlanStep,
  IntentAnalysis,
} from "../../contracts/controlled-image-edit.ts";
import type { ModelBackend, ModelTurnRequest, ModelTurnResult } from "../../contracts/model.ts";
import {
  controlledRunnerAllowsVision,
  createControlledRunnerCheckpoint,
  decideControlledPlan,
  executeNextControlledStep,
  proposeControlledPlan,
  recordControlledIntentAnalysis,
  submitControlledResultFeedback,
} from "../../kernel/controlled-image-edit-runner.ts";
import {
  buildTextOnlyPlanningContext,
  hashControlledPlan,
  hashIntentAnalysis,
  plannedGenerateCalls,
} from "./planner.ts";
import {
  canonicalizeControlledPlanStepKinds,
  ControlledPlanValidationError,
  validateControlledPlan,
} from "./schemas.ts";
import { loadControlledImageEditSkill } from "./loader.ts";
import { analyzeControlledIntent, composeControlledPlan } from "./model-planner.ts";
import { CONTROLLED_IMAGE_EDIT_MANIFEST } from "./manifest.ts";
import { evaluatePolicy } from "../../kernel/policy-engine.ts";
import { ToolLedger } from "../../kernel/tool-ledger.ts";

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const H3 = "3".repeat(64);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function input(): ControlledImageEditInput {
  return {
    schemaVersion: 1,
    intentPrompt: "以图2人物为底图，迁移图1的动作和服装，再佩戴图3耳环；保持人物身份和背景。",
    references: [
      { referenceId: "reference-1", token: "@图1", ordinal: 1, mime: "image/png", bytes: 101, sha256: H1 },
      { referenceId: "reference-2", token: "@图2", ordinal: 2, mime: "image/jpeg", bytes: 202, sha256: H2 },
      { referenceId: "reference-3", token: "@图3", ordinal: 3, mime: "image/webp", bytes: 303, sha256: H3 },
    ],
    ratio: "3:4",
  };
}

function analysis(): IntentAnalysis {
  return {
    schemaVersion: 1,
    intentSummary: "保留图2人物身份与背景，迁移图1动作和服装，并佩戴图3耳环。",
    finalSubjectReferenceId: "reference-2",
    mustPreserve: ["图2人物身份", "图2背景"],
    mustTransfer: [
      { fromReferenceId: "reference-1", attributes: ["动作", "服装"] },
      { fromReferenceId: "reference-3", attributes: ["耳环"] },
    ],
    mustExclude: ["图1人物身份", "图1背景", "图3背景"],
    mayChange: ["完成动作所需的局部遮挡"],
    highConsistencySignals: ["identity", "pose", "garment", "accessory"],
    assumptions: [],
  };
}

function step(
  id: string,
  kind: ControlledPlanStep["kind"],
  inputs: ControlledPlanStep["inputs"],
  outputRole: ControlledPlanStep["outputRole"],
  goal: string,
): ControlledPlanStep {
  return {
    id,
    kind,
    goal,
    inputs,
    modifies: [goal],
    preserves: ["人物身份", "背景"],
    excludes: ["无关身份", "参考背景"],
    outputRole,
    rationale: `隔离${goal}，降低参考串扰`,
    estimatedUsage: { generateCalls: 1, understandCalls: 0 },
  };
}

function stagedPlan(intent: IntentAnalysis): ControlledImageEditPlan {
  return {
    schemaVersion: 1,
    intentAnalysisHash: hashIntentAnalysis(intent),
    intentSummary: intent.intentSummary,
    strategy: "staged_controlled",
    referenceRoles: [
      { referenceId: "reference-1", role: "pose", mustPreserve: [], mustTransfer: ["动作", "服装"], mustExclude: ["身份", "背景"] },
      { referenceId: "reference-2", role: "base", mustPreserve: ["身份", "背景"], mustTransfer: [], mustExclude: [] },
      { referenceId: "reference-3", role: "accessory", mustPreserve: ["耳环结构"], mustTransfer: ["耳环"], mustExclude: ["背景"] },
    ],
    assumptions: [],
    steps: [
      step("pose-control", "generate_control_reference", [{ type: "reference", referenceId: "reference-1" }], "control_reference", "生成身份无关的姿态控制参考"),
      step("garment-control", "generate_control_reference", [{ type: "reference", referenceId: "reference-1" }], "control_reference", "生成无身份服装控制参考"),
      step("pose-edit", "edit_from_previous", [
        { type: "reference", referenceId: "reference-2" },
        { type: "step", stepId: "pose-control" },
      ], "stage_result", "迁移动作"),
      step("garment-edit", "edit_from_previous", [
        { type: "step", stepId: "pose-edit" },
        { type: "step", stepId: "garment-control" },
      ], "stage_result", "迁移服装"),
      step("accessory-edit", "edit_from_previous", [
        { type: "step", stepId: "garment-edit" },
        { type: "reference", referenceId: "reference-3" },
      ], "final_result", "佩戴耳环"),
    ],
  };
}

function directInput(): ControlledImageEditInput {
  return { schemaVersion: 1, intentPrompt: "生成一张极简蓝色海报", references: [] };
}

function directAnalysis(): IntentAnalysis {
  return {
    schemaVersion: 1,
    intentSummary: "生成一张极简蓝色海报",
    mustPreserve: [],
    mustTransfer: [],
    mustExclude: [],
    mayChange: [],
    highConsistencySignals: [],
    assumptions: [],
  };
}

function directPlan(intent: IntentAnalysis): ControlledImageEditPlan {
  return {
    schemaVersion: 1,
    intentAnalysisHash: hashIntentAnalysis(intent),
    intentSummary: intent.intentSummary,
    strategy: "direct",
    referenceRoles: [],
    assumptions: [],
    steps: [step("generate-final", "direct_generate", [], "final_result", "生成最终海报")],
  };
}

test("planning context is text-only and cannot leak image content fields", () => {
  const context = buildTextOnlyPlanningContext(input());
  equal(context.intentPrompt, input().intentPrompt);
  equal(context.references.length, 3);
  const encoded = JSON.stringify(context).toLowerCase();
  for (const forbidden of ["caption", "ocr", "thumbnail", "imagebytes", "dataurl", "objectkey", "localpath"]) {
    equal(encoded.includes(forbidden), false, `must not contain ${forbidden}`);
  }
  deepEqual(Object.keys(context.references[0]).sort(), ["bytes", "mime", "ordinal", "referenceId", "sha256", "token"].sort());
});

test("Kernel resolves automatic output ratio from the text-bound final subject", () => {
  const runInput = input();
  delete runInput.ratio;
  runInput.references[0].aspectRatio = "1:1";
  runInput.references[1].aspectRatio = "9:16";
  runInput.references[2].aspectRatio = "3:2";
  const checkpoint = createControlledRunnerCheckpoint({
    runId: "run-subject-ratio",
    conversationId: "conversation-subject-ratio",
    skillVersion: "0.1.1",
    skillHash: "a".repeat(64),
    input: runInput,
  });
  const resolved = recordControlledIntentAnalysis(checkpoint, analysis());
  equal(resolved.input.ratio, "9:16");

  runInput.ratio = "16:9";
  const explicit = recordControlledIntentAnalysis(createControlledRunnerCheckpoint({
    runId: "run-explicit-ratio",
    conversationId: "conversation-explicit-ratio",
    skillVersion: "0.1.1",
    skillHash: "a".repeat(64),
    input: runInput,
  }), analysis());
  equal(explicit.input.ratio, "16:9");
});

test("built-in skill loader pins one instruction hash for analysis and planning", () => {
  const analysisTurn = loadControlledImageEditSkill();
  const planningTurn = loadControlledImageEditSkill();
  equal(analysisTurn.version, "0.1.1");
  equal(analysisTurn.instructionHash, planningTurn.instructionHash);
  ok(analysisTurn.instructions.includes("计划可以是单步"));
  ok(analysisTurn.instructions.includes("用户不必写引用 token、底图、保持项或专业控制术语"));
  ok(analysisTurn.controlRecipes.includes("产品一致性"));
});

test("analysis and planning model turns load one skill hash and receive text-only context", async () => {
  const intent = analysis();
  const plan = stagedPlan(intent);
  const requests: ModelTurnRequest[] = [];
  const outputs: ModelTurnResult[] = [
    { kind: "action", action: "record_intent_analysis", arguments: { analysis: intent }, providerUsage: { totalTokens: 10 } },
    { kind: "action", action: "submit_plan_for_approval", arguments: { plan }, providerUsage: { totalTokens: 20 } },
  ];
  const model: ModelBackend = {
    id: "fake",
    async turn(request) {
      requests.push(request);
      const output = outputs.shift();
      if (!output) throw new Error("unexpected model turn");
      return output;
    },
  };
  const analyzed = await analyzeControlledIntent({ runId: "run-model", input: input(), model });
  const planned = await composeControlledPlan({
    runId: "run-model",
    input: input(),
    analysis: analyzed.analysis,
    expectedSkillHash: analyzed.skillHash,
    model,
  });
  equal(analyzed.skillHash, planned.skillHash);
  equal(requests[0].allowedActions[0].name, "record_intent_analysis");
  equal(requests[1].allowedActions[0].name, "submit_plan_for_approval");
  const encoded = JSON.stringify(requests.map((request) => request.context)).toLowerCase();
  for (const forbidden of ["caption", "ocr", "thumbnail", "dataurl", "objectkey", "localpath"]) {
    equal(encoded.includes(forbidden), false, `model context must not contain ${forbidden}`);
  }
});

test("initial plan repairs a base-role mismatch for an ordinary three-reference request", async () => {
  const runInput = input();
  runInput.intentPrompt = "参考@图1的人物长相和姿势，为其换上@图2的衣服然后戴上@图3为耳环";
  const intent: IntentAnalysis = {
    schemaVersion: 1,
    intentSummary: "保持图1人物长相和姿势，迁移图2衣服并佩戴图3耳环。",
    finalSubjectReferenceId: "reference-1",
    mustPreserve: ["图1人物身份", "图1姿势"],
    mustTransfer: [
      { fromReferenceId: "reference-2", attributes: ["衣服"] },
      { fromReferenceId: "reference-3", attributes: ["耳环"] },
    ],
    mustExclude: ["图2人物身份", "图2背景", "图3人物身份", "图3背景"],
    mayChange: ["服装", "耳饰"],
    highConsistencySignals: ["identity", "pose", "garment", "accessory"],
    assumptions: [],
  };
  const validPlan: ControlledImageEditPlan = {
    schemaVersion: 1,
    intentAnalysisHash: hashIntentAnalysis(intent),
    intentSummary: intent.intentSummary,
    strategy: "staged_controlled",
    referenceRoles: [
      { referenceId: "reference-1", role: "base", mustPreserve: ["人物身份", "姿势"], mustTransfer: [], mustExclude: [] },
      { referenceId: "reference-2", role: "garment", mustPreserve: ["衣服结构"], mustTransfer: ["衣服"], mustExclude: ["人物", "背景"] },
      { referenceId: "reference-3", role: "accessory", mustPreserve: ["耳环结构"], mustTransfer: ["耳环"], mustExclude: ["人物", "背景"] },
    ],
    assumptions: [],
    steps: [
      step("garment-control", "generate_control_reference", [{ type: "reference", referenceId: "reference-2" }], "control_reference", "提取衣服控制参考"),
      step("garment-edit", "edit_from_previous", [
        { type: "reference", referenceId: "reference-1" },
        { type: "step", stepId: "garment-control" },
      ], "stage_result", "为图1人物换上图2衣服"),
      step("earring-edit", "edit_from_previous", [
        { type: "step", stepId: "garment-edit" },
        { type: "reference", referenceId: "reference-3" },
      ], "final_result", "佩戴图3耳环"),
    ],
  };
  const mismatchedPlan = clone(validPlan);
  mismatchedPlan.referenceRoles[0].role = "identity";
  mismatchedPlan.referenceRoles[1].role = "base";
  const requests: ModelTurnRequest[] = [];
  const roleCorrectButKindsInvalid = clone(validPlan);
  roleCorrectButKindsInvalid.steps[0].kind = "direct_generate";
  roleCorrectButKindsInvalid.steps[2].kind = "direct_generate";
  const outputs: ModelTurnResult[] = [
    { kind: "action", action: "submit_plan_for_approval", arguments: { plan: mismatchedPlan }, providerUsage: {} },
    { kind: "action", action: "submit_plan_for_approval", arguments: { plan: roleCorrectButKindsInvalid }, providerUsage: {} },
  ];
  const model: ModelBackend = {
    id: "fake",
    async turn(request) {
      requests.push(request);
      const output = outputs.shift();
      if (!output) throw new Error("unexpected model turn");
      return output;
    },
  };

  const planned = await composeControlledPlan({
    runId: "run-three-reference-repair",
    input: runInput,
    analysis: intent,
    expectedSkillHash: loadControlledImageEditSkill().instructionHash,
    model,
  });

  equal(planned.plan.referenceRoles.find((role) => role.role === "base")?.referenceId, "reference-1");
  deepEqual(planned.plan.steps.map((item) => item.kind), [
    "generate_control_reference",
    "edit_from_previous",
    "edit_from_previous",
  ]);
  equal(requests.length, 2);
  ok(JSON.stringify(requests[1].context).includes("controlled_plan_base_reference_mismatch"));
  ok(requests[1].systemPolicy.includes("exactly one base"));
});

test("kernel canonicalizes redundant plan step kinds without changing semantic fields", () => {
  const intent = analysis();
  const proposed = stagedPlan(intent);
  proposed.steps[0].kind = "direct_generate";
  proposed.steps.at(-1)!.kind = "generate_control_reference";

  throws(
    () => validateControlledPlan(input(), intent, hashIntentAnalysis(intent), proposed),
    ControlledPlanValidationError,
  );
  const canonical = canonicalizeControlledPlanStepKinds(proposed);
  validateControlledPlan(input(), intent, hashIntentAnalysis(intent), canonical);
  deepEqual(canonical.steps.map((item) => item.kind), [
    "generate_control_reference",
    "generate_control_reference",
    "edit_from_previous",
    "edit_from_previous",
    "edit_from_previous",
  ]);
  deepEqual(canonical.steps.map((item) => item.inputs), proposed.steps.map((item) => item.inputs));
  deepEqual(canonical.referenceRoles, proposed.referenceRoles);
});

test("global policy independently denies vision before feedback for the controlled skill", () => {
  const base = {
    runId: "run-policy",
    manifest: CONTROLLED_IMAGE_EDIT_MANIFEST,
    toolCallCount: 0,
    generateAttemptCount: 0,
    modelTurnCount: 0,
    budget: { budgetCredits: 48, spentCredits: 0 },
    ledger: new ToolLedger(),
    nextLogicalSlot: 0,
  };
  const denied = evaluatePolicy({ ...base, phase: "analyze_intent_text_only" }, "understand_image", { assetId: "input:1" });
  equal(denied.verdict, "deny");
  if (denied.verdict === "deny") equal(denied.reason, "controlled_vision_before_feedback_denied");
  const allowed = evaluatePolicy({ ...base, phase: "diagnose_feedback" }, "understand_image", { assetId: "input:1" });
  equal(allowed.verdict, "allow");
});

test("dynamic plan accepts both one-step direct and the five-call golden shape", () => {
  const simpleInput = directInput();
  const simpleAnalysis = directAnalysis();
  const simplePlan = directPlan(simpleAnalysis);
  validateControlledPlan(simpleInput, simpleAnalysis, hashIntentAnalysis(simpleAnalysis), simplePlan);
  equal(plannedGenerateCalls(simplePlan), 1);

  const complexInput = input();
  const complexAnalysis = analysis();
  const complexPlan = stagedPlan(complexAnalysis);
  validateControlledPlan(complexInput, complexAnalysis, hashIntentAnalysis(complexAnalysis), complexPlan);
  equal(plannedGenerateCalls(complexPlan), 5);
});

test("plan validation rejects forward dependencies, multiple finals and analysis drift", () => {
  const intent = analysis();
  const plan = stagedPlan(intent);
  const forward = clone(plan);
  forward.steps[0].inputs = [{ type: "step", stepId: "pose-edit" }];
  throws(() => validateControlledPlan(input(), intent, hashIntentAnalysis(intent), forward), ControlledPlanValidationError);

  const multipleFinals = clone(plan);
  multipleFinals.steps[3].outputRole = "final_result";
  throws(() => validateControlledPlan(input(), intent, hashIntentAnalysis(intent), multipleFinals), ControlledPlanValidationError);

  const drifted = clone(plan);
  drifted.intentAnalysisHash = "f".repeat(64);
  throws(() => validateControlledPlan(input(), intent, hashIntentAnalysis(intent), drifted), ControlledPlanValidationError);
});

test("runner executes exactly the approved dynamic steps and groups every artifact in one conversation", async () => {
  const intent = analysis();
  const plan = stagedPlan(intent);
  let checkpoint = createControlledRunnerCheckpoint({
    runId: "run-controlled-1",
    conversationId: "conversation-1",
    skillVersion: "0.1.1",
    skillHash: "a".repeat(64),
    input: input(),
  });
  equal(controlledRunnerAllowsVision(checkpoint), false);
  checkpoint = recordControlledIntentAnalysis(checkpoint, intent);
  checkpoint = proposeControlledPlan(checkpoint, plan);
  equal(checkpoint.status, "awaiting_approval");
  checkpoint = decideControlledPlan(checkpoint, { approved: true, proposalHash: checkpoint.proposedPlanHash! });

  const calls: Array<{ stepId: string; inputs: string[]; prompt: string }> = [];
  while (checkpoint.phase === "execute_approved_plan") {
    checkpoint = await executeNextControlledStep(checkpoint, {
      async generate(request) {
        calls.push({ stepId: request.stepId, inputs: request.inputArtifactIds, prompt: request.prompt });
        return {
          artifactId: `artifact:${request.stepId}`,
          mime: "image/png",
          bytes: 1_000,
          sha256: request.callId.slice(0, 64),
        };
      },
    });
  }
  equal(calls.length, 5);
  equal(checkpoint.phase, "awaiting_result_feedback");
  equal(checkpoint.status, "awaiting_result_feedback");
  equal(checkpoint.understandCallCount, 0);
  equal(controlledRunnerAllowsVision(checkpoint), false);
  equal(checkpoint.artifacts.filter((artifact) => artifact.role === "final_result").length, 1);
  ok(checkpoint.artifacts.every((artifact) => artifact.conversationId === "conversation-1"));
  deepEqual(calls[3].inputs, ["artifact:pose-edit", "artifact:garment-control"]);
  ok(calls[4].prompt.includes("只修改"));
});

test("runner resolves a control-plane input artifact by reference stepId, not a synthetic id", async () => {
  const intent = analysis();
  const plan = stagedPlan(intent);
  const runInput = input();
  let checkpoint = createControlledRunnerCheckpoint({
    runId: "run-remote-input",
    conversationId: "conversation-remote-input",
    skillVersion: "0.1.1",
    skillHash: "a".repeat(64),
    input: runInput,
    inputArtifacts: runInput.references.map((reference) => ({
      artifactId: `opaque-artifact-${reference.ordinal}`,
      conversationId: "conversation-remote-input",
      runId: "run-remote-input",
      role: "input",
      stepId: reference.referenceId,
      mime: reference.mime,
      bytes: reference.bytes,
      sha256: reference.sha256,
      userVisible: true,
    })),
  });
  checkpoint = proposeControlledPlan(recordControlledIntentAnalysis(checkpoint, intent), plan);
  checkpoint = decideControlledPlan(checkpoint, { approved: true, proposalHash: checkpoint.proposedPlanHash! });
  let receivedInputs: string[] = [];
  await executeNextControlledStep(checkpoint, {
    async generate(request) {
      receivedInputs = request.inputArtifactIds;
      return { artifactId: "artifact:pose-control", mime: "image/png", bytes: 100, sha256: request.callId.slice(0, 64) };
    },
  });
  deepEqual(receivedInputs, ["opaque-artifact-1"]);
});

test("rejected approval produces no generation and approved plan mutation is denied", async () => {
  const intent = directAnalysis();
  const plan = directPlan(intent);
  let rejected = createControlledRunnerCheckpoint({
    runId: "run-rejected",
    conversationId: "conversation-rejected",
    skillVersion: "0.1.1",
    skillHash: "a".repeat(64),
    input: directInput(),
  });
  rejected = proposeControlledPlan(recordControlledIntentAnalysis(rejected, intent), plan);
  rejected = decideControlledPlan(rejected, { approved: false, proposalHash: rejected.proposedPlanHash! });
  equal(rejected.status, "cancelled");

  let approved = createControlledRunnerCheckpoint({
    runId: "run-mutated",
    conversationId: "conversation-mutated",
    skillVersion: "0.1.1",
    skillHash: "a".repeat(64),
    input: directInput(),
  });
  approved = proposeControlledPlan(recordControlledIntentAnalysis(approved, intent), plan);
  approved = decideControlledPlan(approved, { approved: true, proposalHash: approved.proposedPlanHash! });
  approved.proposedPlan!.steps[0].goal = "未经审批的新目标";
  let error: unknown;
  try {
    await executeNextControlledStep(approved, { async generate() { throw new Error("must_not_execute"); } });
  } catch (caught) {
    error = caught;
  }
  if (!(error instanceof Error)) throw new Error("expected controlled runner error");
  ok(error.message.includes("controlled_runner_approved_plan_changed"));
});

test("vision remains forbidden through first result and opens only after user retry", async () => {
  const intent = directAnalysis();
  const plan = directPlan(intent);
  let checkpoint = createControlledRunnerCheckpoint({
    runId: "run-feedback",
    conversationId: "conversation-feedback",
    skillVersion: "0.1.1",
    skillHash: "a".repeat(64),
    input: directInput(),
  });
  checkpoint = proposeControlledPlan(recordControlledIntentAnalysis(checkpoint, intent), plan);
  checkpoint = decideControlledPlan(checkpoint, { approved: true, proposalHash: checkpoint.proposedPlanHash! });
  checkpoint = await executeNextControlledStep(checkpoint, {
    async generate(request) {
      return { artifactId: "artifact:final", mime: "image/png", bytes: 100, sha256: request.callId.slice(0, 64) };
    },
  });
  equal(controlledRunnerAllowsVision(checkpoint), false);
  checkpoint = submitControlledResultFeedback(checkpoint, { action: "retry", text: "动作不像" });
  equal(checkpoint.phase, "diagnose_feedback");
  equal(controlledRunnerAllowsVision(checkpoint), true);
});

test("plan hashes are stable and bind approval to the full ordered plan", () => {
  const plan = stagedPlan(analysis());
  equal(hashControlledPlan(plan), hashControlledPlan(clone(plan)));
  const reordered = clone(plan);
  [reordered.steps[0], reordered.steps[1]] = [reordered.steps[1], reordered.steps[0]];
  ok(hashControlledPlan(reordered) !== hashControlledPlan(plan));
});
