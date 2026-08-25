// Production control-plane concurrency probe. Creates one test Run, exposes it
// to two Worker claim requests at the same instant, and requires exactly one
// lease winner. No model, image, storage upload, or user content is involved.

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

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
const functionUrl = (name) => `${baseUrl}/functions/v1/${name}`;
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

async function unclaimedQueue() {
  return await request("检查空队列", `${baseUrl}/rest/v1/agent_runs?status=eq.queued&cancel_requested_at=is.null&select=id,is_test`, {
    method: "GET",
    headers: adminHeaders,
  });
}

let userId;
let runId;
let winningLease;
let testError;
try {
  const before = await unclaimedQueue();
  assert.equal(before.length, 0, "refuse to run while any claimable Run already exists");

  const email = `agent-claim-${Date.now()}-${randomBytes(4).toString("hex")}@example.test`;
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
  const manifest = JSON.stringify({ schemaVersion: 1, intentPrompt: "concurrent claim fixture", references: [] });
  const created = await request("创建测试 Run", functionUrl("agent-run"), {
    method: "POST",
    headers: userHeaders,
    body: JSON.stringify({
      action: "create",
      skillId: "bowerbird-controlled-image-edit",
      goal: "concurrent claim fixture",
      inputCount: 0,
      inputManifestHash: sha256(manifest),
      idempotencyKey: `claim-${randomBytes(8).toString("hex")}`,
    }),
  });
  runId = created.runId;
  await request("停车测试 Run", `${baseUrl}/rest/v1/agent_runs?id=eq.${encodeURIComponent(runId)}`, {
    method: "PATCH",
    headers: { ...adminHeaders, prefer: "return=minimal" },
    body: JSON.stringify({
      status: "queued",
      queued_at: new Date().toISOString(),
      cancel_requested_at: new Date().toISOString(),
    }),
  }, [204]);
  assert.equal((await unclaimedQueue()).length, 0);

  await request("开放测试 Run", `${baseUrl}/rest/v1/agent_runs?id=eq.${encodeURIComponent(runId)}`, {
    method: "PATCH",
    headers: { ...adminHeaders, prefer: "return=minimal" },
    body: JSON.stringify({ cancel_requested_at: null }),
  }, [204]);
  const claim = (workerId) => request(`并发 claim ${workerId}`, functionUrl("agent-worker"), {
    method: "POST",
    headers: {
      authorization: `Bearer ${workerToken}`,
      "x-worker-id": workerId,
      "content-type": "application/json",
    },
    body: JSON.stringify({ action: "claim" }),
  });
  const [left, right] = await Promise.all([
    claim(`claim-probe-a-${Date.now()}`),
    claim(`claim-probe-b-${Date.now()}`),
  ]);
  const winners = [left, right].filter((result) => result?.run?.id === runId);
  const empty = [left, right].filter((result) => result?.run === null);
  assert.ok(winners.length <= 1, "the two probe Workers must not both receive the Run");
  assert.equal(empty.length, 2 - winners.length, "every non-winner must receive an empty claim");
  winningLease = winners[0]?.lease?.leaseId;
  if (winners.length) assert.ok(winningLease, "winner must receive a lease id");

  const row = await request("核对唯一租约", `${baseUrl}/rest/v1/agent_runs?id=eq.${encodeURIComponent(runId)}&select=status,lease_id,lease_owner,attempt_count`, {
    method: "GET",
    headers: adminHeaders,
  });
  assert.equal(row[0].attempt_count, 1);
  if (winningLease) {
    assert.equal(row[0].status, "leased");
    assert.equal(row[0].lease_id, winningLease);
  } else {
    // The always-on VPS is a third concurrent claimant. Both probes losing to
    // it is still valid evidence when the durable attempt counter remains 1.
    assert.notEqual(row[0].status, "queued");
  }

  console.log("AGENT_CONCURRENT_CLAIM_OK");
  console.log(`run=${runId} probe_winners=${winners.length} external_winner=${winners.length ? 0 : 1} attempts=1`);
} catch (error) {
  testError = error;
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
} finally {
  if (runId && winningLease) {
    try {
      await fetch(functionUrl("agent-worker"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${workerToken}`,
          "x-worker-id": "claim-probe-cleanup",
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "cancel", runId, leaseId: winningLease }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch { /* best effort */ }
  } else if (runId) {
    try {
      await fetch(`${baseUrl}/rest/v1/agent_runs?id=eq.${encodeURIComponent(runId)}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ cancel_requested_at: new Date().toISOString() }),
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
