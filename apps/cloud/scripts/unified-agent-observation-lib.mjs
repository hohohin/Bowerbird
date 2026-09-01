const RUNTIMES = ["legacy_kernel", "dsh"];
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

export function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function elapsed(start, finish) {
  if (!start || !finish) return null;
  const value = Date.parse(finish) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function distribution(rows, key) {
  const result = {};
  for (const row of rows) {
    const value = typeof row?.[key] === "string" && row[key] ? row[key] : "unknown";
    result[value] = (result[value] ?? 0) + 1;
  }
  return result;
}

function latency(values) {
  return {
    samples: values.length,
    averageMs: average(values),
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: values.length ? Math.max(...values) : null,
  };
}

function rate(values) {
  return values.length ? values.filter(Boolean).length / values.length : null;
}

function duplicateGroupCount(rows, keyOf) {
  const counts = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.values()].filter((count) => count > 1).length;
}

function summarizeEvidence(rows) {
  const strategy = rows.flatMap((row) => typeof row?.strategyCorrect === "boolean" ? [row.strategyCorrect] : []);
  const structured = rows.flatMap((row) => typeof row?.structuredSuccess === "boolean" ? [row.structuredSuccess] : []);
  const recovery = rows.flatMap((row) => typeof row?.recoverySuccess === "boolean" ? [row.recoverySuccess] : []);
  return {
    cases: rows.length,
    strategySamples: strategy.length,
    strategyAccuracy: rate(strategy),
    structuredSamples: structured.length,
    structuredSuccessRate: rate(structured),
    recoverySamples: recovery.length,
    recoverySuccessRate: rate(recovery),
    costBases: [...new Set(rows.flatMap((row) => typeof row?.costBasis === "string" ? [row.costBasis] : []))].sort(),
  };
}

export function evidenceRowsFromDocument(value) {
  if (Array.isArray(value?.observations)) return value.observations;
  if (value?.schemaVersion === 1 && ["legacy_kernel", "dsh"].includes(value.requestedRuntime) &&
      typeof value.recoverySuccess === "boolean" && Number.isFinite(value.durationMs) &&
      Number.isFinite(value.actualCredits)) {
    return [{
      caseId: "explicit-crash-reclaim",
      runtime: value.requestedRuntime,
      strategyCorrect: null,
      structuredSuccess: value.finalStatus === "succeeded",
      durationMs: value.durationMs,
      credits: value.actualCredits,
      recoverySuccess: value.recoverySuccess,
      costBasis: "actual",
    }];
  }
  throw new Error("runtime_evidence_observations_missing");
}

