// U2 local-only control-plane E2E for unified Agent plan approval.
// No model/provider calls. Requires local Supabase + locally served Edge Functions.

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
  console.error("缺少本地 Supabase URL / publishable key / secret key 或 AGENT_WORKER_TOKEN");
  process.exit(2);
}
const parsedBaseUrl = new URL(baseUrl);
if (!(["127.0.0.1", "localhost"].includes(parsedBaseUrl.hostname) && parsedBaseUrl.protocol === "http:")) {
  console.error("本脚本只允许连接本地 HTTP Supabase，拒绝远端 URL");
  process.exit(2);
}

const adminHeaders = {
  apikey: secretKey,
  authorization: `Bearer ${secretKey}`,
  "content-type": "application/json",
};
const workerHeaders = {
  authorization: `Bearer ${workerToken}`,
  "x-worker-id": "local-unified-agent-e2e",
  "content-type": "application/json",
};

function functionUrl(name) {
  return `${baseUrl}/functions/v1/${name}`;
}

function reachableLocalUrl(value) {
  const url = new URL(value);
  if (["kong", "supabase_kong_bowerbird-cloud"].includes(url.hostname)) {
    return `${baseUrl}${url.pathname}${url.search}`;
  }
  return value;
}

async function requestWithStatus(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: response.status, body };
}

async function jsonRequest(label, url, init, expectedStatuses = [200]) {
  const result = await requestWithStatus(url, init);
  if (!expectedStatuses.includes(result.status)) {
    const code = result.body?.error?.code ?? "unknown";
    const message = result.body?.error?.message ?? result.body?.message ?? "无错误详情";
    throw new Error(`${label}失败（HTTP ${result.status}, ${code}）：${message}`);
  }
  return result.body;
}

