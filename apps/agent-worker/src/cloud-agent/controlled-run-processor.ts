import type { ControlledImageEditInput, ControlledRunArtifact } from "../contracts/controlled-image-edit.ts";
import type { ModelBackend } from "../contracts/model.ts";
import { MeteredModelBackend } from "../providers/deepseek/metered-model-backend.ts";
import { advanceControlledRun, type ControlledRunControl } from "../kernel/controlled-run-engine.ts";
import { clarificationProposalHash } from "../kernel/clarification-policy.ts";
import type { IntentPatch } from "../contracts/clarification.ts";
import { canonicalJson, sha256Hex } from "../kernel/tool-ledger.ts";
import type {
  ApprovedStepExecutor,
  ControlledFeedbackDiagnoser,
  ControlledRunnerCheckpoint,
} from "../kernel/controlled-image-edit-runner.ts";
import { BUILTIN_SKILL_REGISTRY } from "../skills/builtin-skill-registry.ts";
import { validateControlledInput } from "../skills/bowerbird-controlled-image-edit/schemas.ts";
import type { AgentRunContext, AgentRunProcessor } from "./runtime.ts";

function clipped(values: readonly string[] | undefined, limit = 12): string[] {
  return (values ?? []).slice(0, limit).map((value) => value.slice(0, 240));
}

function checkpointEvents(checkpoint: ControlledRunnerCheckpoint, progress: number) {
  const base = checkpoint.revisionIndex * 100;
  const plan = checkpoint.proposedPlan;
  if (checkpoint.phase === "compose_plan_with_skill" && checkpoint.intentAnalysis) {
    return [{
      seq: 10,
      type: "intent.analysis.completed",
      progress,
      displayPayload: {
        summary: checkpoint.intentAnalysis.intentSummary.slice(0, 1_000),
        finalSubjectReferenceId: checkpoint.intentAnalysis.finalSubjectReferenceId,
        ratio: checkpoint.input.ratio,
        preserves: clipped(checkpoint.intentAnalysis.mustPreserve),
        transfers: checkpoint.intentAnalysis.mustTransfer.slice(0, 8).map((item) => ({
          fromReferenceId: item.fromReferenceId,
          attributes: clipped(item.attributes, 8),
        })),
        excludes: clipped(checkpoint.intentAnalysis.mustExclude),
        consistencySignals: checkpoint.intentAnalysis.highConsistencySignals,
      },
    }];
  }
  if ((checkpoint.phase === "awaiting_plan_approval" || checkpoint.phase === "awaiting_revision_approval") && plan) {
    return [{
      seq: base + 20,
      type: checkpoint.revisionIndex ? "plan.revision.proposed" : "plan.proposed",
      progress,
      displayPayload: {
        summary: plan.intentSummary.slice(0, 1_000),
        strategy: plan.strategy,
        stepCount: plan.steps.length,
      },
    }];
  }
  if (checkpoint.phase === "execute_approved_plan" && plan) {
    const events = [];
    if (checkpoint.stepCursor > 0) {
      const completed = plan.steps[checkpoint.stepCursor - 1];
      const artifact = checkpoint.artifacts.find((item) => item.stepId === completed?.id && item.role !== "input");
      if (completed) events.push({
        seq: base + 31 + (checkpoint.stepCursor - 1) * 2,
        type: "step.completed",
        step: completed.id,
        progress,
        displayPayload: { goal: completed.goal, rationale: completed.rationale, outputRole: completed.outputRole, artifactId: artifact?.artifactId },
      });
    }
    const active = plan.steps[checkpoint.stepCursor];
    if (active) events.push({
      seq: base + 30 + checkpoint.stepCursor * 2,
      type: "step.started",
      step: active.id,
      progress,
      displayPayload: { goal: active.goal, rationale: active.rationale, outputRole: active.outputRole },
    });
    return events;
  }
  if (checkpoint.phase === "awaiting_result_feedback" && plan) {
    const completed = plan.steps.at(-1);
    const artifact = completed
      ? checkpoint.artifacts.find((item) => item.stepId === completed.id && item.role !== "input")
      : undefined;
    return [
      ...(completed ? [{
        seq: base + 31 + (plan.steps.length - 1) * 2,
        type: "step.completed",
        step: completed.id,
        progress,
        displayPayload: { goal: completed.goal, rationale: completed.rationale, outputRole: completed.outputRole, artifactId: artifact?.artifactId },
      }] : []),
      { seq: base + 80, type: "result.ready", progress, displayPayload: { artifactId: artifact?.artifactId } },
    ];
  }
  if (checkpoint.phase === "diagnose_feedback" && checkpoint.feedback) {
    // 反馈驱动的重诊断往往耗时数十秒（Vision + 文本回合）；进入该阶段即发事件，
    // 让桌面时间线立刻可见「正在按你的意见重新诊断」，而不是等到诊断完成才有动静。
    return [{
      seq: base + 85,
      type: "feedback.diagnosis.started",
      progress,
      displayPayload: { summary: checkpoint.feedback.slice(0, 500) },
    }];
  }
  if (checkpoint.phase === "compose_revision_plan" && checkpoint.feedbackDiagnosis) {
    return [{
      seq: base + 90,
      type: "feedback.diagnosis.completed",
      progress,
      displayPayload: {
        summary: checkpoint.feedbackDiagnosis.summary.slice(0, 1_000),
        earliestFailedStepId: checkpoint.feedbackDiagnosis.earliestFailedStepId,
        failedConstraints: clipped(checkpoint.feedbackDiagnosis.failedConstraints),
        preservedConstraints: clipped(checkpoint.feedbackDiagnosis.preservedConstraints),
      },
    }];
  }
  if (checkpoint.phase === "exporting") {
    return [{ seq: base + 90, type: "result.accepted", progress, displayPayload: {} }];
  }
  if (checkpoint.phase === "succeeded") {
    return [{ seq: base + 99, type: "run.succeeded", progress, displayPayload: {} }];
  }
  return [];
}

