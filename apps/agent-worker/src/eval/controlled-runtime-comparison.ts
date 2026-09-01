import type { AgentRuntime } from "../contracts/agent-runtime.ts";

export type ControlledRuntimeObservation = {
  caseId: string;
  runtime: AgentRuntime;
  strategyCorrect: boolean | null;
  structuredSuccess: boolean;
  durationMs: number;
  credits: number;
  /** null means this case does not exercise crash/re-claim recovery. */
  recoverySuccess: boolean | null;
  costBasis: "estimated" | "actual";
};

export type ControlledRuntimeSummary = {
  runtime: AgentRuntime;
  cases: number;
  strategyAccuracy: number | null;
  structuredSuccessRate: number;
  averageDurationMs: number;
  p95DurationMs: number;
  totalCredits: number;
  averageCredits: number;
  recoverySuccessRate: number | null;
};

export type ControlledRuntimeComparison = {
  pairedCases: number;
  costBasis: "estimated" | "actual";
  legacy: ControlledRuntimeSummary;
  dsh: ControlledRuntimeSummary;
  delta: {
    strategyAccuracy: number | null;
    structuredSuccessRate: number;
    averageDurationMs: number;
    p95DurationMs: number;
    totalCredits: number;
    averageCredits: number;
    recoverySuccessRate: number | null;
  };
  qualityNoRegression: boolean;
};

function rate(values: boolean[]): number | null {
  return values.length ? values.filter(Boolean).length / values.length : null;
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile95(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]!;
}

function assertObservation(value: ControlledRuntimeObservation): void {
  if (!value.caseId.trim() || !["legacy_kernel", "dsh"].includes(value.runtime) ||
      !Number.isFinite(value.durationMs) || value.durationMs < 0 ||
      !Number.isFinite(value.credits) || value.credits < 0 ||
      !["estimated", "actual"].includes(value.costBasis)) {
    throw new Error("controlled_runtime_observation_invalid");
  }
}

export function summarizeControlledRuntime(
  observations: readonly ControlledRuntimeObservation[],
  runtime: AgentRuntime,
): ControlledRuntimeSummary {
  const rows = observations.filter((row) => row.runtime === runtime);
  if (!rows.length) throw new Error(`controlled_runtime_${runtime}_missing`);
  const strategy = rows.flatMap((row) => row.strategyCorrect === null ? [] : [row.strategyCorrect]);
  const recovery = rows.flatMap((row) => row.recoverySuccess === null ? [] : [row.recoverySuccess]);
  return {
    runtime,
    cases: rows.length,
    strategyAccuracy: rate(strategy),
    structuredSuccessRate: rows.filter((row) => row.structuredSuccess).length / rows.length,
    averageDurationMs: average(rows.map((row) => row.durationMs)),
    p95DurationMs: percentile95(rows.map((row) => row.durationMs)),
    totalCredits: rows.reduce((sum, row) => sum + row.credits, 0),
    averageCredits: average(rows.map((row) => row.credits)),
    recoverySuccessRate: rate(recovery),
  };
}

function nullableDelta(next: number | null, baseline: number | null): number | null {
  return next === null || baseline === null ? null : next - baseline;
}

function noRegression(next: number | null, baseline: number | null): boolean {
  return baseline === null ? next === null : next !== null && next >= baseline;
}

export function compareControlledRuntimes(
  observations: readonly ControlledRuntimeObservation[],
): ControlledRuntimeComparison {
  const seen = new Set<string>();
  const caseRuntimes = new Map<string, Set<AgentRuntime>>();
  const costBases = new Set<ControlledRuntimeObservation["costBasis"]>();
  for (const row of observations) {
    assertObservation(row);
    costBases.add(row.costBasis);
    const key = `${row.caseId}:${row.runtime}`;
    if (seen.has(key)) throw new Error("controlled_runtime_duplicate_case");
    seen.add(key);
    const runtimes = caseRuntimes.get(row.caseId) ?? new Set<AgentRuntime>();
    runtimes.add(row.runtime);
    caseRuntimes.set(row.caseId, runtimes);
  }
  if ([...caseRuntimes.values()].some((runtimes) => runtimes.size !== 2)) {
    throw new Error("controlled_runtime_case_pair_incomplete");
  }
  if (costBases.size !== 1) throw new Error("controlled_runtime_cost_basis_mixed");
  const legacy = summarizeControlledRuntime(observations, "legacy_kernel");
  const dsh = summarizeControlledRuntime(observations, "dsh");
  if (legacy.cases !== dsh.cases) throw new Error("controlled_runtime_case_pair_incomplete");
  return {
    pairedCases: caseRuntimes.size,
    costBasis: [...costBases][0]!,
    legacy,
    dsh,
    delta: {
      strategyAccuracy: nullableDelta(dsh.strategyAccuracy, legacy.strategyAccuracy),
      structuredSuccessRate: dsh.structuredSuccessRate - legacy.structuredSuccessRate,
      averageDurationMs: dsh.averageDurationMs - legacy.averageDurationMs,
      p95DurationMs: dsh.p95DurationMs - legacy.p95DurationMs,
      totalCredits: dsh.totalCredits - legacy.totalCredits,
      averageCredits: dsh.averageCredits - legacy.averageCredits,
      recoverySuccessRate: nullableDelta(dsh.recoverySuccessRate, legacy.recoverySuccessRate),
    },
    qualityNoRegression:
      noRegression(dsh.strategyAccuracy, legacy.strategyAccuracy) &&
      dsh.structuredSuccessRate >= legacy.structuredSuccessRate &&
      noRegression(dsh.recoverySuccessRate, legacy.recoverySuccessRate),
  };
}

function percent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

export function renderControlledRuntimeComparison(comparison: ControlledRuntimeComparison): string {
  const rows = [comparison.legacy, comparison.dsh];
  return `${[
    "# Controlled Image Edit Runtime Comparison",
    "",
    `- Paired cases: ${comparison.pairedCases}`,
    `- Credit basis: ${comparison.costBasis}`,
    `- Quality/recovery no-regression gate: ${comparison.qualityNoRegression ? "PASS" : "FAIL"}`,
    "- Positive latency or credit deltas mean DSH used more than legacy; they are observations, not an automatic pass/fail threshold.",
    "",
    "| Runtime | Strategy | Structured | Avg ms | p95 ms | Total credits | Avg credits | Recovery |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...rows.map((row) => `| ${row.runtime} | ${percent(row.strategyAccuracy)} | ${percent(row.structuredSuccessRate)} | ${row.averageDurationMs.toFixed(1)} | ${row.p95DurationMs.toFixed(1)} | ${row.totalCredits.toFixed(2)} | ${row.averageCredits.toFixed(2)} | ${percent(row.recoverySuccessRate)} |`),
    "",
  ].join("\n")}\n`;
}
