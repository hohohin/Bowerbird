import { deepEqual, equal, throws } from "node:assert/strict";
import { test } from "node:test";
import { evaluateControlledRecoveryEvidence } from "./controlled-agent-recovery-evidence.mjs";

const callId = "a".repeat(64);
const resultHash = "b".repeat(64);

function validInput() {
  return {
    requestedRuntime: "dsh",
    persistedRuntime: "dsh",
    executionLeaseIds: ["lease-before-crash", "lease-after-reclaim"],
    toolCalls: [{
      call_id: callId,
      phase: "execute_approved_plan",
      tool_name: "generate_image",
      status: "succeeded",
      result_hash: resultHash,
    }],
    usageItems: [
      { call_id: "model-1", kind: "model_tokens", provider: "deepseek", credits: 1 },
      { call_id: callId, kind: "image_generation", provider: "ark", credits: 5 },
    ],
    plannedToolCount: 1,
    finalArtifactCount: 1,
    finalStatus: "succeeded",
    actualCredits: 6,
    durationMs: 12_345,
  };
}

test("recovery evidence requires a post-approval re-claim and every planned image side effect exactly once", () => {
  const evidence = evaluateControlledRecoveryEvidence(validInput());
  equal(evidence.recoverySuccess, true);
  equal(evidence.executionLeaseFingerprints.length, 2);
  deepEqual(evidence.generationCallIds, [callId]);
  deepEqual(evidence.generationResultHashes, [resultHash]);
  deepEqual(evidence.checks, {
    runtimePinned: true,
    executionReclaimObserved: true,
    durableImageSideEffectsExactlyOnce: true,
    oneFinalArtifact: true,
    terminalSucceeded: true,
    creditsReconciled: true,
  });
});

test("multi-step approved plans require one succeeded call and usage row per planned step", () => {
  const input = validInput();
  const secondCallId = "c".repeat(64);
  input.plannedToolCount = 2;
  input.toolCalls.push({
    call_id: secondCallId,
    phase: "execute_approved_plan",
    tool_name: "generate_image",
    status: "succeeded",
    result_hash: "d".repeat(64),
  });
  input.usageItems.push({
    call_id: secondCallId,
    kind: "image_generation",
    provider: "ark",
    credits: 5,
  });
  input.actualCredits = 11;
  const evidence = evaluateControlledRecoveryEvidence(input);
  equal(evidence.recoverySuccess, true);
  deepEqual(evidence.generationCallIds, [callId, secondCallId]);
});

test("normal planning-to-approval lease turnover cannot impersonate execution recovery", () => {
  const evidence = evaluateControlledRecoveryEvidence({
    ...validInput(),
    executionLeaseIds: ["only-one-post-approval-lease"],
  });
  equal(evidence.recoverySuccess, false);
  equal(evidence.checks.executionReclaimObserved, false);
});

test("duplicate generation usage or runtime drift fails recovery evidence", () => {
  const duplicateUsage = validInput();
  duplicateUsage.usageItems.push({
    call_id: callId,
    kind: "image_generation",
    provider: "ark",
    credits: 5,
  });
  equal(evaluateControlledRecoveryEvidence(duplicateUsage).recoverySuccess, false);
  equal(evaluateControlledRecoveryEvidence({
    ...validInput(),
    persistedRuntime: "legacy_kernel",
  }).recoverySuccess, false);
});

test("malformed recovery evidence is rejected", () => {
  throws(() => evaluateControlledRecoveryEvidence({}), /controlled_recovery_evidence_invalid/);
});