function currentStep(checkpoint: ControlledRunnerCheckpoint): string {
  if (checkpoint.phase === "execute_approved_plan") {
    return checkpoint.proposedPlan?.steps[checkpoint.stepCursor]?.id ?? checkpoint.phase;
  }
  return checkpoint.phase;
}

function asControlledInput(value: unknown): ControlledImageEditInput {
  validateControlledInput(value as ControlledImageEditInput);
  return value as ControlledImageEditInput;
}

export class ControlledImageEditRunProcessor implements AgentRunProcessor {
  private readonly model: ModelBackend;
  private readonly meteredModelName?: string;
  private readonly executorFactory: (context: AgentRunContext) => ApprovedStepExecutor | {
    executor: ApprovedStepExecutor;
    diagnoser?: ControlledFeedbackDiagnoser;
    cleanup(): void;
  };

  constructor(model: ModelBackend, executorFactory: (context: AgentRunContext) => ApprovedStepExecutor | {
    executor: ApprovedStepExecutor;
    diagnoser?: ControlledFeedbackDiagnoser;
    cleanup(): void;
  }, options: { meteredModelName?: string } = {}) {
    this.model = model;
    this.executorFactory = executorFactory;
    this.meteredModelName = options.meteredModelName;
  }

  async process(context: AgentRunContext): Promise<void> {
    const { run } = context.claimed;
    const registeredSkill = BUILTIN_SKILL_REGISTRY.resolve(run.skillId, run.skillVersion);
    if (registeredSkill.runner !== "controlled-image-edit") throw new Error("agent_skill_runner_mismatch");
    const skill = registeredSkill.bundle;

    const checkpoint = await context.control.loadControlledCheckpoint(context.claimed, skill.instructionHash);
    if (checkpoint) BUILTIN_SKILL_REGISTRY.assertSnapshotCompatible(registeredSkill, checkpoint.schemaVersion);
    let input: ControlledImageEditInput | undefined;
    if (!checkpoint) {
      if (!context.claimed.inputUrl) throw new Error("agent_input_url_missing");
      input = asControlledInput(await context.control.downloadVerifiedJson(
        context.claimed.inputUrl,
        run.inputManifestHash,
      ));
    }
    const inputArtifacts = !checkpoint && input ? this.inputArtifacts(context, input) : undefined;
    const scope = this.executorFactory(context);
    const executor = "executor" in scope ? scope.executor : scope;
    const diagnoser = "executor" in scope ? scope.diagnoser : undefined;
    const feedbackText = await this.feedbackText(context);
    const clarificationPatch = await this.clarificationPatch(context, checkpoint ?? undefined);
    const control = this.control(context);
    const model = this.meteredModelName
      ? new MeteredModelBackend({
          base: this.model,
          control: context.control,
          runId: run.id,
          leaseId: context.claimed.lease.leaseId,
          model: this.meteredModelName,
        })
      : this.model;
    const result = await advanceControlledRun({
      claim: {
        runId: run.id,
        conversationId: run.conversationId,
        skillVersion: run.skillVersion,
        approvedPlanHash: run.approvedPlanHash,
        resultFeedbackAction: run.resultFeedbackAction,
        feedbackText,
      },
      checkpoint: checkpoint ?? undefined,
      clarificationPatch,
      input,
      inputArtifacts,
      model,
      executor,
      diagnoser,
      control,
      signal: context.signal,
    });
    if ("cleanup" in scope && result.outcome !== "stopped") scope.cleanup();
  }

