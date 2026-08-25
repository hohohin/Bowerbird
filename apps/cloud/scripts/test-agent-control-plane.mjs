// Bowerbird Agent Runtime A1-T6: control-plane end-to-end with a mock worker.
// No model calls; verifies create → enqueue → claim → heartbeat → tool ledger →
// events → usage → finish settlement, RLS isolation between two users, and
// worker-token auth. Run: node --env-file=.env scripts/test-agent-control-plane.mjs

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

const baseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
const workerToken = process.env.AGENT_WORKER_TOKEN?.trim();

function namedKey(directName, objectName, legacyName) {
  const direct = process.env[directName]?.trim();
  if (direct) return direct;
  const objectValue = process.env[objectName]?.trim();
  if (objectValue) return JSON.parse(objectValue).default?.trim();
  return process.env[legacyName]?.trim();
}

const publishableKey = namedKey(
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_PUBLISHABLE_KEYS",
  "SUPABASE_ANON_KEY",
);
const secretKey = namedKey(
  "SUPABASE_SECRET_KEY",
  "SUPABASE_SECRET_KEYS",
  "SUPABASE_SERVICE_ROLE_KEY",
);

if (!baseUrl || !publishableKey || !secretKey || !workerToken) {
  console.error("缺少 SUPABASE_URL / publishable / secret key 或 AGENT_WORKER_TOKEN");
  process.exit(2);
}

const adminHeaders = {
  apikey: secretKey,
  authorization: `Bearer ${secretKey}`,
  "content-type": "application/json",
};
const workerHeaders = {
  authorization: `Bearer ${workerToken}`,
  "x-worker-id": "mock-worker-a",
  "content-type": "application/json",
};

function functionUrl(name) {
  return `${baseUrl}/functions/v1/${name}`;
}

async function jsonRequest(label, url, init, expectedStatuses = [200]) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!expectedStatuses.includes(response.status)) {
    const code = body?.error?.code ?? "unknown";
    const message = body?.error?.message ?? body?.message ?? "无错误详情";
    throw new Error(`${label}失败（HTTP ${response.status}, ${code}）：${message}`);
  }
  return body;
}

async function requestWithStatus(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: response.status, body };
}