async function createTempAccount() {
  const email = `unified-agent-local-${Date.now()}-${randomBytes(4).toString("hex")}@example.test`;
  const password = `${randomBytes(16).toString("hex")}Aa1!`;
  const created = await jsonRequest("创建临时账号", `${baseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ email, password, email_confirm: true, app_metadata: { bowerbird_test: true } }),
  });
  const session = await jsonRequest("临时账号登录", `${baseUrl}/auth/v1/token?grant_type=password`, {
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

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

const sha = (input) => createHash("sha256").update(input).digest("hex");
const accounts = [];
let testError;

try {
  const owner = await createTempAccount();
  accounts.push(owner.userId);

  const requestManifest = JSON.stringify({
    schemaVersion: 1,
    intentPrompt: "验证统一 Agent 计划审批控制面",
    references: [],
    ratio: "1:1",
  });
  const created = await jsonRequest("创建 Run", functionUrl("agent-run"), {
    method: "POST",
    headers: owner.headers,
    body: JSON.stringify({
      action: "create",
      skillId: "bowerbird-controlled-image-edit",
      goal: "验证统一 Agent 计划审批控制面",
      inputCount: 0,
      inputManifestHash: sha(requestManifest),
      idempotencyKey: `unified-agent-local-${randomBytes(8).toString("hex")}`,
    }),
  });
  const runId = created.runId;
  assert.ok(runId, "create 未返回 runId");

  const requestUpload = await fetch(reachableLocalUrl(created.uploadUrl), {
    method: "PUT",
    headers: {
      ...(created.uploadToken ? { authorization: `Bearer ${created.uploadToken}` } : {}),
      "content-type": "application/json",
      "x-upsert": "true",
    },
    body: requestManifest,
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(requestUpload.ok, true, `request upload failed: ${requestUpload.status}`);
  await jsonRequest("Run 入队", functionUrl("agent-run"), {
    method: "POST",
    headers: owner.headers,
    body: JSON.stringify({ action: "enqueue", runId }),
  });

  const firstClaim = await jsonRequest("首次认领", functionUrl("agent-worker"), {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({ action: "claim" }),
  });
  assert.equal(firstClaim.run?.id, runId, "Worker 应认领当前测试 Run");
  const firstLeaseId = firstClaim.lease?.leaseId;
  assert.ok(firstLeaseId, "首次认领缺少 leaseId");

  const checkpointBody = JSON.stringify({ schemaVersion: 1, runId, phase: "submit_plan" });
  const checkpointHash = sha(checkpointBody);
  const checkpoint = await jsonRequest("准备 checkpoint", functionUrl("agent-worker"), {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({
      action: "checkpoint_prepare",
      runId,
      leaseId: firstLeaseId,
      checkpointHash,
      snapshotSchemaVersion: 1,
    }),
  });
  const checkpointUpload = await fetch(reachableLocalUrl(checkpoint.uploadUrl), {
    method: "PUT",
    headers: { "content-type": "application/json", "x-upsert": "true" },
    body: checkpointBody,
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(checkpointUpload.ok, true, `checkpoint upload failed: ${checkpointUpload.status}`);
  await jsonRequest("提交 checkpoint 并进入 running", functionUrl("agent-worker"), {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({
      action: "checkpoint_commit",
      runId,
      leaseId: firstLeaseId,
      checkpointHash,
      snapshotSchemaVersion: 1,
      step: "submit_plan",
      progress: 20,
    }),
  });

  const fixtureBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const fixtureCallId = sha(`unified-agent-asset:${runId}:0`);
  await jsonRequest("登记本地图片 fixture 调用", functionUrl("agent-worker"), {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({
      action: "tool_prepare",
      runId,
      leaseId: firstLeaseId,
      callId: fixtureCallId,
      phase: "unified_asset_fixture",
      toolName: "generate_image",
      argsHash: sha(canonicalJson({ fixture: "one-pixel-png" })),
    }),
  });
  await jsonRequest("标记图片 fixture 已提交", functionUrl("agent-worker"), {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({ action: "tool_submitted", runId, leaseId: firstLeaseId, callId: fixtureCallId }),
  });
  const fixtureMetadata = {
    runId,
    leaseId: firstLeaseId,
    sourceCallId: fixtureCallId,
    role: "stage_result",
    stepId: "fixture",
    mime: "image/png",
    bytes: fixtureBytes.byteLength,
    sha256: sha(fixtureBytes),
    userVisible: false,
  };
  const fixtureUpload = await jsonRequest("准备图片 fixture", functionUrl("agent-worker"), {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({ action: "artifact_prepare", ...fixtureMetadata }),
  });
  const uploadedFixture = await fetch(reachableLocalUrl(fixtureUpload.uploadUrl), {
    method: "PUT",
    headers: {
      ...(fixtureUpload.uploadToken ? { authorization: `Bearer ${fixtureUpload.uploadToken}` } : {}),
      "content-type": "image/png",
      "x-upsert": "true",
    },
    body: fixtureBytes,
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(uploadedFixture.ok, true, `fixture upload failed: ${uploadedFixture.status}`);
  const fixtureArtifact = await jsonRequest("登记图片 fixture", functionUrl("agent-worker"), {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({ action: "artifact", ...fixtureMetadata }),
  });
  assert.equal(fixtureArtifact.width, 1, "Edge 必须从 PNG 字节提取宽度");
  assert.equal(fixtureArtifact.height, 1, "Edge 必须从 PNG 字节提取高度");

  const plan = {
    schemaVersion: 1,
    title: "本地统一审批 E2E",
    summary: "只验证停车、幂等与恢复，不调用模型或副作用工具。",
    steps: [{
      id: "finalize",
      kind: "finalize_output",
      goal: "结束本地验证",
      inputAssetIds: [fixtureArtifact.artifactId],
      dependsOn: [],
    }],
  };
  const callId = sha(`unified-agent-plan:${runId}:submit_plan:0`);
  const proposalHash = sha(canonicalJson(plan));
  const argsHash = sha(canonicalJson({ plan }));
  const approvalRequest = {
    action: "approval_request",
    runId,
    leaseId: firstLeaseId,
    kind: "unified_agent_plan",
    callId,
    argsHash,
    proposalHash,
    proposal: plan,
  };

  const parked = await jsonRequest("提交统一计划并停车", functionUrl("agent-worker"), {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify(approvalRequest),
  });
  assert.equal(parked.status, "awaiting_approval");
  assert.equal(parked.reused, false);
  assert.equal(parked.estimatedAdditionalCredits, 2, "最小计划应由服务端按两次模型回合估算 2 分");
  assert.equal(parked.estimateBreakdown?.policyVersion, 1);

  const parkedRows = await jsonRequest(
    "读取停车 Run",
    `${baseUrl}/rest/v1/agent_runs?id=eq.${encodeURIComponent(runId)}&select=status,lease_id,lease_expires_at,checkpoint_hash`,
    { method: "GET", headers: adminHeaders },
  );
  assert.equal(parkedRows.length, 1);
  assert.equal(parkedRows[0].status, "awaiting_approval");
  assert.equal(parkedRows[0].lease_id, null, "停车必须释放 Worker 租约");
  assert.equal(parkedRows[0].lease_expires_at, null, "停车必须清空租约到期时间");
  assert.equal(parkedRows[0].checkpoint_hash, checkpointHash, "停车不得丢失 checkpoint 指针");

  const approvalRows = await jsonRequest(
    "读取统一审批",
    `${baseUrl}/rest/v1/agent_approvals?id=eq.${encodeURIComponent(parked.approvalId)}&select=status,kind,source_call_id,args_hash,proposal_hash,cost_policy_version,estimated_additional_credits`,
    { method: "GET", headers: adminHeaders },
  );
  assert.equal(approvalRows.length, 1);
  assert.deepEqual(approvalRows[0], {
    status: "pending",
    kind: "unified_agent_plan",
    source_call_id: callId,
    args_hash: argsHash,
    proposal_hash: proposalHash,
    cost_policy_version: 1,
    estimated_additional_credits: 2,
  });

  const replayed = await jsonRequest("响应丢失后的同调用重放", functionUrl("agent-worker"), {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify(approvalRequest),
  });
  assert.equal(replayed.approvalId, parked.approvalId);
  assert.equal(replayed.reused, true);
  assert.equal(replayed.status, "awaiting_approval");

  const driftedPlan = { ...plan, title: "同 callId 的漂移计划" };
  const drift = await requestWithStatus(functionUrl("agent-worker"), {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({
      ...approvalRequest,
      argsHash: sha(canonicalJson({ plan: driftedPlan })),
      proposalHash: sha(canonicalJson(driftedPlan)),
      proposal: driftedPlan,
    }),
  });
  assert.equal(drift.status, 409, "同 callId 参数漂移必须返回 409");
  assert.equal(drift.body?.error?.code, "invalid_request");
  assert.match(drift.body?.error?.message ?? "", /参数发生漂移/);

  await jsonRequest("用户批准计划", functionUrl("agent-run"), {
    method: "POST",
    headers: owner.headers,
    body: JSON.stringify({ action: "approve", approvalId: parked.approvalId }),
  });

  const endedReplay = await requestWithStatus(functionUrl("agent-worker"), {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify(approvalRequest),
  });
  assert.equal(endedReplay.status, 409, "已批准调用不得重新停车");
  assert.match(endedReplay.body?.error?.message ?? "", /已经结束/);

  const secondClaim = await jsonRequest("批准后重新认领", functionUrl("agent-worker"), {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({ action: "claim" }),
  });
  assert.equal(secondClaim.run?.id, runId);
  assert.equal(secondClaim.run?.approvedPlanHash, proposalHash, "fresh-session 必须收到批准 hash");
  assert.equal(secondClaim.run?.plannedToolCount, 1);
  assert.equal(secondClaim.run?.checkpointHash, checkpointHash, "fresh-session 必须收到原 checkpoint");
  assert.ok(secondClaim.checkpointUrl, "fresh-session 必须能下载 checkpoint");
  assert.notEqual(secondClaim.lease?.leaseId, firstLeaseId, "批准后必须签发新租约");
  const reclaimedFixture = secondClaim.artifactUrls?.find((artifact) => artifact.artifactId === fixtureArtifact.artifactId);
  assert.equal(reclaimedFixture?.width, 1, "fresh-session claim 必须携带可信图片宽度");
  assert.equal(reclaimedFixture?.height, 1, "fresh-session claim 必须携带可信图片高度");

  await jsonRequest("清理测试 Run", functionUrl("agent-worker"), {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({ action: "cancel", runId, leaseId: secondClaim.lease.leaseId }),
  });

  console.log("UNIFIED_AGENT_APPROVAL_LOCAL_OK");
  console.log("parked=1 lease_released=1 replayed=1 drift_rejected=1 approved=1 reclaimed=1 asset_dimensions=1");
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
      // Local fixture cleanup is best-effort.
    }
  }
}

if (testError) process.exit(1);
