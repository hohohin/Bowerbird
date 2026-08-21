import type { ControlledImageEditInput, ControlledRunArtifact } from "../contracts/controlled-image-edit.ts";
import type { ModelBackend } from "../contracts/model.ts";
import { loadControlledImageEditSkill } from "../skills/bowerbird-controlled-image-edit/loader.ts";
import {
  analyzeControlledIntent,
  composeControlledPlan,
  composeControlledRevisionPlan,
} from "../skills/bowerbird-controlled-image-edit/model-planner.ts";
import type { AgentLeaseSignal } from "../cloud-agent/runtime.ts";
import {
  completeControlledExport,
  createControlledRunnerCheckpoint,
  decideControlledPlan,
  executeNextControlledStep,
  proposeControlledPlan,
  proposeControlledRevisionPlan,
  recordControlledFeedbackDiagnosis,
  recordControlledIntentAnalysis,
  submitControlledResultFeedback,
  type ApprovedStepExecutor,
  type ControlledFeedbackDiagnoser,
  type ControlledRunnerCheckpoint,
} from "./controlled-image-edit-runner.ts";

export type ControlledRunClaimState = {
  runId: string;
  conversationId: string;
  skillVersion: string;
  approvedPlanHash: string | null;
  resultFeedbackAction: "accept" | "retry" | null;
  feedbackText?: string;
};

export type ControlledRunEngineOutcome =
  | "awaiting_approval"
  | "awaiting_result_feedback"
  | "awaiting_revision"
  | "stopped"
  | "succeeded"
  | "cancelled";

export interface ControlledRunControl {
  saveCheckpoint(checkpoint: ControlledRunnerCheckpoint, progress: number): Promise<void>;
  requestApproval(args: {
    checkpoint: ControlledRunnerCheckpoint;
    kind: "controlled_image_edit_plan" | "controlled_image_edit_revision";
    estimatedAdditionalCredits: number;
  }): Promise<void>;
  awaitResultFeedback(checkpoint: ControlledRunnerCheckpoint): Promise<void>;
  finish(checkpoint: ControlledRunnerCheckpoint): Promise<void>;
}

export type AdvanceControlledRunRequest = {
  claim: ControlledRunClaimState;
  checkpoint?: ControlledRunnerCheckpoint;
  input?: ControlledImageEditInput;
  inputArtifacts?: ControlledRunArtifact[];
  model: ModelBackend;
  executor: ApprovedStepExecutor;
  diagnoser?: ControlledFeedbackDiagnoser;
  control: ControlledRunControl;
  signal?: AgentLeaseSignal;
};

function stopped(signal: AgentLeaseSignal | undefined): boolean {
  return !!signal && (signal.cancelRequested || signal.leaseLost || signal.stopRequested);
}

function assertPinnedIdentity(checkpoint: ControlledRunnerCheckpoint, claim: ControlledRunClaimState): void {
  const skill = loadControlledImageEditSkill();
  if (checkpoint.runId !== claim.runId || checkpoint.conversationId !== claim.conversationId) {
    throw new Error("controlled_engine_checkpoint_identity_mismatch");
  }
  if (checkpoint.skillVersion !== claim.skillVersion || checkpoint.skillVersion !== skill.version || checkpoint.skillHash !== skill.instructionHash) {
    throw new Error("controlled_engine_skill_mismatch");
  }
}

function progress(checkpoint: ControlledRunnerCheckpoint): number {
  switch (checkpoint.phase) {
    case "analyze_intent_text_only": return 5;
    case "compose_plan_with_skill": return 20;
    case "awaiting_plan_approval":
    case "awaiting_revision_approval": return 35;
    case "execute_approved_plan": {
      const steps = checkpoint.proposedPlan?.steps.length ?? 1;
      return 40 + Math.floor((checkpoint.stepCursor / steps) * 45);
    }
    case "awaiting_result_feedback": return 90;
    case "diagnose_feedback":
    case "compose_revision_plan": return 92;
    case "exporting": return 95;
    case "succeeded": return 100;
    default: return 0;
  }
}

function createInitial(request: AdvanceControlledRunRequest): ControlledRunnerCheckpoint {
  if (!request.input) throw new Error("controlled_engine_input_required");
  const skill = loadControlledImageEditSkill();
  if (request.claim.skillVersion !== skill.version) throw new Error("controlled_engine_skill_version_unavailable");
  return createControlledRunnerCheckpoint({
    runId: request.claim.runId,
    conversationId: request.claim.conversationId,
    skillVersion: skill.version,
    skillHash: skill.instructionHash,
    input: request.input,
    inputArtifacts: request.inputArtifacts,
  });
}

/**
 * Advances one claimed Run until a control-plane pause or terminal state.
 * Every deterministic phase/step mutation is checkpointed before the next action.
 */
