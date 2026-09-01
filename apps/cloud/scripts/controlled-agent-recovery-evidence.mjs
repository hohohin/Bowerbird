import { createHash } from "node:crypto";

const RUNTIMES = new Set(["legacy_kernel", "dsh"]);
const SHA256 = /^[0-9a-f]{64}$/;

function fingerprint(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Converts content-free control-plane facts into one auditable recovery result.
 * Lease IDs are accepted only from the post-approval execution window; callers
 * must not include the normal pre-approval planning lease.
 */
export function evaluateControlledRecoveryEvidence(input) {
  if (!input || typeof input !== "object" || !RUNTIMES.has(input.requestedRuntime) ||
      !RUNTIMES.has(input.persistedRuntime) || !Array.isArray(input.executionLeaseIds) ||
      !Array.isArray(input.toolCalls) || !Array.isArray(input.usageItems) ||
      !Number.isInteger(input.plannedToolCount) || input.plannedToolCount < 1 ||
      !Number.isFinite(input.durationMs) || input.durationMs < 0 ||
      !Number.isFinite(input.actualCredits) || input.actualCredits < 0 ||
      !Number.isInteger(input.finalArtifactCount) || input.finalArtifactCount < 0) {
    throw new Error("controlled_recovery_evidence_invalid");
  }

  const executionLeaseIds = [...new Set(input.executionLeaseIds.filter((value) =>
    typeof value === "string" && value.length >= 8 && value.length <= 200))];
  const generationCalls = input.toolCalls.filter((row) =>
    row?.phase === "execute_approved_plan" && row?.tool_name === "generate_image");
  const succeededGenerationCalls = generationCalls.filter((row) =>
    row?.status === "succeeded" && typeof row?.call_id === "string" &&
    typeof row?.result_hash === "string" && SHA256.test(row.result_hash));
  const imageUsage = input.usageItems.filter((row) =>
    row?.kind === "image_generation" && row?.provider === "ark");
  const succeededCallIds = succeededGenerationCalls.map((row) => row.call_id);
  const uniqueSucceededCallIds = new Set(succeededCallIds);
  const usageCounts = new Map();
  for (const row of imageUsage) {
    usageCounts.set(row?.call_id, (usageCounts.get(row?.call_id) ?? 0) + 1);
  }
  const durableImageSideEffectsExactlyOnce = generationCalls.length === input.plannedToolCount &&
    succeededGenerationCalls.length === input.plannedToolCount &&
    uniqueSucceededCallIds.size === input.plannedToolCount &&
    imageUsage.length === input.plannedToolCount &&
    succeededCallIds.every((callId) => usageCounts.get(callId) === 1);
  const creditsReconciled = input.usageItems.reduce((sum, row) => sum + Number(row?.credits ?? 0), 0) ===
    input.actualCredits;

  const checks = {
    runtimePinned: input.persistedRuntime === input.requestedRuntime,
    executionReclaimObserved: executionLeaseIds.length >= 2,
    durableImageSideEffectsExactlyOnce,
    oneFinalArtifact: input.finalArtifactCount === 1,
    terminalSucceeded: input.finalStatus === "succeeded",
    creditsReconciled,
  };
  const recoverySuccess = Object.values(checks).every(Boolean);
  return {
    schemaVersion: 1,
    requestedRuntime: input.requestedRuntime,
    persistedRuntime: input.persistedRuntime,
    executionLeaseFingerprints: executionLeaseIds.map(fingerprint),
    plannedToolCount: input.plannedToolCount,
    generationCallIds: succeededGenerationCalls.map((row) => row.call_id),
    generationResultHashes: succeededGenerationCalls.map((row) => row.result_hash),
    imageUsageCount: imageUsage.length,
    finalArtifactCount: input.finalArtifactCount,
    finalStatus: input.finalStatus,
    actualCredits: input.actualCredits,
    durationMs: input.durationMs,
    checks,
    recoverySuccess,
  };
}