  private async feedbackText(context: AgentRunContext): Promise<string | undefined> {
    const action = context.claimed.run.resultFeedbackAction;
    if (!action) return undefined;
    if (!context.claimed.feedbackUrl) throw new Error("agent_feedback_url_missing");
    const bytes = await context.control.download(context.claimed.feedbackUrl);
    if (!bytes.byteLength || bytes.byteLength > 16 * 1024) throw new Error("agent_feedback_size_invalid");
    let value: unknown;
    try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error("agent_feedback_json_invalid"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("agent_feedback_json_invalid");
    const payload = value as Record<string, unknown>;
    if (payload.action !== action || typeof payload.text !== "string" || payload.text.length > 2_000) {
      throw new Error("agent_feedback_payload_invalid");
    }
    return payload.text.trim() || undefined;
  }

  private async clarificationPatch(
    context: AgentRunContext,
    checkpoint?: ControlledRunnerCheckpoint,
  ): Promise<IntentPatch | undefined> {
    if (checkpoint?.status !== "awaiting_clarification" || !checkpoint.pendingClarification) return undefined;
    const answer = context.claimed.clarificationAnswer;
    if (!answer) return undefined;
    if (answer.questionKey !== checkpoint.pendingClarification.questionKey ||
        answer.contextHash !== checkpoint.pendingClarification.contextHash ||
        !/^[0-9a-f]{64}$/.test(answer.intentPatchHash)) {
      throw new Error("agent_clarification_claim_mismatch");
    }
    const bytes = await context.control.download(answer.url);
    if (!bytes.byteLength || bytes.byteLength > 16 * 1024) throw new Error("agent_clarification_answer_size_invalid");
    let wrapper: unknown;
    try { wrapper = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new Error("agent_clarification_answer_json_invalid"); }
    if (!wrapper || typeof wrapper !== "object" || Array.isArray(wrapper)) {
      throw new Error("agent_clarification_answer_json_invalid");
    }
    const patch = (wrapper as Record<string, unknown>).intentPatch as IntentPatch;
    if (!patch || typeof patch !== "object" || sha256Hex(canonicalJson(patch)) !== answer.intentPatchHash) {
      throw new Error("agent_clarification_patch_hash_mismatch");
    }
    return patch;
  }

  private inputArtifacts(context: AgentRunContext, input: ControlledImageEditInput): ControlledRunArtifact[] {
    const claimed = context.claimed.artifactUrls ?? [];
    return input.references.map((reference) => {
      const artifact = claimed.find((candidate) => candidate.role === "input" && candidate.stepId === reference.referenceId);
      if (!artifact || artifact.runId !== context.claimed.run.id ||
          artifact.conversationId !== context.claimed.run.conversationId || artifact.mime !== reference.mime ||
          artifact.bytes !== reference.bytes || artifact.sha256 !== reference.sha256) {
        throw new Error("agent_claim_input_artifact_mismatch");
      }
      return {
        artifactId: artifact.artifactId,
        conversationId: artifact.conversationId,
        runId: artifact.runId,
        role: "input",
        stepId: reference.referenceId,
        mime: artifact.mime,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
        userVisible: artifact.userVisible,
      };
    });
  }

  private control(context: AgentRunContext): ControlledRunControl {
    const runId = context.claimed.run.id;
    const leaseId = context.claimed.lease.leaseId;
    return {
      saveCheckpoint: async (checkpoint, progress) => {
        await context.control.saveCheckpoint({
          runId,
          leaseId,
          checkpoint,
          step: currentStep(checkpoint),
          progress,
        });
        await context.control.appendEvents(runId, leaseId, checkpointEvents(checkpoint, progress));
      },
      requestApproval: async ({ checkpoint, kind, estimatedAdditionalCredits }) => {
        if (!checkpoint.proposedPlan || !checkpoint.proposedPlanHash) {
          throw new Error("agent_approval_plan_missing");
        }
        await context.control.requestApproval({
          runId,
          leaseId,
          kind,
          proposalHash: checkpoint.proposedPlanHash,
          proposal: checkpoint.proposedPlan as unknown as Record<string, unknown>,
          plannedToolCount: checkpoint.plannedToolCount,
          estimatedAdditionalCredits,
        });
      },
      requestClarification: async ({ proposal }) => {
        await context.control.requestClarification({
          runId,
          leaseId,
          proposal,
          proposalHash: clarificationProposalHash(proposal),
        });
      },
      awaitResultFeedback: async (_checkpoint: ControlledRunnerCheckpoint) => {
        await context.control.awaitResultFeedback(runId, leaseId);
      },
      awaitLocalTask: async (callId: string) => {
        return await context.control.awaitLocalTask(runId, leaseId, callId);
      },
      finish: async (_checkpoint: ControlledRunnerCheckpoint) => {
        await context.control.finish(runId, leaseId);
      },
    };
  }
}