function summarizeRuntime(runtime, runs, tools, usage, evidence) {
  const runtimeRuns = runs.filter((run) => run.agent_runtime === runtime);
  const runIds = new Set(runtimeRuns.map((run) => run.id));
  const runtimeTools = tools.filter((row) => runIds.has(row.run_id));
  const runtimeUsage = usage.filter((row) => runIds.has(row.run_id));
  const runtimeEvidence = evidence.filter((row) => row?.runtime === runtime);
  const terminal = runtimeRuns.filter((run) => TERMINAL.has(run.status));
  const failed = terminal.filter((run) => run.status === "failed");
  const cancelled = terminal.filter((run) => run.status === "cancelled");
  const durations = terminal.map((run) => elapsed(run.created_at, run.finished_at)).filter(Number.isFinite);
  const toolDurations = runtimeTools.map((row) => elapsed(row.started_at, row.finished_at)).filter(Number.isFinite);
  const credits = terminal.map((run) => Number(run.actual_credits)).filter(Number.isFinite);
  const providerCosts = runtimeUsage.map((row) => Number(row.provider_cost_micros)).filter(Number.isFinite);
  const modelUsage = runtimeUsage.filter((row) => row.kind === "model_tokens");
  const usageCreditsByRun = new Map();
  for (const row of runtimeUsage) {
    usageCreditsByRun.set(row.run_id, (usageCreditsByRun.get(row.run_id) ?? 0) + Number(row.credits ?? 0));
  }
  const creditReconciliationViolations = terminal.filter((run) =>
    Number.isFinite(Number(run.actual_credits)) &&
    Math.abs(Number(run.actual_credits) - (usageCreditsByRun.get(run.id) ?? 0)) > 1e-9).length;

  return {
    runs: {
      total: runtimeRuns.length,
      terminal: terminal.length,
      active: runtimeRuns.length - terminal.length,
      statuses: distribution(runtimeRuns, "status"),
      failuresByCode: distribution(failed, "error_code"),
      failureRate: terminal.length ? failed.length / terminal.length : null,
      cancelRate: terminal.length ? cancelled.length / terminal.length : null,
      duration: latency(durations),
      credits: {
        samples: credits.length,
        total: credits.reduce((sum, value) => sum + value, 0),
        average: average(credits),
        max: credits.length ? Math.max(...credits) : null,
      },
      creditReconciliationViolations,
    },
    tools: {
      total: runtimeTools.length,
      statuses: distribution(runtimeTools, "status"),
      failuresByCode: distribution(runtimeTools.filter((row) => row.status !== "succeeded"), "safe_error_code"),
      duration: latency(toolDurations),
      retriedCalls: runtimeTools.filter((row) => Number(row.attempt) > 1).length,
      outcomeUnknownCalls: runtimeTools.filter((row) => row.status === "outcome_unknown").length,
      duplicateCallIdGroups: duplicateGroupCount(runtimeTools, (row) => `${row.run_id}:${row.call_id}`),
      sameArgsMultipleCallGroups: duplicateGroupCount(runtimeTools, (row) =>
        `${row.run_id}:${row.phase}:${row.tool_name}:${row.args_hash}`),
    },
    usage: {
      items: runtimeUsage.length,
      credits: runtimeUsage.reduce((sum, row) => sum + Number(row.credits ?? 0), 0),
      providerCostMicros: providerCosts.reduce((sum, value) => sum + value, 0),
      modelInputTokens: modelUsage.reduce((sum, row) => sum + Number(row.input_units ?? 0), 0),
      modelOutputTokens: modelUsage.reduce((sum, row) => sum + Number(row.output_units ?? 0), 0),
      duplicateIdentityGroups: duplicateGroupCount(runtimeUsage, (row) =>
        `${row.run_id}:${row.call_id}:${row.kind}:${row.provider}`),
    },
    pairedEvidence: summarizeEvidence(runtimeEvidence),
  };
}

/** Builds a content-free U6 report. It never accepts prompts, artifacts, signed URLs or provider responses. */
export function buildUnifiedAgentObservation({ runs, tools, usage, evidence = [] }) {
  const byRuntime = Object.fromEntries(RUNTIMES.map((runtime) => [
    runtime,
    summarizeRuntime(runtime, runs, tools, usage, evidence),
  ]));
  return {
    byRuntime,
    invariants: {
      duplicateCallIdsZero: RUNTIMES.every((runtime) => byRuntime[runtime].tools.duplicateCallIdGroups === 0),
      duplicateUsageIdentityZero: RUNTIMES.every((runtime) => byRuntime[runtime].usage.duplicateIdentityGroups === 0),
      terminalCreditsReconciled: RUNTIMES.every((runtime) => byRuntime[runtime].runs.creditReconciliationViolations === 0),
    },
    interpretation: {
      sameArgsMultipleCallGroups: "Observation only: identical normalized arguments may be legitimate in distinct approved plan slots.",
      retriedCalls: "Durable tool retry evidence; it is not by itself proof of Worker crash/re-claim.",
      pairedEvidence: "Quality and crash/re-claim conclusions come only from explicit paired evidence files, never inferred from status counts.",
    },
  };
}