export async function advanceControlledRun(request: AdvanceControlledRunRequest): Promise<{
  checkpoint: ControlledRunnerCheckpoint;
  outcome: ControlledRunEngineOutcome;
}> {
  let checkpoint = request.checkpoint ?? createInitial(request);
  assertPinnedIdentity(checkpoint, request.claim);

  while (true) {
    if (stopped(request.signal)) return {
      checkpoint,
      outcome: request.signal?.cancelRequested ? "cancelled" : "stopped",
    };

    switch (checkpoint.phase) {
      case "analyze_intent_text_only": {
        const turn = await analyzeControlledIntent({
          runId: checkpoint.runId,
          input: checkpoint.input,
          model: request.model,
          signal: request.signal,
        });
        if (turn.skillHash !== checkpoint.skillHash || turn.skillVersion !== checkpoint.skillVersion) {
          throw new Error("controlled_engine_analysis_skill_drift");
        }
        checkpoint = recordControlledIntentAnalysis(checkpoint, turn.analysis);
        await request.control.saveCheckpoint(checkpoint, progress(checkpoint));
        break;
      }
      case "compose_plan_with_skill": {
        if (!checkpoint.intentAnalysis) throw new Error("controlled_engine_intent_missing");
        const turn = await composeControlledPlan({
          runId: checkpoint.runId,
          input: checkpoint.input,
          analysis: checkpoint.intentAnalysis,
          expectedSkillHash: checkpoint.skillHash,
          model: request.model,
          signal: request.signal,
        });
        checkpoint = proposeControlledPlan(checkpoint, turn.plan);
        await request.control.saveCheckpoint(checkpoint, progress(checkpoint));
        await request.control.requestApproval({
          checkpoint,
          kind: checkpoint.revisionIndex > 0 ? "controlled_image_edit_revision" : "controlled_image_edit_plan",
          estimatedAdditionalCredits: checkpoint.plannedToolCount * 5,
        });
        return { checkpoint, outcome: "awaiting_approval" };
      }
      case "awaiting_plan_approval":
      case "awaiting_revision_approval": {
        if (!request.claim.approvedPlanHash || request.claim.approvedPlanHash !== checkpoint.proposedPlanHash) {
          if (!checkpoint.proposedPlan || !checkpoint.proposedPlanHash) throw new Error("controlled_engine_plan_missing");
          // Re-commit the same content-addressed checkpoint after re-claim, then
          // idempotently ensure the approval row + pause transition. This closes
          // the crash window between checkpoint commit and approval_request.
          await request.control.saveCheckpoint(checkpoint, progress(checkpoint));
          await request.control.requestApproval({
            checkpoint,
            kind: checkpoint.phase === "awaiting_revision_approval"
              ? "controlled_image_edit_revision"
              : "controlled_image_edit_plan",
            estimatedAdditionalCredits: checkpoint.plannedToolCount * 5,
          });
          return { checkpoint, outcome: "awaiting_approval" };
        }
        checkpoint = decideControlledPlan(checkpoint, {
          approved: true,
          proposalHash: request.claim.approvedPlanHash,
        });
        await request.control.saveCheckpoint(checkpoint, progress(checkpoint));
        break;
      }
      case "execute_approved_plan": {
        checkpoint = await executeNextControlledStep(checkpoint, request.executor);
        await request.control.saveCheckpoint(checkpoint, progress(checkpoint));
        if (checkpoint.phase === "awaiting_result_feedback") {
          await request.control.awaitResultFeedback(checkpoint);
          return { checkpoint, outcome: "awaiting_result_feedback" };
        }
        break;
      }
      case "awaiting_result_feedback": {
        if (!request.claim.resultFeedbackAction) {
          // Same recovery rule as approval: if the process died after the
          // checkpoint but before releasing the lease, replay the pause.
          await request.control.saveCheckpoint(checkpoint, progress(checkpoint));
          await request.control.awaitResultFeedback(checkpoint);
          return { checkpoint, outcome: "awaiting_result_feedback" };
        }
        checkpoint = submitControlledResultFeedback(checkpoint, {
          action: request.claim.resultFeedbackAction,
          text: request.claim.feedbackText,
        });
        await request.control.saveCheckpoint(checkpoint, progress(checkpoint));
        break;
      }
      case "diagnose_feedback": {
        if (!request.diagnoser || !checkpoint.feedback) throw new Error("controlled_engine_diagnoser_missing");
        const diagnosis = await request.diagnoser.diagnose({ checkpoint, feedback: checkpoint.feedback });
        checkpoint = recordControlledFeedbackDiagnosis(checkpoint, diagnosis);
        await request.control.saveCheckpoint(checkpoint, progress(checkpoint));
        break;
      }
      case "compose_revision_plan": {
        if (!checkpoint.intentAnalysis || !checkpoint.proposedPlan || !checkpoint.feedbackDiagnosis || !checkpoint.feedback) {
          throw new Error("controlled_engine_revision_context_missing");
        }
        const priorStepIds = checkpoint.artifacts
          .filter((artifact) => artifact.role !== "input" && !!artifact.stepId)
          .map((artifact) => artifact.stepId!);
        const turn = await composeControlledRevisionPlan({
          runId: checkpoint.runId,
          input: checkpoint.input,
          analysis: checkpoint.intentAnalysis,
          previousPlan: checkpoint.proposedPlan,
          diagnosis: checkpoint.feedbackDiagnosis,
          feedback: checkpoint.feedback,
          priorStepIds,
          expectedSkillHash: checkpoint.skillHash,
          model: request.model,
          signal: request.signal,
        });
        checkpoint = proposeControlledRevisionPlan(checkpoint, turn.plan);
        await request.control.saveCheckpoint(checkpoint, progress(checkpoint));
        await request.control.requestApproval({
          checkpoint,
          kind: "controlled_image_edit_revision",
          estimatedAdditionalCredits: checkpoint.plannedToolCount * 5,
        });
        return { checkpoint, outcome: "awaiting_approval" };
      }
      case "exporting": {
        checkpoint = completeControlledExport(checkpoint);
        await request.control.saveCheckpoint(checkpoint, progress(checkpoint));
        await request.control.finish(checkpoint);
        return { checkpoint, outcome: "succeeded" };
      }
      case "succeeded": {
        // A claimed Run with a succeeded snapshot means the process died after
        // snapshot commit but before the control-plane finish transaction.
        await request.control.finish(checkpoint);
        return { checkpoint, outcome: "succeeded" };
      }
      case "cancelled": return { checkpoint, outcome: "cancelled" };
      case "finalize_without_inspection":
      case "failed":
        throw new Error(`controlled_engine_unexpected_phase:${checkpoint.phase}`);
    }
  }
}
