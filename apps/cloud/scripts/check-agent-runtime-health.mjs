// A7-T4 content-free Agent control-plane health probe. Suitable for a cron or
// external uptime check; exits non-zero when an operational threshold is hit.
// Run: node --env-file=.env scripts/check-agent-runtime-health.mjs

const baseUrl = process.env.AGENT_CONTROL_URL?.trim()
  || `${process.env.SUPABASE_URL?.replace(/\/$/, "")}/functions/v1/agent-worker`;
const workerToken = process.env.AGENT_WORKER_TOKEN?.trim();
if (!baseUrl || baseUrl.startsWith("undefined/") || !workerToken) {
  console.error("缺少 AGENT_CONTROL_URL/SUPABASE_URL 或 AGENT_WORKER_TOKEN");
  process.exit(2);
}

function threshold(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name}_invalid`);
  return value;
}

const response = await fetch(baseUrl, {
  method: "POST",
  headers: {
    authorization: `Bearer ${workerToken}`,
    "x-worker-id": "agent-health-probe",
    "content-type": "application/json",
  },
  body: JSON.stringify({ action: "metrics" }),
  signal: AbortSignal.timeout(30_000),
});
const text = await response.text();
let metrics;
try { metrics = text ? JSON.parse(text) : null; } catch { metrics = null; }
if (!response.ok || !metrics) {
  console.error(`AGENT_HEALTH_UNAVAILABLE HTTP ${response.status}`);
  process.exit(1);
}

const alerts = [];
if (metrics.queueDepth >= threshold("AGENT_QUEUE_WARN_DEPTH", 80)) {
  alerts.push(`queue_depth=${metrics.queueDepth}`);
}
if (metrics.oldestQueuedAgeSeconds >= threshold("AGENT_QUEUE_WARN_AGE_SECONDS", 600)) {
  alerts.push(`oldest_queue_seconds=${metrics.oldestQueuedAgeSeconds}`);
}
if (metrics.expiredLeases > 0) alerts.push(`expired_leases=${metrics.expiredLeases}`);
const minimumSample = threshold("AGENT_SUCCESS_RATE_MIN_SAMPLE", 20);
const minimumSuccessRate = threshold("AGENT_SUCCESS_RATE_MIN", 0.95);
const completed = Number(metrics.last24h?.succeeded ?? 0) + Number(metrics.last24h?.failed ?? 0);
if (completed >= minimumSample && metrics.last24h?.successRate < minimumSuccessRate) {
  alerts.push(`success_rate=${Number(metrics.last24h.successRate).toFixed(4)}`);
}
const ttlBacklog = Number(metrics.ttlBacklog?.runs ?? 0) + Number(metrics.ttlBacklog?.artifacts ?? 0);
if (ttlBacklog > threshold("AGENT_TTL_BACKLOG_WARN", 100)) alerts.push(`ttl_backlog=${ttlBacklog}`);

console.log(JSON.stringify({ event: "agent_health_probe", metrics, alerts }));
if (alerts.length) {
  console.error(`AGENT_HEALTH_WARN ${alerts.join(" ")}`);
  process.exit(1);
}
console.log("AGENT_HEALTH_OK");
