import test from "node:test";
import assert from "node:assert/strict";

import {
  buildUnifiedAgentObservation,
  evidenceRowsFromDocument,
  percentile,
} from "./unified-agent-observation-lib.mjs";

test("unified U6 observation reports outcomes, latency, cost and explicit evidence by runtime", () => {
  const runs = [
    { id: "l1", agent_runtime: "legacy_kernel", status: "succeeded", actual_credits: 2, created_at: "2026-09-01T00:00:00Z", finished_at: "2026-09-01T00:00:02Z" },
    { id: "l2", agent_runtime: "legacy_kernel", status: "cancelled", actual_credits: 0, created_at: "2026-09-01T00:00:00Z", finished_at: "2026-09-01T00:00:04Z" },
    { id: "d1", agent_runtime: "dsh", status: "failed", actual_credits: 1, error_code: "provider_outcome_unknown", created_at: "2026-09-01T00:00:00Z", finished_at: "2026-09-01T00:00:03Z" },
    { id: "d2", agent_runtime: "dsh", status: "succeeded", actual_credits: 3, created_at: "2026-09-01T00:00:00Z", finished_at: "2026-09-01T00:00:05Z" },
  ];
  const tools = [
    { run_id: "l1", call_id: "lc1", phase: "plan", tool_name: "model_turn", args_hash: "a", attempt: 1, status: "succeeded", started_at: "2026-09-01T00:00:00Z", finished_at: "2026-09-01T00:00:01Z" },
    { run_id: "d1", call_id: "dc1", phase: "plan", tool_name: "model_turn", args_hash: "b", attempt: 2, status: "outcome_unknown", safe_error_code: "provider_outcome_unknown", started_at: "2026-09-01T00:00:00Z", finished_at: null },
    { run_id: "d2", call_id: "dc2", phase: "plan", tool_name: "model_turn", args_hash: "c", attempt: 1, status: "succeeded", started_at: "2026-09-01T00:00:00Z", finished_at: "2026-09-01T00:00:02Z" },
  ];
  const usage = [
    { run_id: "l1", call_id: "lc1", kind: "model_tokens", provider: "deepseek", input_units: 10, output_units: 2, credits: 2, provider_cost_micros: 20 },
    { run_id: "d1", call_id: "dc1", kind: "model_tokens", provider: "deepseek", input_units: 8, output_units: 1, credits: 1, provider_cost_micros: 10 },
    { run_id: "d2", call_id: "dc2", kind: "model_tokens", provider: "deepseek", input_units: 12, output_units: 3, credits: 3, provider_cost_micros: 30 },
  ];
  const evidence = [
    { runtime: "legacy_kernel", strategyCorrect: true, structuredSuccess: true, recoverySuccess: true, costBasis: "actual" },
    { runtime: "dsh", strategyCorrect: true, structuredSuccess: true, recoverySuccess: true, costBasis: "actual" },
  ];
  const report = buildUnifiedAgentObservation({ runs, tools, usage, evidence });
  assert.equal(report.byRuntime.legacy_kernel.runs.cancelRate, 0.5);
  assert.equal(report.byRuntime.dsh.runs.failureRate, 0.5);
  assert.equal(report.byRuntime.dsh.runs.duration.p95Ms, 5_000);
  assert.equal(report.byRuntime.dsh.tools.retriedCalls, 1);
  assert.equal(report.byRuntime.dsh.tools.outcomeUnknownCalls, 1);
  assert.equal(report.byRuntime.dsh.usage.providerCostMicros, 40);
  assert.equal(report.byRuntime.dsh.pairedEvidence.recoverySuccessRate, 1);
  assert.deepEqual(report.invariants, {
    duplicateCallIdsZero: true,
    duplicateUsageIdentityZero: true,
    terminalCreditsReconciled: true,
  });
});

test("unified U6 observation keeps empty evidence and duplicate indicators explicit", () => {
  const report = buildUnifiedAgentObservation({
    runs: [{ id: "d1", agent_runtime: "dsh", status: "succeeded", actual_credits: 2, created_at: "2026-09-01T00:00:00Z", finished_at: "2026-09-01T00:00:01Z" }],
    tools: [
      { run_id: "d1", call_id: "same", phase: "plan", tool_name: "model_turn", args_hash: "a", attempt: 1, status: "succeeded" },
      { run_id: "d1", call_id: "same", phase: "plan", tool_name: "model_turn", args_hash: "a", attempt: 1, status: "succeeded" },
    ],
    usage: [],
  });
  assert.equal(report.byRuntime.dsh.pairedEvidence.recoverySuccessRate, null);
  assert.equal(report.invariants.duplicateCallIdsZero, false);
  assert.equal(report.invariants.terminalCreditsReconciled, false);
  assert.equal(percentile([], 0.95), null);
});

test("explicit crash/re-claim evidence is normalized without inferring it from Run attempts", () => {
  assert.deepEqual(evidenceRowsFromDocument({
    schemaVersion: 1,
    requestedRuntime: "dsh",
    durationMs: 123,
    actualCredits: 8,
    recoverySuccess: true,
    finalStatus: "succeeded",
  }), [{
    caseId: "explicit-crash-reclaim",
    runtime: "dsh",
    strategyCorrect: null,
    structuredSuccess: true,
    durationMs: 123,
    credits: 8,
    recoverySuccess: true,
    costBasis: "actual",
  }]);
  assert.throws(() => evidenceRowsFromDocument({ attempt_count: 2 }), /runtime_evidence_observations_missing/);
});
