import type {
  ControlledImageEditInput,
  ControlledImageEditPlan,
  ControlledFeedbackDiagnosis,
  ControlledRunArtifact,
  IntentAnalysis,
} from "../contracts/controlled-image-edit.ts";
import type { RunStatus } from "../contracts/run.ts";
import { deriveCallId } from "./tool-ledger.ts";
import {
  canUseVisionInControlledPhase,
  nextControlledPhase,
  type ControlledImageEditPhase,
} from "../skills/bowerbird-controlled-image-edit/phase-graph.ts";
import {
  compileApprovedStepPrompt,
  hashControlledPlan,
  hashIntentAnalysis,
  plannedGenerateCalls,
} from "../skills/bowerbird-controlled-image-edit/planner.ts";
import {
  validateControlledInput,
  validateControlledFeedbackDiagnosis,
  validateControlledPlan,
  validateIntentAnalysis,
} from "../skills/bowerbird-controlled-image-edit/schemas.ts";

export type ControlledRunnerCheckpoint = {
  schemaVersion: 1;
  runId: string;
  conversationId: string;
  skillId: "bowerbird-controlled-image-edit";
  skillVersion: string;
  skillHash: string;
  status: RunStatus;
  phase: ControlledImageEditPhase;
  revisionIndex: number;
  revisionBaseStepIds?: string[];
  input: ControlledImageEditInput;
  intentAnalysis?: IntentAnalysis;
  intentAnalysisHash?: string;
  proposedPlan?: ControlledImageEditPlan;
  proposedPlanHash?: string;
  approvedPlanHash?: string;
  plannedToolCount: number;
  stepCursor: number;
  artifacts: ControlledRunArtifact[];
  feedback?: string;
  feedbackDiagnosis?: ControlledFeedbackDiagnosis;
  understandCallCount: number;
};

export type GenerateApprovedStepRequest = {
  runId: string;
  conversationId: string;
  callId: string;
  stepId: string;
  prompt: string;
  inputArtifactIds: string[];
  parentArtifactId?: string;
  outputRole: "control_reference" | "stage_result" | "final_result";
  ratio?: string;
};

export type GeneratedApprovedStep = {
  artifactId: string;
  mime: string;
  bytes: number;
  sha256: string;
};

export interface ApprovedStepExecutor {
  generate(request: GenerateApprovedStepRequest): Promise<GeneratedApprovedStep>;
}

export interface ControlledFeedbackDiagnoser {
  diagnose(request: {
    checkpoint: ControlledRunnerCheckpoint;
    feedback: string;
  }): Promise<ControlledFeedbackDiagnosis>;
}

function fail(code: string): never {
  throw new Error(code);
}

function inputArtifacts(
  runId: string,
  conversationId: string,
  input: ControlledImageEditInput,
): ControlledRunArtifact[] {
  return input.references.map((reference) => ({
    artifactId: `input:${reference.referenceId}`,
    conversationId,
    runId,
    role: "input",
    stepId: reference.referenceId,
    mime: reference.mime,
    bytes: reference.bytes,
    sha256: reference.sha256,
    userVisible: true,
  }));
}

export function createControlledRunnerCheckpoint(args: {
  runId: string;
  conversationId: string;
  skillVersion: string;
  skillHash: string;
  input: ControlledImageEditInput;
  inputArtifacts?: ControlledRunArtifact[];
}): ControlledRunnerCheckpoint {
  validateControlledInput(args.input);
  if (!args.runId || !args.conversationId || !args.skillHash) fail("controlled_runner_identity_required");
  const artifacts = args.inputArtifacts ?? inputArtifacts(args.runId, args.conversationId, args.input);
  if (artifacts.length !== args.input.references.length || artifacts.some((artifact) =>
    artifact.runId !== args.runId || artifact.conversationId !== args.conversationId || artifact.role !== "input" ||
    !args.input.references.some((reference) => reference.referenceId === artifact.stepId &&
      reference.mime === artifact.mime && reference.bytes === artifact.bytes && reference.sha256 === artifact.sha256)
  )) fail("controlled_runner_input_artifacts_invalid");
  return {
    schemaVersion: 1,
    runId: args.runId,
    conversationId: args.conversationId,
    skillId: "bowerbird-controlled-image-edit",
    skillVersion: args.skillVersion,
    skillHash: args.skillHash,
    status: "running",
    phase: "analyze_intent_text_only",
    revisionIndex: 0,
    input: args.input,
    plannedToolCount: 0,
    stepCursor: 0,
    artifacts,
    understandCallCount: 0,
  };
}

