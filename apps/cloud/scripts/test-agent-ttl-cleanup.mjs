// Destructive test for one explicitly selected, disposable Agent E2E Run.
// It expires the Run's short-lived content, invokes Worker cleanup twice, and
// proves objects/events are gone while durable control/usage metadata remains.
// Usage: node --env-file=.env scripts/test-agent-ttl-cleanup.mjs --run-id <uuid>

import assert from "node:assert/strict";

const args = process.argv.slice(2);
const runIndex = args.indexOf("--run-id");
const runId = runIndex >= 0 ? args[runIndex + 1] : "";
const baseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
const workerToken = process.env.AGENT_WORKER_TOKEN?.trim();
if (!/^[0-9a-f-]{36}$/i.test(runId) || !baseUrl || !secretKey || !workerToken) {
  console.error("需要 --run-id，以及 .env 中的 SUPABASE_URL / SUPABASE_SECRET_KEY / AGENT_WORKER_TOKEN");
  process.exit(2);
}

const adminHeaders = {
  apikey: secretKey,
  authorization: `Bearer ${secretKey}`,
  "content-type": "application/json",
};
const workerHeaders = {
  authorization: `Bearer ${workerToken}`,
  "x-worker-id": "ttl-e2e",
  "content-type": "application/json",
};

async function request(label, url, init = {}, expected = [200, 204]) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!expected.includes(response.status)) throw new Error(`${label}失败：HTTP ${response.status}`);
  return { response, body };
}

function rest(table, query) {
  return `${baseUrl}/rest/v1/${table}?${query}`;
}

function storageUrl(key) {
  return `${baseUrl}/storage/v1/object/agent-temp/${key.split("/").map(encodeURIComponent).join("/")}`;
}

const runQuery = `id=eq.${encodeURIComponent(runId)}&select=id,status,request_object_key,checkpoint_object_key,feedback_object_key,content_deleted_at`;
const { body: runs } = await request("读取 Run", rest("agent_runs", runQuery), { headers: adminHeaders });
assert.equal(runs.length, 1, "Run 不存在");
assert.equal(runs[0].content_deleted_at, null, "Run 内容已经清理，不能重复用作首次验收");

const { body: artifacts } = await request("读取 artifacts", rest(
  "agent_artifacts",
  `run_id=eq.${encodeURIComponent(runId)}&deleted_at=is.null&select=id,object_key`,
), { headers: adminHeaders });
const { body: approvals } = await request("读取 approvals", rest(
  "agent_approvals",
  `run_id=eq.${encodeURIComponent(runId)}&content_deleted_at=is.null&select=id,proposal_object_key`,
), { headers: adminHeaders });
const knownKeys = new Set([
  runs[0].request_object_key,
  runs[0].checkpoint_object_key,
  runs[0].feedback_object_key,
  ...artifacts.map((row) => row.object_key),
  ...approvals.map((row) => row.proposal_object_key),
].filter(Boolean));
assert.ok(knownKeys.size > 0, "测试 Run 没有可验证的临时对象");

const expiredAt = new Date(Date.now() - 60_000).toISOString();
const expire = async (table, query, body) => await request(`到期 ${table}`, rest(table, query), {
  method: "PATCH",
  headers: { ...adminHeaders, prefer: "return=minimal" },
  body: JSON.stringify(body),
});
await expire("agent_runs", `id=eq.${encodeURIComponent(runId)}`, { content_expires_at: expiredAt });
await expire("agent_events", `run_id=eq.${encodeURIComponent(runId)}`, { content_expires_at: expiredAt });
await expire("agent_artifacts", `run_id=eq.${encodeURIComponent(runId)}&deleted_at=is.null`, { expires_at: expiredAt });
await expire("agent_approvals", `run_id=eq.${encodeURIComponent(runId)}&content_deleted_at=is.null`, { expires_at: expiredAt });

const cleanup = async () => (await request("执行 Agent TTL cleanup", `${baseUrl}/functions/v1/agent-worker`, {
  method: "POST",
  headers: workerHeaders,
  body: JSON.stringify({ action: "cleanup_expired" }),
})).body;
const first = await cleanup();
assert.ok(first.expiredRuns >= 1, "首次清理没有认领测试 Run");
assert.ok(first.removedObjects >= knownKeys.size, "首次清理对象数小于已知对象数");
assert.ok(first.deletedEvents >= 1, "首次清理没有删除事件正文");

const { body: cleanedRuns } = await request("复核 Run tombstone", rest("agent_runs", runQuery), { headers: adminHeaders });
assert.ok(cleanedRuns[0].content_deleted_at, "Run 未写入 content_deleted_at");
const { body: remainingArtifacts } = await request("复核 artifact tombstone", rest(
  "agent_artifacts",
  `run_id=eq.${encodeURIComponent(runId)}&deleted_at=is.null&select=id`,
), { headers: adminHeaders });
assert.equal(remainingArtifacts.length, 0, "仍有未标记删除的 artifact");
const { body: remainingEvents } = await request("复核事件正文", rest(
  "agent_events",
  `run_id=eq.${encodeURIComponent(runId)}&select=seq`,
), { headers: adminHeaders });
assert.equal(remainingEvents.length, 0, "DB 仍残留过期事件正文");

for (const key of knownKeys) {
  const response = await fetch(storageUrl(key), { headers: adminHeaders, signal: AbortSignal.timeout(30_000) });
  assert.ok([400, 404].includes(response.status), `过期对象仍可下载：${key} / HTTP ${response.status}`);
}

const second = await cleanup();
assert.deepEqual(second, { removedObjects: 0, deletedEvents: 0, expiredRuns: 0 }, "二次清理不是幂等空操作");
console.log(JSON.stringify({ runId, first, second, durableStatus: cleanedRuns[0].status }, null, 2));
