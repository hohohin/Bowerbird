import type { ControlledRunnerCheckpoint } from "./controlled-image-edit-runner.ts";
import { canonicalJson, sha256Hex } from "./tool-ledger.ts";
import {
  clarificationProposalHash,
  validateClarificationProposal,
  type ClarificationHistoryEntry,
} from "./clarification-policy.ts";
import { CONTROLLED_IMAGE_EDIT_MANIFEST } from "../skills/bowerbird-controlled-image-edit/manifest.ts";
import { hashControlledPlan, hashIntentAnalysis } from "../skills/bowerbird-controlled-image-edit/planner.ts";
import {
  validateControlledInput,
  validateControlledFeedbackDiagnosis,
  validateControlledPlan,
  validateIntentAnalysis,
} from "../skills/bowerbird-controlled-image-edit/schemas.ts";

export const CONTROLLED_CHECKPOINT_SCHEMA_VERSION = 1;
export const MAX_CONTROLLED_CHECKPOINT_BYTES = 1024 * 1024;

export type EncodedControlledCheckpoint = {
  bytes: Uint8Array;
  sha256: string;
};

function fail(code: string): never {
  throw new Error(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateCheckpoint(checkpoint: ControlledRunnerCheckpoint): void {
  if (checkpoint.schemaVersion !== CONTROLLED_CHECKPOINT_SCHEMA_VERSION) fail("controlled_checkpoint_schema_unsupported");
  if (!checkpoint.runId || !checkpoint.conversationId || checkpoint.skillId !== "bowerbird-controlled-image-edit") {
    fail("controlled_checkpoint_identity_invalid");
  }
  if (!checkpoint.skillVersion || !/^[0-9a-f]{64}$/.test(checkpoint.skillHash)) {
    fail("controlled_checkpoint_skill_invalid");
  }
  if (!Number.isInteger(checkpoint.revisionIndex) || checkpoint.revisionIndex < 0 ||
      !Number.isInteger(checkpoint.plannedToolCount) || checkpoint.plannedToolCount < 0 ||
      !Number.isInteger(checkpoint.stepCursor) || checkpoint.stepCursor < 0 ||
      !Number.isInteger(checkpoint.understandCallCount) || checkpoint.understandCallCount < 0) {
    fail("controlled_checkpoint_counter_invalid");
  }
  validateControlledInput(checkpoint.input);
  const clarificationPolicy = CONTROLLED_IMAGE_EDIT_MANIFEST.clarifications;
  const overrides = checkpoint.intentOverrides ?? {};
  if (!isRecord(overrides) || Object.keys(overrides).some((field) => !clarificationPolicy.intentFields.includes(field))) {
    fail("controlled_checkpoint_intent_overrides_invalid");
  }
  const clarificationHistory = checkpoint.clarificationHistory ?? [];
  if (!Array.isArray(clarificationHistory) || clarificationHistory.length > clarificationPolicy.maxPerRun) {
    fail("controlled_checkpoint_clarification_history_invalid");
  }
  const validatedHistory: ClarificationHistoryEntry[] = [];
  for (const entry of clarificationHistory) {
    if (!entry || (entry.status !== "pending" && entry.status !== "answered") ||
        clarificationProposalHash(entry.proposal) !== entry.proposalHash ||
        (entry.status === "answered" ? !/^[0-9a-f]{64}$/.test(entry.intentPatchHash ?? "") : entry.intentPatchHash !== undefined)) {
      fail("controlled_checkpoint_clarification_history_invalid");
    }
    validateClarificationProposal({
      proposal: entry.proposal,
      expectedContextHash: entry.proposal.contextHash,
      history: validatedHistory,
      policy: clarificationPolicy,
    });
    validatedHistory.push(entry);
  }
  const pending = clarificationHistory.filter((entry) => entry.status === "pending");
  if (checkpoint.status === "awaiting_clarification") {
    if (pending.length !== 1 || !checkpoint.pendingClarification ||
        clarificationProposalHash(checkpoint.pendingClarification) !== pending[0].proposalHash) {
      fail("controlled_checkpoint_pending_clarification_invalid");
    }
  } else if (pending.length || checkpoint.pendingClarification) {
    fail("controlled_checkpoint_pending_clarification_invalid");
  }
  if (checkpoint.intentAnalysis) {
    validateIntentAnalysis(checkpoint.input, checkpoint.intentAnalysis);
    if (hashIntentAnalysis(checkpoint.intentAnalysis) !== checkpoint.intentAnalysisHash) {
      fail("controlled_checkpoint_intent_hash_mismatch");
    }
  } else if (checkpoint.intentAnalysisHash) {
    fail("controlled_checkpoint_intent_missing");
  }
  if (checkpoint.proposedPlan) {
    if (!checkpoint.intentAnalysis || !checkpoint.intentAnalysisHash) fail("controlled_checkpoint_plan_without_intent");
    validateControlledPlan(
      checkpoint.input,
      checkpoint.intentAnalysis,
      checkpoint.intentAnalysisHash,
      checkpoint.proposedPlan,
      checkpoint.revisionIndex > 0
        ? { priorStepIds: checkpoint.revisionBaseStepIds, requirePriorArtifactInput: true }
        : {},
    );
    const planHash = hashControlledPlan(checkpoint.proposedPlan);
    if (planHash !== checkpoint.proposedPlanHash) fail("controlled_checkpoint_plan_hash_mismatch");
    if (checkpoint.approvedPlanHash && checkpoint.approvedPlanHash !== planHash) {
      fail("controlled_checkpoint_approval_hash_mismatch");
    }
    if (checkpoint.stepCursor > checkpoint.proposedPlan.steps.length) fail("controlled_checkpoint_step_cursor_invalid");
  } else if (checkpoint.proposedPlanHash || checkpoint.approvedPlanHash) {
    fail("controlled_checkpoint_plan_missing");
  }
  if (!Array.isArray(checkpoint.artifacts) || checkpoint.artifacts.some((artifact) =>
    artifact.runId !== checkpoint.runId || artifact.conversationId !== checkpoint.conversationId ||
    !/^[0-9a-f]{64}$/.test(artifact.sha256)
  )) {
    fail("controlled_checkpoint_artifact_invalid");
  }
  if (checkpoint.feedbackDiagnosis) {
    if (!checkpoint.proposedPlan) fail("controlled_checkpoint_diagnosis_without_plan");
    validateControlledFeedbackDiagnosis(checkpoint.proposedPlan, checkpoint.artifacts, checkpoint.feedbackDiagnosis);
  }
}

export function encodeControlledCheckpoint(checkpoint: ControlledRunnerCheckpoint): EncodedControlledCheckpoint {
  validateCheckpoint(checkpoint);
  const bytes = new TextEncoder().encode(canonicalJson(checkpoint));
  if (bytes.byteLength > MAX_CONTROLLED_CHECKPOINT_BYTES) fail("controlled_checkpoint_too_large");
  return { bytes, sha256: sha256Hex(new TextDecoder().decode(bytes)) };
}

export function decodeControlledCheckpoint(
  bytes: Uint8Array,
  expected: { runId: string; conversationId: string; skillVersion: string; skillHash: string; sha256: string },
): ControlledRunnerCheckpoint {
  if (!bytes.byteLength || bytes.byteLength > MAX_CONTROLLED_CHECKPOINT_BYTES) fail("controlled_checkpoint_size_invalid");
  const encoded = new TextDecoder().decode(bytes);
  if (sha256Hex(encoded) !== expected.sha256) fail("controlled_checkpoint_object_hash_mismatch");
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    fail("controlled_checkpoint_json_invalid");
  }
  if (!isRecord(value)) fail("controlled_checkpoint_json_invalid");
  const checkpoint = value as ControlledRunnerCheckpoint;
  validateCheckpoint(checkpoint);
  if (checkpoint.runId !== expected.runId || checkpoint.conversationId !== expected.conversationId) {
    fail("controlled_checkpoint_run_mismatch");
  }
  if (checkpoint.skillVersion !== expected.skillVersion || checkpoint.skillHash !== expected.skillHash) {
    fail("controlled_checkpoint_skill_mismatch");
  }
  return checkpoint;
}
