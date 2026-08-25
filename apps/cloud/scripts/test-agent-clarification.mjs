// A2-T9 production control-plane E2E. Uses a test account and a synthetic
// leased Run; it never calls a model or image provider.

import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const baseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();
const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
const workerToken = process.env.AGENT_WORKER_TOKEN?.trim();
if (!baseUrl || !publishableKey || !secretKey || !workerToken) {
  console.error("缺少 Supabase keys 或 AGENT_WORKER_TOKEN");
  process.exit(2);
}

const adminHeaders = {
  apikey: secretKey,
  authorization: `Bearer ${secretKey}`,
  "content-type": "application/json",
};
const workerHeaders = {
  authorization: `Bearer ${workerToken}`,
  "x-worker-id": "clarification-smoke",
  "content-type": "application/json",
};
const functionUrl = (name) => `${baseUrl}/functions/v1/${name}`;

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function request(label, url, init, expected = [200]) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!expected.includes(response.status)) {
    throw new Error(`${label}: HTTP ${response.status} / ${body?.error?.code ?? "unknown"} / ${body?.error?.message ?? text}`);
  }
  return body;
}

let userId;
let runId;
const objectKeys = [];
let testError;
try {
  const email = `agent-clarification-${Date.now()}-${randomBytes(4).toString("hex")}@example.test`;
  const password = `${randomBytes(16).toString("hex")}Aa1!`;
  const createdUser = await request("创建测试账号", `${baseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ email, password, email_confirm: true, app_metadata: { bowerbird_test: true } }),
  }, [200, 201]);
  userId = createdUser.id;
  const session = await request("登录测试账号", `${baseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: publishableKey, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const userHeaders = {
    apikey: publishableKey,
    authorization: `Bearer ${session.access_token}`,
    "content-type": "application/json",
  };

  const manifest = JSON.stringify({ schemaVersion: 1, intentPrompt: "生成一张海报", references: [] });
  const created = await request("创建测试 Run", functionUrl("agent-run"), {
    method: "POST",
    headers: userHeaders,
    body: JSON.stringify({
      action: "create",
      skillId: "bowerbird-controlled-image-edit",
      goal: "澄清控制面测试",
      inputCount: 0,
      inputManifestHash: sha256(manifest),
      idempotencyKey: `clarification-${randomBytes(8).toString("hex")}`,
    }),
  });
  runId = created.runId;
  const leaseId = randomUUID();
  const oldPlanHash = "a".repeat(64);
  await request("建立 synthetic lease", `${baseUrl}/rest/v1/agent_runs?id=eq.${encodeURIComponent(runId)}`, {
    method: "PATCH",
    headers: { ...adminHeaders, prefer: "return=minimal" },
    body: JSON.stringify({
      status: "running",
      lease_id: leaseId,
      lease_owner: "clarification-smoke",
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      heartbeat_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      cancel_requested_at: new Date().toISOString(),
      approved_plan_hash: oldPlanHash,
      planned_tool_count: 2,
    }),
  }, [204]);

  const contextHash = sha256("clarification-context");
  const proposal = {
    questionKey: "choose.strategy",
    contextHash,
    question: "你希望直接生成，还是使用受控多步方案？",
    recommendedAnswer: "直接生成",
    options: ["直接生成", "受控多步"],
    optionPatches: [
      { answer: "直接生成", patches: [{ field: "strategy", op: "set", value: "direct" }] },
      { answer: "受控多步", patches: [{ field: "strategy", op: "set", value: "controlled" }] },
    ],
    affectedIntentFields: ["strategy"],
    rationale: "不同路线会改变步骤数量和预算。",
  };
  const proposalHash = sha256(canonicalJson(proposal));
  await request("Worker 提交澄清", functionUrl("agent-worker"), {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({ action: "clarification_request", runId, leaseId, proposal, proposalHash }),
  });
  objectKeys.push(`runs/${runId}/clarifications/${proposalHash}.json`);

  const waiting = await request("用户读取澄清", functionUrl("agent-run"), {
    method: "POST",
    headers: userHeaders,
    body: JSON.stringify({ action: "get", runId }),
  });
  assert.equal(waiting.run.status, "awaiting_clarification");
  assert.equal(waiting.run.approved_plan_hash, oldPlanHash);
  assert.equal(waiting.clarifications.length, 1);
  assert.equal(waiting.clarifications[0].question.recommendedAnswer, "直接生成");
  const clarificationId = waiting.clarifications[0].id;
  objectKeys.push(`runs/${runId}/clarifications/${clarificationId}-answer.json`);

  const answered = await request("用户回答澄清", functionUrl("agent-run"), {
    method: "POST",
    headers: userHeaders,
    body: JSON.stringify({
      action: "answer_clarification",
      clarificationId,
      contextHash,
      answer: "直接生成",
    }),
  });
  assert.equal(answered.status, "queued");

  const rows = await request("核对事务结果", `${baseUrl}/rest/v1/agent_runs?id=eq.${encodeURIComponent(runId)}&select=status,approved_plan_hash,planned_tool_count,cancel_requested_at`, {
    method: "GET",
    headers: adminHeaders,
  });
  assert.equal(rows[0].status, "queued");
  assert.equal(rows[0].approved_plan_hash, null);
  assert.equal(rows[0].planned_tool_count, null);
  assert.ok(rows[0].cancel_requested_at, "synthetic cancel marker should keep the Run unclaimable");
  const clarificationRows = await request("核对回答绑定", `${baseUrl}/rest/v1/agent_clarifications?id=eq.${clarificationId}&select=status,context_hash,intent_patch_hash,answer_object_key`, {
    method: "GET",
    headers: adminHeaders,
  });
  assert.equal(clarificationRows[0].status, "answered");
  assert.equal(clarificationRows[0].context_hash, contextHash);
  assert.match(clarificationRows[0].intent_patch_hash, /^[0-9a-f]{64}$/);

  console.log("AGENT_CLARIFICATION_OK");
  console.log(`run=${runId} question_key=choose.strategy old_plan_invalidated=1 intent_patch_bound=1`);
} catch (error) {
  testError = error;
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
} finally {
  if (runId) {
    try {
      await fetch(`${baseUrl}/rest/v1/rpc/cancel_unleased_agent_run`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ p_run_id: runId }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch { /* best effort */ }
  }
  for (const objectKey of objectKeys) {
    try {
      await fetch(`${baseUrl}/storage/v1/object/agent-temp/${objectKey}`, {
        method: "DELETE",
        headers: adminHeaders,
        signal: AbortSignal.timeout(30_000),
      });
    } catch { /* best effort */ }
  }
  if (userId) {
    try {
      await fetch(`${baseUrl}/auth/v1/admin/users/${userId}`, {
        method: "DELETE",
        headers: adminHeaders,
        signal: AbortSignal.timeout(30_000),
      });
    } catch { /* best effort */ }
  }
}

if (testError) process.exit(1);
