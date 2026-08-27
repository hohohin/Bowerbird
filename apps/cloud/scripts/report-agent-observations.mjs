// A8-T2 观察期报告：调用 agent-worker `observation` action，按时间窗聚合
// 成功率 / 审批漏斗与放弃率 / 耗时 / 重试率 / 积分与上游成本 / TTL 积压。
// 用法：
//   node scripts/report-agent-observations.mjs [--days=14] [--since=2026-08-25T00:00:00Z] [--until=...]
//                                             [--credit-cny=0.1] [--json]
// 说明：--credit-cny 提供「1 积分 ≈ 人民币元」时才输出毛利，仅用于估算。
// 自解析 ../.env（内联注释会破坏 node --env-file，见 PROJECT.md 踩坑）。

import { readFile } from "node:fs/promises";

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

const env = parseEnv(await readFile(new URL("../.env", import.meta.url), "utf8"));
const baseUrl = (env.AGENT_CONTROL_URL || `${env.SUPABASE_URL?.replace(/\/$/, "")}/functions/v1/agent-worker`)?.replace(/\/$/, "");
const workerToken = env.AGENT_WORKER_TOKEN;
if (!baseUrl || baseUrl.startsWith("undefined/") || !workerToken) {
  console.error("缺少 AGENT_CONTROL_URL/SUPABASE_URL 或 AGENT_WORKER_TOKEN（读取 apps/cloud/.env）");
  process.exit(2);
}

const days = Number(arg("days", "14"));
if (!Number.isFinite(days) || days < 1 || days > 92) {
  console.error("--days 需在 1–92 之间");
  process.exit(2);
}
const untilInput = arg("until");
const sinceInput = arg("since");
const until = untilInput ? Date.parse(untilInput) : Date.now();
const since = sinceInput ? Date.parse(sinceInput) : until - days * 24 * 3600 * 1000;
if (!Number.isFinite(until) || !Number.isFinite(since) || since >= until) {
  console.error("--since/--until 不是有效的时间范围");
  process.exit(2);
}
const creditCny = arg("credit-cny") === undefined ? null : Number(arg("credit-cny"));

const response = await fetch(baseUrl, {
  method: "POST",
  headers: {
    authorization: `Bearer ${workerToken}`,
    "x-worker-id": "agent-observation-report",
    "content-type": "application/json",
  },
  body: JSON.stringify({
    action: "observation",
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
  }),
  signal: AbortSignal.timeout(60_000),
});
const text = await response.text();
let report;
try { report = text ? JSON.parse(text) : null; } catch { report = null; }
if (!response.ok || !report || report.error) {
  const detail = report?.error?.message ?? text?.slice(0, 200) ?? "";
  console.error(`观察数据读取失败 HTTP ${response.status} ${detail}`);
  process.exit(1);
}
if (arg("json") !== undefined) {
  console.log(JSON.stringify(report, null, 2));
}

const pct = (value) => value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`;
const ms = (value) => value === null || value === undefined ? "n/a"
  : value >= 3600_000 ? `${(value / 3600_000).toFixed(2)}h`
  : value >= 60_000 ? `${(value / 60_000).toFixed(1)}m`
  : `${(value / 1000).toFixed(1)}s`;
const cny = (micros) => micros === null || micros === undefined ? "n/a" : `¥${(micros / 1_000_000).toFixed(4)}`;

const r = report.runs ?? {};
const a = report.approvals ?? {};
const u = report.usage ?? {};

console.log(`Bowerbird Agent A8 观察报告`);
console.log(`  窗口: ${report.window?.since} → ${report.window?.until}`);
console.log("");
console.log(`Run（非测试）  总数 ${r.total ?? 0}${r.truncated ? "（样本截断）" : ""}`);
console.log(`  成功 ${r.succeeded ?? 0} / 失败 ${r.failed ?? 0} / 取消 ${r.cancelled ?? 0} / 进行中 ${r.activeUnfinished ?? 0}`);
console.log(`  技术成功率 ${pct(r.successRate)}（发布门槛 ≥95%）`);
const failureCodes = Object.entries(r.failuresByCode ?? {}).sort((x, y) => y[1] - x[1]);
if (failureCodes.length) console.log(`  失败码 ${failureCodes.map(([code, count]) => `${code}=${count}`).join(", ")}`);
console.log(`  全程耗时 avg=${ms(r.avgDurationMs)} p50=${ms(r.p50DurationMs)} p95=${ms(r.p95DurationMs)}；排队等待 avg=${ms(r.avgQueueWaitMs)}`);
console.log(`  积分 avg=${r.avgCredits ?? "n/a"} max=${r.maxCredits ?? "n/a"}`);
console.log(`  测试 Run（不计入上述统计）: ${report.testRuns?.total ?? 0} 条`);
console.log("");
console.log(`审批漏斗  提出 ${a.proposed ?? 0} → 批准 ${a.approved ?? 0} / 拒绝 ${a.rejected ?? 0} / 过期未决 ${a.expired ?? 0} / 待决 ${a.pending ?? 0}`);
console.log(`  批准率 ${pct(a.approvalRate)}；审批后放弃率 ${pct(a.abandonmentRate)}；决策耗时 avg=${ms(a.avgDecisionMs)}`);
console.log(`  修订审批（重试线） ${a.revisionProposals ?? 0} 份`);
console.log(`  结果反馈: 接受 ${report.feedback?.accept ?? 0} / 重试 ${report.feedback?.retry ?? 0}，重试率 ${pct(report.feedback?.retryRate)}`);
console.log(`  有限澄清: 提问 ${report.clarifications?.asked ?? 0} 次，已回答 ${report.clarifications?.answered ?? 0} 次`);
console.log("");
console.log(`用量与成本（非测试）`);
console.log(`  usage 条目 ${u.items ?? 0}${u.truncated ? "（样本截断）" : ""}，积分合计 ${u.creditsTotal ?? 0}`);
console.log(`  上游成本估算 ${cny(u.providerCostMicrosTotal)}（覆盖率 ${pct(u.costCoverage)}；费率见 service_costs agent_usage_v1 parameters.provider_cost）`);
for (const [kind, bucket] of Object.entries(u.byKind ?? {})) {
  console.log(`    ${kind}: ${bucket.items} 条 / ${bucket.credits} 分 / ${cny(bucket.costMicros)}`);
}
if (creditCny !== null && Number.isFinite(creditCny)) {
  const creditsCny = (u.creditsTotal ?? 0) * creditCny;
  const costCny = (u.providerCostMicrosTotal ?? 0) / 1_000_000;
  console.log(`  毛利估算（1 积分=¥${creditCny}）：积分价值 ¥${creditsCny.toFixed(4)} - 上游 ¥${costCny.toFixed(4)} = ¥${(creditsCny - costCny).toFixed(4)}`);
}
console.log("");
console.log(`TTL 积压（当前，非窗口）: Run ${report.ttlBacklogNow?.runs ?? 0} / artifact ${report.ttlBacklogNow?.artifacts ?? 0}（清理成功近似 = 积压持续为 0）`);
