// UNIFIED-AGENT-HARNESS-PLAN U6: content-free test-only runtime observation report.
// Usage: cd apps/cloud && node scripts/report-unified-agent-observations.mjs [--days=14]
//        [--since=ISO] [--until=ISO] [--evidence=path/to/observations.json] [--json]

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  buildUnifiedAgentObservation,
  evidenceRowsFromDocument,
} from "./unified-agent-observation-lib.mjs";

const PAGE_SIZE = 500;
const SKILL_IDS = ["bowerbird-controlled-image-edit", "bowerbird-unified-agent"];

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (match) out[match[1]] = match[2].replace(/\s+#.*$/, "").trim();
  }
  return out;
}

function arg(name, fallback = undefined) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((value) => value.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function args(name) {
  const prefix = `--${name}=`;
  return process.argv.filter((value) => value.startsWith(prefix)).map((value) => value.slice(prefix.length));
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function chunks(values, size) {
  const result = [];
  for (let offset = 0; offset < values.length; offset += size) result.push(values.slice(offset, offset + size));
  return result;
}

const env = parseEnv(await readFile(new URL("../.env", import.meta.url), "utf8"));
const baseUrl = env.SUPABASE_URL?.replace(/\/$/, "");
const secretKey = env.SUPABASE_SECRET_KEY?.trim();
if (!baseUrl || !secretKey) {
  console.error("缺少 SUPABASE_URL / SUPABASE_SECRET_KEY（读取 apps/cloud/.env）");
  process.exit(2);
}
const headers = { apikey: secretKey, authorization: `Bearer ${secretKey}` };
const days = Number(arg("days", "14"));
const untilMs = arg("until") ? Date.parse(arg("until")) : Date.now();
const sinceMs = arg("since") ? Date.parse(arg("since")) : untilMs - days * 24 * 3600 * 1000;
if (!Number.isFinite(days) || days < 1 || days > 92 || !Number.isFinite(untilMs) || !Number.isFinite(sinceMs) ||
    sinceMs >= untilMs || untilMs - sinceMs > 92 * 24 * 3600 * 1000) {
  console.error("观察窗口必须是 1–92 天内的有效 --days 或 --since/--until");
  process.exit(2);
}
const since = new Date(sinceMs).toISOString();
const until = new Date(untilMs).toISOString();

async function restRows(resource, params, limit = 5_000) {
  const rows = [];
  while (rows.length < limit) {
    const query = new URLSearchParams(params);
    const response = await fetch(`${baseUrl}/rest/v1/${resource}?${query}`, {
      headers: { ...headers, range: `${rows.length}-${Math.min(rows.length + PAGE_SIZE - 1, limit - 1)}` },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    const page = JSON.parse(text || "[]");
    if (!response.ok || !Array.isArray(page)) throw new Error(`${resource}_read_failed_http_${response.status}`);
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return { rows, truncated: rows.length >= limit };
}

async function relatedRows(resource, select, runIds) {
  const result = { rows: [], truncated: false };
  for (const group of chunks(runIds, 80)) {
    const page = await restRows(resource, { select, run_id: `in.(${group.join(",")})` });
    result.rows.push(...page.rows);
    result.truncated ||= page.truncated;
  }
  return result;
}

async function readEvidence() {
  const rows = [];
  for (const path of args("evidence")) {
    const value = JSON.parse(await readFile(resolve(path), "utf8"));
    rows.push(...evidenceRowsFromDocument(value));
  }
  return rows;
}

function pct(value) {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function ms(value) {
  return value === null ? "n/a" : `${Math.round(value)}ms`;
}

try {
  const runResult = await restRows("agent_runs", {
    select: "id,skill_id,agent_runtime,status,attempt_count,actual_credits,error_code,created_at,finished_at",
    skill_id: `in.(${SKILL_IDS.join(",")})`,
    agent_runtime: "in.(legacy_kernel,dsh)",
    is_test: "eq.true",
    and: `(created_at.gte.${since},created_at.lt.${until})`,
    order: "created_at.desc",
  });
  const runIds = runResult.rows.map((run) => run.id);
  const empty = { rows: [], truncated: false };
  const [toolResult, usageResult, evidence] = await Promise.all([
    runIds.length ? relatedRows("agent_tool_calls", "run_id,call_id,phase,tool_name,args_hash,attempt,status,safe_error_code,started_at,finished_at", runIds) : empty,
    runIds.length ? relatedRows("agent_usage_items", "run_id,call_id,kind,provider,input_units,output_units,credits,provider_cost_micros", runIds) : empty,
    readEvidence(),
  ]);
  const report = {
    measuredAt: new Date().toISOString(),
    window: { since, until },
    access: "test_only",
    skills: SKILL_IDS,
    truncated: runResult.truncated || toolResult.truncated || usageResult.truncated,
    ...buildUnifiedAgentObservation({ runs: runResult.rows, tools: toolResult.rows, usage: usageResult.rows, evidence }),
    decision: "observation_only_no_runtime_or_feature_policy_change",
  };
  if (flag("json")) console.log(JSON.stringify(report, null, 2));
  console.log("Bowerbird Unified Agent U6 观察报告（仅测试 Run、无内容）");
  console.log(`  窗口: ${since} → ${until}${report.truncated ? "（样本截断）" : ""}`);
  for (const runtime of ["legacy_kernel", "dsh"]) {
    const row = report.byRuntime[runtime];
    console.log(`  ${runtime}: Run=${row.runs.total}, failure=${pct(row.runs.failureRate)}, cancel=${pct(row.runs.cancelRate)}, p50/p95=${ms(row.runs.duration.p50Ms)}/${ms(row.runs.duration.p95Ms)}, credits=${row.runs.credits.total}, provider_cost_micros=${row.usage.providerCostMicros}`);
    console.log(`    tools=${row.tools.total}, retry=${row.tools.retriedCalls}, outcome_unknown=${row.tools.outcomeUnknownCalls}, duplicate_call_id_groups=${row.tools.duplicateCallIdGroups}, duplicate_usage_groups=${row.usage.duplicateIdentityGroups}`);
    console.log(`    paired evidence: strategy=${pct(row.pairedEvidence.strategyAccuracy)}, structured=${pct(row.pairedEvidence.structuredSuccessRate)}, recovery=${pct(row.pairedEvidence.recoverySuccessRate)} (${row.pairedEvidence.cases} cases)`);
  }
  console.log(`  不变量: call id 无重复=${report.invariants.duplicateCallIdsZero ? "PASS" : "FAIL"}；usage identity 无重复=${report.invariants.duplicateUsageIdentityZero ? "PASS" : "FAIL"}；终态积分对账=${report.invariants.terminalCreditsReconciled ? "PASS" : "FAIL"}`);
  console.log("  决策状态: 仅生成观察证据；不自动修改 runtime、FeaturePolicy、预算或公开档位。");
} catch (error) {
  console.error(`Unified Agent U6 观察失败: ${String(error?.message ?? error).slice(0, 240)}`);
  process.exitCode = 1;
}