async function createTempAccount(label) {
  const email = `agent-e2e-${Date.now()}-${randomBytes(4).toString("hex")}-${label}@example.test`;
  const password = `${randomBytes(16).toString("hex")}Aa1!`;
  const created = await jsonRequest(`创建临时账号(${label})`, `${baseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ email, password, email_confirm: true, app_metadata: { bowerbird_test: true } }),
  });
  const session = await jsonRequest(`临时账号登录(${label})`, `${baseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: publishableKey, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return {
    userId: created.id,
    headers: {
      apikey: publishableKey,
      authorization: `Bearer ${session.access_token}`,
      "content-type": "application/json",
    },
  };
}

const sha = (input) => createHash("sha256").update(input).digest("hex");

const accounts = [];
let testError;

try {
  // ── fixtures: two temp accounts ────────────────────────────────────────────
  const owner = await createTempAccount("owner");
  const stranger = await createTempAccount("stranger");
  accounts.push(owner.userId, stranger.userId);

  // ── negative: worker endpoints reject user JWT and bad token ─────────────
  await jsonRequest(
    "用户 JWT 不能调 worker 端点",
    functionUrl("agent-worker"),
    { method: "POST", headers: owner.headers, body: JSON.stringify({ action: "claim" }) },
    [401],
  );
  await jsonRequest(
    "错误 Worker Token 被拒",
    functionUrl("agent-worker"),
    {
      method: "POST",
      headers: { ...workerHeaders, authorization: `Bearer ${randomBytes(32).toString("hex")}` },
      body: JSON.stringify({ action: "claim" }),
    },
    [401],
  );

  // ── concurrent create capacity: Free policy permits exactly one active Run
  const capacityManifest = JSON.stringify({
    schemaVersion: 1,
    intentPrompt: "并发容量测试",
    references: [],
    ratio: "1:1",
  });
  const capacityKeys = [
    `agent-capacity-${randomBytes(8).toString("hex")}`,
    `agent-capacity-${randomBytes(8).toString("hex")}`,
  ];
  const capacityResults = await Promise.all(capacityKeys.map((idempotencyKey) => requestWithStatus(
    functionUrl("agent-run"),
    {
      method: "POST",
      headers: owner.headers,
      body: JSON.stringify({
        action: "create",
        skillId: "bowerbird-controlled-image-edit",
        goal: "并发容量测试",
        inputCount: 0,
        inputManifestHash: sha(capacityManifest),
        idempotencyKey,
      }),
    },
  )));
  assert.deepEqual(
    capacityResults.map((item) => item.status).sort((a, b) => a - b),
    [200, 429],
    `并发创建应恰有一个成功、一个被用户并发上限拒绝：${JSON.stringify(capacityResults)}`,
  );
  const capacityWinner = capacityResults.find((item) => item.status === 200)?.body;
  const capacityLoser = capacityResults.find((item) => item.status === 429)?.body;
  assert.ok(capacityWinner?.runId, "并发创建胜者缺少 runId");
  assert.equal(capacityLoser?.error?.code, "rate_limited", "并发创建败者应返回 rate_limited");
  await jsonRequest("取消并发容量测试 Run", functionUrl("agent-run"), {
    method: "POST",
    headers: owner.headers,
    body: JSON.stringify({ action: "cancel", runId: capacityWinner.runId }),
  });
  for (const idempotencyKey of capacityKeys) {
    const holds = await jsonRequest(
      "读取并发容量测试 hold",
      `${baseUrl}/rest/v1/credit_holds?idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&select=id,status`,
      { method: "GET", headers: adminHeaders },
    );
    assert.equal(holds.length, 1, "每个并发创建请求都应只有一个幂等 hold");
    assert.equal(holds[0].status, "rolled_back", "胜者取消、败者拒绝后 hold 均应释放");
  }

  // ── create → enqueue ──────────────────────────────────────────────────────
  const requestManifest = JSON.stringify({
    schemaVersion: 1,
    intentPrompt: "生成一张清爽极简风格的测试图",
    references: [],
    ratio: "1:1",
  });
  const manifestHash = sha(requestManifest);
  const idemKey = `agent-e2e-${randomBytes(8).toString("hex")}`;
  const created = await jsonRequest("创建 Run", functionUrl("agent-run"), {
    method: "POST",
    headers: owner.headers,
    body: JSON.stringify({
      action: "create",
      skillId: "bowerbird-controlled-image-edit",
      goal: "生成一张清爽极简风格的测试图",
      inputCount: 0,
      inputManifestHash: manifestHash,
      idempotencyKey: idemKey,
    }),
  });
  assert.ok(created.runId, "create 未返回 runId");
  assert.ok(created.uploadUrl, "create 未返回上传地址");
  assert.equal(created.budgetCredits, 9, "Free 受控编辑低档预算应为 9 分");
  const runId = created.runId;

  // create replay with same idempotency key must not double-hold
  const replayed = await jsonRequest("幂等重放 create", functionUrl("agent-run"), {
    method: "POST",
    headers: owner.headers,
    body: JSON.stringify({
      action: "create",
      skillId: "bowerbird-controlled-image-edit",
      goal: "生成一张清爽极简风格的测试图",
      inputCount: 0,
      inputManifestHash: manifestHash,
      idempotencyKey: idemKey,
    }),
  });
  assert.equal(replayed.runId, runId, "同幂等键 create 应返回同一 Run");

  // Upload the run request payload via the signed upload URL (real link path).
  const uploadResponse = await fetch(created.uploadUrl, {
    method: "PUT",
    headers: { ...created.uploadToken ? { authorization: `Bearer ${created.uploadToken}` } : {}, "content-type": "application/json", "x-upsert": "true" },
    body: requestManifest,
    signal: AbortSignal.timeout(60_000),
  });
  if (!uploadResponse.ok) throw new Error(`上传 request.json 失败（HTTP ${uploadResponse.status}）`);

  await jsonRequest("未实现 Skill 被拒", functionUrl("agent-run"), {
    method: "POST",
    headers: owner.headers,
    body: JSON.stringify({
      action: "create",
      skillId: "series-creative-director",
      goal: "x",
      inputCount: 3,
      inputManifestHash: manifestHash,
    }),
  }, [400]);

  await jsonRequest("Codex 与 Agent 互斥", functionUrl("agent-run"), {
    method: "POST",
    headers: owner.headers,
    body: JSON.stringify({
      action: "create",
      skillId: "bowerbird-controlled-image-edit",
      goal: "不应建立 Codex Agent Run",
      inputCount: 0,
      inputManifestHash: manifestHash,
      imageProvider: "codex",
      idempotencyKey: `agent-codex-blocked-${randomBytes(8).toString("hex")}`,
    }),
  }, [409]);

  await jsonRequest("入队", functionUrl("agent-run"), {
    method: "POST",
    headers: owner.headers,
    body: JSON.stringify({ action: "enqueue", runId }),
  });

  // ── RLS attack: stranger cannot see or touch the run ─────────────────────
  const strangerGet = await jsonRequest(
    "他人不可见该 Run（404）",
    functionUrl("agent-run"),
    { method: "POST", headers: stranger.headers, body: JSON.stringify({ action: "get", runId }) },
    [404],
  );
  assert.ok(strangerGet, "unreachable");
  await jsonRequest(
    "他人不能取消（404）",
    functionUrl("agent-run"),
    { method: "POST", headers: stranger.headers, body: JSON.stringify({ action: "cancel", runId }) },
    [404],
  );
  // Direct REST read with stranger JWT sees nothing (own-row RLS).
  const restList = await fetch(`${baseUrl}/rest/v1/agent_runs?id=eq.${runId}`, {
    headers: { apikey: publishableKey, authorization: stranger.headers.authorization },
  });
  assert.equal((await restList.json()).length, 0, "RLS：陌生用户直接 REST 查询应得空");
  // Direct REST write rejected.
  const restWrite = await fetch(`${baseUrl}/rest/v1/agent_runs`, {
    method: "POST",
    headers: { apikey: publishableKey, authorization: stranger.headers.authorization, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.ok([401, 403, 42501].includes(restWrite.status), `RLS：陌生用户直接写应被拒（实际 ${restWrite.status}）`);

  // ── worker: claim → heartbeat → tool ledger → events → usage ────────────
  const firstClaim = await jsonRequest("claim（应取到本 Run）", functionUrl("agent-worker"), {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({ action: "claim" }),
  });
  const claim = firstClaim;
  assert.ok(claim.run && claim.run.id === runId, `claim 应认领刚入队的 Run（实际 ${claim.run?.id ?? "null"}）`);
  assert.ok(claim.lease.leaseId, "claim 应返回租约");
  assert.ok(claim.inputUrl, "claim 应返回输入签名 URL");
  const leaseId = claim.lease.leaseId;

  const beat = await jsonRequest("心跳", functionUrl("agent-worker"), {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({ action: "heartbeat", runId, leaseId }),
  });
  assert.equal(beat.cancelRequested, false);

  await jsonRequest(
    "错误租约心跳被拒",
    functionUrl("agent-worker"),
    {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ action: "heartbeat", runId, leaseId: crypto.randomUUID() }),
    },
    [500],
  );

  const argsHash = sha(JSON.stringify({ prompt: "refine" }));
  await jsonRequest("tool_prepare", functionUrl("agent-worker"), {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({ action: "tool_prepare", runId, leaseId, callId: "call-refine-1", phase: "refine", toolName: "model_turn", argsHash }),
  });
  await jsonRequest("tool_submitted", functionUrl("agent-worker"), {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({ action: "tool_submitted", runId, leaseId, callId: "call-refine-1", providerRequestId: "req-1" }),
  });
  await jsonRequest("tool_complete", functionUrl("agent-worker"), {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({ action: "tool_complete", runId, leaseId, callId: "call-refine-1", status: "succeeded", resultHash: sha("result") }),
  });

  await jsonRequest("events 批量", functionUrl("agent-worker"), {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({
      action: "events",
      runId,
      leaseId,
      events: [
        { seq: 1, type: "run.started", step: "claim", progress: 5 },
        { seq: 2, type: "phase.started", step: "parse_intent", progress: 10 },
      ],
    }),
  });
  // Event replay with identical payload is idempotent.
  await jsonRequest("events 幂等重放", functionUrl("agent-worker"), {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({
      action: "events",
      runId,
      leaseId,
      events: [{ seq: 1, type: "run.started", step: "claim", progress: 5 }],
    }),
  });

  const usage = await jsonRequest("usage 上报", functionUrl("agent-worker"), {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({
      action: "usage",
      runId,
      leaseId,
      items: [
        { callId: "call-refine-1", kind: "model_tokens", provider: "deepseek", model: "deepseek-chat", inputUnits: 120_000, outputUnits: 8_000, imageCount: 0 },
      ],
    }),
  });
  assert.equal(usage.creditsCharged, 1, "服务端 token 换算（120k in / 8k out ≈ 1 分）");
  // Usage replay with same call_id is idempotent (no double charge).
  const usageReplay = await jsonRequest("usage 幂等重放", functionUrl("agent-worker"), {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({
      action: "usage",
      runId,
      leaseId,
      items: [
        { callId: "call-refine-1", kind: "model_tokens", provider: "deepseek", model: "deepseek-chat", inputUnits: 120_000, outputUnits: 8_000, imageCount: 0 },
      ],
    }),
  });
  assert.equal(usageReplay.creditsCharged, 0, "同 call_id usage 重放不再计费");
  // Unknown call id rejected.
  await jsonRequest("未登记 call 的 usage 被拒", functionUrl("agent-worker"), {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({
      action: "usage",
      runId,
      leaseId,
      items: [{ callId: "call-ghost", kind: "vision_call", provider: "ark", model: "vision", inputUnits: 0, outputUnits: 0, imageCount: 1 }],
    }),
  }, [400]);

  // ── owner sees progress; checkpoint ──────────────────────────────────────
  const progress = await jsonRequest("owner 查询进度", functionUrl("agent-run"), {
    method: "POST",
    headers: owner.headers,
    body: JSON.stringify({ action: "get", runId }),
  });
  assert.equal(progress.run.status, "leased", "Run 应处于 leased/running");

  const checkpointBody = JSON.stringify({ schemaVersion: 1, runId, phase: "score_dimensions" });
  const checkpointHash = sha(checkpointBody);
  const checkpointUpload = await jsonRequest("checkpoint prepare", functionUrl("agent-worker"), {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({ action: "checkpoint_prepare", runId, leaseId, checkpointHash, snapshotSchemaVersion: 1 }),
  });
  const checkpointPut = await fetch(checkpointUpload.uploadUrl, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-upsert": "true" },
    body: checkpointBody,
  });
  assert.equal(checkpointPut.ok, true, `checkpoint upload failed: ${checkpointPut.status}`);
  await jsonRequest("checkpoint commit", functionUrl("agent-worker"), {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({ action: "checkpoint_commit", runId, leaseId, checkpointHash, snapshotSchemaVersion: 1, step: "score_dimensions", progress: 60 }),
  });

  // A content-addressed checkpoint may be committed again when the worker
  // parks immediately after registering a local task. The signed upload must
  // therefore allow an idempotent overwrite of the same object key.
  const replayUpload = await jsonRequest("checkpoint prepare 幂等重放", functionUrl("agent-worker"), {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({ action: "checkpoint_prepare", runId, leaseId, checkpointHash, snapshotSchemaVersion: 1 }),
  });
  const replayPut = await fetch(replayUpload.uploadUrl, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-upsert": "true" },
    body: checkpointBody,
  });
  assert.equal(replayPut.ok, true, `checkpoint replay upload failed: ${replayPut.status}`);
  await jsonRequest("checkpoint commit 幂等重放", functionUrl("agent-worker"), {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({ action: "checkpoint_commit", runId, leaseId, checkpointHash, snapshotSchemaVersion: 1, step: "score_dimensions", progress: 60 }),
  });

  // ── finish → settlement ───────────────────────────────────────────────────
  const finished = await jsonRequest("finish", functionUrl("agent-worker"), {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({ action: "finish", runId, leaseId }),
  });
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.actualCredits, 1, "实际结算 = 已记录 usage（1 分），未用部分释放");

  const final = await jsonRequest("owner 查询终态", functionUrl("agent-run"), {
    method: "POST",
    headers: owner.headers,
    body: JSON.stringify({ action: "get", runId }),
  });
  assert.equal(final.run.status, "succeeded");
  assert.equal(final.run.actual_credits, 1);

  // A5-T5: one zero-amount business marker links this terminal Run to the
  // append-only credit ledger without prompt/image/object-key content.
  const runRows = await jsonRequest(
    "读取终态 Run hold",
    `${baseUrl}/rest/v1/agent_runs?id=eq.${encodeURIComponent(runId)}&select=hold_id`,
    { method: "GET", headers: adminHeaders },
  );
  assert.equal(runRows.length, 1);
  const markers = await jsonRequest(
    "读取 Agent 账单标记",
    `${baseUrl}/rest/v1/credit_transactions?hold_id=eq.${encodeURIComponent(runRows[0].hold_id)}&kind=eq.adjust&select=amount,meta`,
    { method: "GET", headers: adminHeaders },
  );
  assert.equal(markers.length, 1, "每个终态 Agent Run 应恰有一个账单标记");
  assert.equal(markers[0].amount, 0, "账单标记不得重复改变余额");
  assert.deepEqual(
    Object.keys(markers[0].meta).sort(),
    ["actual_credits", "entity_type", "final_status", "image_provider", "pricing_version", "run_id", "skill_id", "skill_version"].sort(),
    "账单标记只允许非内容技术字段",
  );
  assert.equal(markers[0].meta.entity_type, "agent_run");
  assert.equal(markers[0].meta.run_id, runId);
  assert.equal(markers[0].meta.final_status, "succeeded");
  assert.equal(markers[0].meta.actual_credits, 1);

  console.log("AGENT_CONTROL_PLANE_OK");
  console.log(`run=${runId} claimed=1 events=2 usage_credits=${finished.actualCredits} capacity=1/1 billing_marker=1`);
} catch (error) {
  testError = error;
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
} finally {
  for (const userId of accounts) {
    try {
      await fetch(`${baseUrl}/auth/v1/admin/users/${userId}`, {
        method: "DELETE",
        headers: adminHeaders,
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      // cleanup is best-effort
    }
  }
}

if (testError) process.exit(1);