export function recordControlledIntentAnalysis(
  checkpoint: ControlledRunnerCheckpoint,
  analysis: IntentAnalysis,
): ControlledRunnerCheckpoint {
  if (checkpoint.phase !== "analyze_intent_text_only") fail("controlled_runner_wrong_analysis_phase");
  validateIntentAnalysis(checkpoint.input, analysis);
  const subjectRatio = analysis.finalSubjectReferenceId
    ? checkpoint.input.references.find((reference) => reference.referenceId === analysis.finalSubjectReferenceId)?.aspectRatio
    : undefined;
  return {
    ...checkpoint,
    input: checkpoint.input.ratio || !subjectRatio
      ? checkpoint.input
      : { ...checkpoint.input, ratio: subjectRatio },
    phase: nextControlledPhase(checkpoint.phase, "intent_recorded"),
    intentAnalysis: analysis,
    intentAnalysisHash: hashIntentAnalysis(analysis),
  };
}

export function proposeControlledPlan(
  checkpoint: ControlledRunnerCheckpoint,
  plan: ControlledImageEditPlan,
): ControlledRunnerCheckpoint {
  if (checkpoint.phase !== "compose_plan_with_skill") fail("controlled_runner_wrong_plan_phase");
  if (!checkpoint.intentAnalysis || !checkpoint.intentAnalysisHash) fail("controlled_runner_analysis_missing");
  validateControlledPlan(checkpoint.input, checkpoint.intentAnalysis, checkpoint.intentAnalysisHash, plan);
  const proposedPlanHash = hashControlledPlan(plan);
  return {
    ...checkpoint,
    phase: nextControlledPhase(checkpoint.phase, "plan_proposed"),
    status: "awaiting_approval",
    proposedPlan: plan,
    proposedPlanHash,
    plannedToolCount: plannedGenerateCalls(plan),
    stepCursor: 0,
  };
}

export function decideControlledPlan(
  checkpoint: ControlledRunnerCheckpoint,
  decision: { approved: boolean; proposalHash: string },
): ControlledRunnerCheckpoint {
  if (checkpoint.phase !== "awaiting_plan_approval" && checkpoint.phase !== "awaiting_revision_approval") {
    fail("controlled_runner_wrong_approval_phase");
  }
  if (!checkpoint.proposedPlanHash || decision.proposalHash !== checkpoint.proposedPlanHash) {
    fail("controlled_runner_approval_hash_mismatch");
  }
  if (!decision.approved) {
    return {
      ...checkpoint,
      phase: nextControlledPhase(checkpoint.phase, "plan_rejected"),
      status: "cancelled",
    };
  }
  return {
    ...checkpoint,
    phase: nextControlledPhase(
      checkpoint.phase,
      checkpoint.phase === "awaiting_plan_approval" ? "plan_approved" : "revision_approved",
    ),
    status: "running",
    approvedPlanHash: checkpoint.proposedPlanHash,
    stepCursor: 0,
  };
}

