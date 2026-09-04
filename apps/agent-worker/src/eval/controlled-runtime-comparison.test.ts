import { deepEqual, equal, ok, throws } from "node:assert/strict";
import { test } from "node:test";
import {
  compareControlledRuntimes,
  renderControlledRuntimeComparison,
  type ControlledRuntimeObservation,
} from "./controlled-runtime-comparison.ts";

const observations: ControlledRuntimeObservation[] = [
  { caseId: "strategy", runtime: "legacy_kernel", strategyCorrect: true, structuredSuccess: true, durationMs: 100, credits: 1, recoverySuccess: null, costBasis: "actual" },
  { caseId: "strategy", runtime: "dsh", strategyCorrect: true, structuredSuccess: true, durationMs: 140, credits: 2, recoverySuccess: null, costBasis: "actual" },
  { caseId: "recovery", runtime: "legacy_kernel", strategyCorrect: null, structuredSuccess: true, durationMs: 300, credits: 5, recoverySuccess: true, costBasis: "actual" },
  { caseId: "recovery", runtime: "dsh", strategyCorrect: null, structuredSuccess: true, durationMs: 260, credits: 5, recoverySuccess: true, costBasis: "actual" },
];

test("paired runtime comparison reports quality, latency, cost and recovery deltas", () => {
  const comparison = compareControlledRuntimes(observations);
  equal(comparison.pairedCases, 2);
  equal(comparison.legacy.strategyAccuracy, 1);
  equal(comparison.dsh.structuredSuccessRate, 1);
  equal(comparison.delta.averageDurationMs, 0);
  equal(comparison.delta.totalCredits, 1);
  equal(comparison.delta.recoverySuccessRate, 0);
  equal(comparison.qualityNoRegression, true);
  ok(renderControlledRuntimeComparison(comparison).includes("Quality/recovery no-regression gate: PASS"));
});

test("comparison fails closed for incomplete or duplicate case pairs", () => {
  throws(() => compareControlledRuntimes(observations.slice(0, 3)), /controlled_runtime_case_pair_incomplete/);
  throws(() => compareControlledRuntimes([...observations, observations[0]!]), /controlled_runtime_duplicate_case/);
  throws(
    () => compareControlledRuntimes(observations.map((row, index) => index === 0 ? { ...row, costBasis: "estimated" } : row)),
    /controlled_runtime_cost_basis_mixed/,
  );
});

test("comparison keeps runtime summaries stable", () => {
  const comparison = compareControlledRuntimes(observations);
  deepEqual(
    { legacyCases: comparison.legacy.cases, dshCases: comparison.dsh.cases },
    { legacyCases: 2, dshCases: 2 },
  );
});
