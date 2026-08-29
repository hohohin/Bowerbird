// HTML-RENDER-PLAN H6-T2/T4/T5：test-only HTML Skill 无内容观察报告。
//
// 读取 Supabase 控制面中的测试 Run、tool ledger、usage、artifact 元数据；仅对尚未
// 过期的 render_manifest 读取尺寸与输出 role，不输出 HTML、文案、图片、hash 或对象路径。
// 可选通过 --renderer-url=<隧道/容器内 URL> 读取 renderer /healthz 的 cgroup 峰值资源。
//
// 用法：cd apps/cloud && node scripts/report-html-render-observations.mjs [--days=14]
//       [--since=ISO] [--until=ISO] [--renderer-url=http://127.0.0.1:3917] [--json]

import { readFile } from "node:fs/promises";
import { buildHtmlRenderObservation, summarizeRenderManifest } from "./html-render-observation-lib.mjs";

const SKILL_ID = "bowerbird-html-layout-render";
const PAGE_SIZE = 500;

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (!match) continue;
    out[match[1]] = match[2].replace(/\s+#.*$/, "").trim();
  }
  return out;
}

function arg(name, fallback = undefined) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((value) => value.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
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
const adminHeaders = { apikey: secretKey, authorization: `Bearer ${secretKey}`, "content-type": "application/json" };

const days = Number(arg("days", "14"));
const manifestLimit = Number(arg("manifest-limit", "200"));
if (!Number.isFinite(days) || days < 1 || days > 92 || !Number.isSafeInteger(manifestLimit) || manifestLimit < 0 || manifestLimit > 1000) {
  console.error("--days 需在 1–92 之间；--manifest-limit 需在 0–1000 之间");
  process.exit(2);
}
const untilMs = arg("until") ? Date.parse(arg("until")) : Date.now();
const sinceMs = arg("since") ? Date.parse(arg("since")) : untilMs - days * 24 * 3600 * 1000;
if (!Number.isFinite(untilMs) || !Number.isFinite(sinceMs) || sinceMs >= untilMs || untilMs - sinceMs > 92 * 24 * 3600 * 1000) {
  console.error("--since/--until 不是有效的 ≤92 天时间范围");
  process.exit(2);
}
const since = new Date(sinceMs).toISOString();
const until = new Date(untilMs).toISOString();

async function restRows(resource, params, limit = 5000) {
  const rows = [];
  while (rows.length < limit) {
    const query = new URLSearchParams(params);
    const response = await fetch(`${baseUrl}/rest/v1/${resource}?${query}`, {
      headers: { ...adminHeaders, range: `${rows.length}-${Math.min(rows.length + PAGE_SIZE - 1, limit - 1)}` },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let page;
    try { page = text ? JSON.parse(text) : []; } catch { page = null; }
    if (!response.ok || !Array.isArray(page)) {
      throw new Error(`${resource} 读取失败 HTTP ${response.status}: ${page?.message ?? text.slice(0, 160)}`);
    }
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return { rows, truncated: rows.length >= limit };
}

async function relatedRows(resource, select, runIds) {
  const rows = [];
  let truncated = false;
  for (const group of chunks(runIds, 80)) {
    const result = await restRows(resource, { select, run_id: `in.(${group.join(",")})` });
    rows.push(...result.rows);
    truncated ||= result.truncated;
  }
  return { rows, truncated };
}

async function downloadManifest(artifact) {
  const encodedKey = artifact.object_key.split("/").map(encodeURIComponent).join("/");
  const signedResponse = await fetch(`${baseUrl}/storage/v1/object/sign/agent-temp/${encodedKey}`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ expiresIn: 60 }),
    signal: AbortSignal.timeout(20_000),
  });
  const signed = await signedResponse.json().catch(() => null);
  if (!signedResponse.ok || !signed?.signedURL) throw new Error(`manifest 签名失败 HTTP ${signedResponse.status}`);
  const response = await fetch(`${baseUrl}/storage/v1${signed.signedURL}`, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`manifest 下载失败 HTTP ${response.status}`);
  return summarizeRenderManifest(artifact.run_id, await response.json());
}

async function mapConcurrent(values, concurrency, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor++;
      try { results[index] = await mapper(values[index]); } catch { results[index] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

async function readWorkerHealth() {
  const url = (env.AGENT_CONTROL_URL || `${baseUrl}/functions/v1/agent-worker`)?.replace(/\/$/, "");
  if (!env.AGENT_WORKER_TOKEN) return null;
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${env.AGENT_WORKER_TOKEN}`, "x-worker-id": "html-render-observation", "content-type": "application/json" },
    body: JSON.stringify({ action: "metrics" }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => null);
  return response.ok ? body : { unavailable: true, status: response.status };
}

async function readRendererHealth() {
  const rendererUrl = arg("renderer-url", env.HTML_RENDERER_HEALTH_URL)?.replace(/\/$/, "");
  if (!rendererUrl) return null;
  try {
    const response = await fetch(`${rendererUrl}/healthz`, { signal: AbortSignal.timeout(10_000) });
    const body = await response.json().catch(() => null);
    return response.ok ? body : { unavailable: true, status: response.status };
  } catch {
    return { unavailable: true };
  }
}

function inWindowParams(select) {
  return {
    select,
    skill_id: `eq.${SKILL_ID}`,
    is_test: "eq.true",
    and: `(created_at.gte.${since},created_at.lt.${until})`,
    order: "created_at.desc",
  };
}

try {
  const runResult = await restRows("agent_runs", inWindowParams("id,status,attempt_count,actual_credits,budget_credits,error_code,created_at,queued_at,started_at,finished_at,content_expires_at,content_deleted_at"));
  const runIds = runResult.rows.map((run) => run.id);
  const empty = { rows: [], truncated: false };
  const [toolResult, usageResult, artifactResult, expiredRunResult, workerHealth, rendererHealth] = await Promise.all([
    runIds.length ? relatedRows("agent_tool_calls", "run_id,tool_name,status,attempt,started_at,finished_at,safe_error_code", runIds) : empty,
    runIds.length ? relatedRows("agent_usage_items", "run_id,kind,provider,input_units,output_units,credits,provider_cost_micros", runIds) : empty,
    runIds.length ? relatedRows("agent_artifacts", "run_id,role,mime,bytes,object_key,expires_at,deleted_at", runIds) : empty,
    restRows("agent_runs", {
      select: "id", skill_id: `eq.${SKILL_ID}`, is_test: "eq.true",
      content_expires_at: `lte.${new Date().toISOString()}`, content_deleted_at: "is.null",
    }),
    readWorkerHealth(),
    readRendererHealth(),
  ]);

  const eligibleManifests = artifactResult.rows
    .filter((artifact) => artifact.role === "render_manifest" && !artifact.deleted_at && Date.parse(artifact.expires_at) > Date.now());
  const liveManifests = eligibleManifests.slice(0, manifestLimit);
  const manifests = (await mapConcurrent(liveManifests, 4, downloadManifest)).filter(Boolean);

  let globalExpiredArtifacts = 0;
  if (expiredRunResult.rows.length) {
    const expiredIds = expiredRunResult.rows.map((run) => run.id);
    for (const group of chunks(expiredIds, 80)) {
      const result = await restRows("agent_artifacts", {
        select: "id", run_id: `in.(${group.join(",")})`,
        expires_at: `lte.${new Date().toISOString()}`, deleted_at: "is.null",
      });
      globalExpiredArtifacts += result.rows.length;
    }
  }

  const observation = buildHtmlRenderObservation({
    runs: runResult.rows,
    tools: toolResult.rows,
    usage: usageResult.rows,
    artifacts: artifactResult.rows,
    manifests,
  });
  const report = {
    measuredAt: new Date().toISOString(),
    window: { since, until },
    skillId: SKILL_ID,
    access: "test_only",
    truncated: runResult.truncated || toolResult.truncated || usageResult.truncated || artifactResult.truncated,
    ...observation,
    manifests: {
      ...observation.manifests,
      eligible: eligibleManifests.length,
      attempted: liveManifests.length,
      unreadable: liveManifests.length - manifests.length,
    },
    ttl: {
      ...observation.ttl,
      skillBacklogNow: { runs: expiredRunResult.rows.length, artifacts: globalExpiredArtifacts, truncated: expiredRunResult.truncated },
    },
    workerHealth,
    rendererHealth,
  };

  if (flag("json")) console.log(JSON.stringify(report, null, 2));

  const fmtMs = (value) => value === null ? "n/a" : value >= 60_000 ? `${(value / 60_000).toFixed(1)}m` : `${(value / 1000).toFixed(1)}s`;
  const fmtPct = (value) => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
  const fmtBytes = (value) => value === null ? "n/a" : `${(value / 1024 / 1024).toFixed(1)} MiB`;
  const gate = (value) => value === null ? "N/A（无样本）" : value ? "PASS" : "FAIL";
  const r = report.runs;
  console.log("Bowerbird HTML Renderer H6 观察报告（仅测试 Run）");
  console.log(`  窗口: ${since} → ${until}${report.truncated ? "（样本截断）" : ""}`);
  console.log(`  Run: ${r.total}；成功 ${r.succeeded} / 失败 ${r.failed} / 取消 ${r.cancelled} / 进行中 ${r.active}；技术成功率 ${fmtPct(r.successRate)}`);
  console.log(`  全程: p50=${fmtMs(r.duration.p50Ms)} p95=${fmtMs(r.duration.p95Ms)} max=${fmtMs(r.duration.maxMs)}；排队 p95=${fmtMs(r.queueWait.p95Ms)}`);
  console.log(`  render_html: ${report.render.toolCalls} 次；p50=${fmtMs(report.render.duration.p50Ms)} p95=${fmtMs(report.render.duration.p95Ms)}；重复/缺失 ${report.render.exactlyOnceViolations.length}`);
  const failures = Object.entries(r.failuresByCode);
  const renderFailures = Object.entries(report.render.failuresByCode);
  console.log(`  Run 失败分类: ${failures.length ? failures.map(([code, count]) => `${code}=${count}`).join(", ") : "无"}`);
  console.log(`  Renderer 失败分类: ${renderFailures.length ? renderFailures.map(([code, count]) => `${code}=${count}`).join(", ") : "无"}`);
  console.log(`  产物: ${report.artifacts.total} 个 / ${fmtBytes(report.artifacts.totalBytes)}；manifest 样本 ${report.manifests.sampled}/${report.manifests.attempted}${report.manifests.eligible > report.manifests.attempted ? `（可用 ${report.manifests.eligible}，受 --manifest-limit 限制）` : ""}`);
  console.log(`  像素/切片: avg=${report.manifests.averageDevicePixels === null ? "n/a" : Math.round(report.manifests.averageDevicePixels).toLocaleString()} px / ${report.manifests.averageSlices === null ? "n/a" : report.manifests.averageSlices.toFixed(1)} slices；p95=${report.manifests.p95DevicePixels ?? "n/a"} px / ${report.manifests.p95Slices ?? "n/a"} slices`);
  console.log(`  计费: Run 合计 ${r.credits.total} 积分；renderer ${report.render.htmlCredits} 积分（应为 0）`);
  console.log(`  TTL: 本 Skill 当前 Run ${report.ttl.skillBacklogNow.runs} / artifact ${report.ttl.skillBacklogNow.artifacts} 条待清理`);
  console.log(`  Worker: ${workerHealth === null ? "未配置 token，未采样" : workerHealth.unavailable ? `不可用（HTTP ${workerHealth.status ?? "n/a"}）` : `queue=${workerHealth.queueDepth ?? "n/a"}, active=${workerHealth.activeRuns ?? "n/a"}, expiredLeases=${workerHealth.expiredLeases ?? "n/a"}`}`);
  const resources = rendererHealth?.resources;
  console.log(`  Renderer: ${rendererHealth === null ? "未提供 --renderer-url，未采样" : rendererHealth.unavailable ? "不可达" : `fingerprint=${rendererHealth.rendererFingerprint ?? "n/a"}, peakMemory=${fmtBytes(resources?.cgroupMemoryPeakBytes ?? null)}, peakPids=${resources?.cgroupPidsPeak ?? "n/a"}`}`);
  console.log(`  自动门槛: render 恰好一次=${gate(report.invariants.renderExactlyOnce)}；Vision=0=${gate(report.invariants.visionZero)}；renderer 0 积分=${gate(report.invariants.rendererCreditsZero)}；TTL 清空=${report.ttl.skillBacklogNow.runs + report.ttl.skillBacklogNow.artifacts === 0 ? "PASS" : "FAIL"}`);
  console.log("  决策状态: 维持 test-only；定价与扩大开放仍需观察样本及人工 UX 判断，不由本脚本自动变更。");
} catch (error) {
  console.error(`HTML H6 观察失败: ${String(error?.message ?? error).slice(0, 300)}`);
  process.exitCode = 1;
}