function resolveStepInputs(
  checkpoint: ControlledRunnerCheckpoint,
  stepIndex: number,
): { ids: string[]; parentArtifactId?: string } {
  const plan = checkpoint.proposedPlan;
  if (!plan) fail("controlled_runner_plan_missing");
  const step = plan.steps[stepIndex];
  if (!step) fail("controlled_runner_step_missing");
  const ids: string[] = [];
  let parentArtifactId: string | undefined;
  for (const binding of step.inputs) {
    if (binding.type === "reference") {
      // Local fixtures use `input:<referenceId>`, while the real control plane
      // assigns an opaque artifact UUID. The stable reference binding is the
      // input artifact's stepId, not its storage/database identifier.
      const artifact = checkpoint.artifacts.find((item) =>
        item.role === "input" && item.stepId === binding.referenceId
      );
      if (!artifact) fail("controlled_runner_reference_artifact_missing");
      ids.push(artifact.artifactId);
      if (!parentArtifactId) parentArtifactId = artifact.artifactId;
    } else {
      const artifact = checkpoint.artifacts.find((item) => item.role !== "input" && item.stepId === binding.stepId);
      if (!artifact) fail("controlled_runner_step_artifact_missing");
      ids.push(artifact.artifactId);
      parentArtifactId = artifact.artifactId;
    }
  }
  return { ids, parentArtifactId };
}

/** 每次只执行批准计划的当前一步；执行完成后保存 checkpoint 再推进。 */
export async function executeNextControlledStep(
  checkpoint: ControlledRunnerCheckpoint,
  executor: ApprovedStepExecutor,
): Promise<ControlledRunnerCheckpoint> {
  if (checkpoint.phase !== "execute_approved_plan") fail("controlled_runner_wrong_execution_phase");
  if (!checkpoint.proposedPlan || !checkpoint.approvedPlanHash) fail("controlled_runner_approved_plan_missing");
  if (hashControlledPlan(checkpoint.proposedPlan) !== checkpoint.approvedPlanHash) {
    fail("controlled_runner_approved_plan_changed");
  }
  const step = checkpoint.proposedPlan.steps[checkpoint.stepCursor];
  if (!step) fail("controlled_runner_step_cursor_invalid");
  const resolved = resolveStepInputs(checkpoint, checkpoint.stepCursor);
  const callId = deriveCallId({
    runId: checkpoint.runId,
    phase: "execute_approved_plan",
    logicalSlot: checkpoint.stepCursor,
    revisionIndex: checkpoint.revisionIndex,
  });
  const generated = await executor.generate({
    runId: checkpoint.runId,
    conversationId: checkpoint.conversationId,
    callId,
    stepId: step.id,
    prompt: compileApprovedStepPrompt(checkpoint.proposedPlan, step),
    inputArtifactIds: resolved.ids,
    parentArtifactId: resolved.parentArtifactId,
    outputRole: step.outputRole,
    ratio: step.outputRole === "control_reference"
      ? step.inputs
        .map((binding) => binding.type === "reference"
          ? checkpoint.input.references.find((reference) => reference.referenceId === binding.referenceId)?.aspectRatio
          : undefined)
        .find((ratio): ratio is string => !!ratio) ?? checkpoint.input.ratio
      : checkpoint.input.ratio,
  });
  if (!generated.artifactId || !generated.mime.startsWith("image/") || generated.bytes <= 0 || !/^[0-9a-f]{64}$/.test(generated.sha256)) {
    fail("controlled_runner_generated_artifact_invalid");
  }
  const artifact: ControlledRunArtifact = {
    artifactId: generated.artifactId,
    conversationId: checkpoint.conversationId,
    runId: checkpoint.runId,
    role: step.outputRole,
    stepId: step.id,
    parentArtifactId: resolved.parentArtifactId,
    mime: generated.mime,
    bytes: generated.bytes,
    sha256: generated.sha256,
    userVisible: true,
  };
  let next: ControlledRunnerCheckpoint = {
    ...checkpoint,
    stepCursor: checkpoint.stepCursor + 1,
    artifacts: [...checkpoint.artifacts, artifact],
  };
  if (next.stepCursor === checkpoint.proposedPlan.steps.length) {
    const finals = next.artifacts.filter((item) => item.role === "final_result");
    if (finals.length !== 1) fail("controlled_runner_final_artifact_count_invalid");
    next = {
      ...next,
      phase: nextControlledPhase(next.phase, "execution_completed"),
    };
    next = {
      ...next,
      phase: nextControlledPhase(next.phase, "finalized_without_inspection"),
      status: "awaiting_result_feedback",
    };
  }
  return next;
}

export function submitControlledResultFeedback(
  checkpoint: ControlledRunnerCheckpoint,
  feedback: { action: "accept" | "retry"; text?: string },
): ControlledRunnerCheckpoint {
  if (checkpoint.phase !== "awaiting_result_feedback") fail("controlled_runner_wrong_feedback_phase");
  if (feedback.action === "accept") {
    return {
      ...checkpoint,
      phase: nextControlledPhase(checkpoint.phase, "result_accepted"),
      status: "exporting",
    };
  }
  return {
    ...checkpoint,
    phase: nextControlledPhase(checkpoint.phase, "feedback_received"),
    status: "running",
    feedback: feedback.text?.trim() || "retry_without_text",
  };
}

export function recordControlledFeedbackDiagnosis(
  checkpoint: ControlledRunnerCheckpoint,
  diagnosis: ControlledFeedbackDiagnosis,
): ControlledRunnerCheckpoint {
  if (checkpoint.phase !== "diagnose_feedback") fail("controlled_runner_wrong_diagnosis_phase");
  if (!checkpoint.proposedPlan || !checkpoint.feedback) fail("controlled_runner_feedback_context_missing");
  validateControlledFeedbackDiagnosis(checkpoint.proposedPlan, checkpoint.artifacts, diagnosis);
  return {
    ...checkpoint,
    phase: nextControlledPhase(checkpoint.phase, "diagnosis_completed"),
    feedbackDiagnosis: diagnosis,
    understandCallCount: checkpoint.understandCallCount + 1,
  };
}

export function proposeControlledRevisionPlan(
  checkpoint: ControlledRunnerCheckpoint,
  plan: ControlledImageEditPlan,
): ControlledRunnerCheckpoint {
  if (checkpoint.phase !== "compose_revision_plan") fail("controlled_runner_wrong_revision_phase");
  if (!checkpoint.intentAnalysis || !checkpoint.intentAnalysisHash || !checkpoint.feedbackDiagnosis) {
    fail("controlled_runner_revision_context_missing");
  }
  const priorStepIds = checkpoint.artifacts
    .map((artifact) => artifact.stepId)
    .filter((stepId): stepId is string => !!stepId && artifactIsGenerated(checkpoint.artifacts, stepId));
  validateControlledPlan(
    checkpoint.input,
    checkpoint.intentAnalysis,
    checkpoint.intentAnalysisHash,
    plan,
    { priorStepIds, requirePriorArtifactInput: true },
  );
  return {
    ...checkpoint,
    phase: nextControlledPhase(checkpoint.phase, "revision_proposed"),
    status: "awaiting_approval",
    revisionIndex: checkpoint.revisionIndex + 1,
    revisionBaseStepIds: priorStepIds,
    proposedPlan: plan,
    proposedPlanHash: hashControlledPlan(plan),
    approvedPlanHash: undefined,
    plannedToolCount: plannedGenerateCalls(plan),
    stepCursor: 0,
    artifacts: checkpoint.artifacts.map((artifact) =>
      artifact.role === "final_result" ? { ...artifact, role: "stage_result" as const } : artifact
    ),
  };
}

function artifactIsGenerated(artifacts: ControlledRunArtifact[], stepId: string): boolean {
  return artifacts.some((artifact) => artifact.stepId === stepId && artifact.role !== "input");
}

export function controlledRunnerAllowsVision(checkpoint: ControlledRunnerCheckpoint): boolean {
  return canUseVisionInControlledPhase(checkpoint.phase);
}

export function completeControlledExport(checkpoint: ControlledRunnerCheckpoint): ControlledRunnerCheckpoint {
  if (checkpoint.phase !== "exporting") fail("controlled_runner_wrong_export_phase");
  return {
    ...checkpoint,
    phase: nextControlledPhase(checkpoint.phase, "export_completed"),
    status: "succeeded",
  };
}
