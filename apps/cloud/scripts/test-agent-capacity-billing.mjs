// A5-T5/T6 production smoke test. It does not enqueue work or call providers:
// concurrent create → guarded idempotency/capacity → cancel → ledger marker.
// Run: node --env-file=.env scripts/test-agent-capacity-billing.mjs

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

const baseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();
const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
if (!baseUrl || !publishableKey || !secretKey) {
  console.error("缺少 SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY");
  process.exit(2);
}

const adminHeaders = {
  apikey: secretKey,
  authorization: `Bearer ${secretKey}`,
  "content-type": "application/json",
};
const functionUrl = (name) => `${baseUrl}/functions/v1/${name}`;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function request(url, init, expected = [200]) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!expected.includes(response.status)) {
    throw new Error(`HTTP ${response.status}: ${body?.error?.code ?? "unknown"} / ${body?.error?.message ?? text}`);
  }
  return { status: response.status, body };
}

async function createAccount() {
  const email = `agent-capacity-${Date.now()}-${randomBytes(4).toString("hex")}@example.test`;
  const password = `${randomBytes(16).toString("hex")}Aa1!`;
  const { body: created } = await request(`${baseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ email, password, email_confirm: true, app_metadata: { bowerbird_test: true } }),
  }, [200, 201]);
  const { body: session } = await request(`${baseUrl}/auth/v1/token?grant_type=password`, {
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

const manifest = JSON.stringify({
  schemaVersion: 1,
  intentPrompt: "A5 容量与账单冒烟测试",
  references: [],
  ratio: "1:1",
});

function createInit(headers, idempotencyKey) {
  return {
    method: "POST",
    headers,
    body: JSON.stringify({
      action: "create",
      skillId: "bowerbird-controlled-image-edit",
      goal: "A5 容量与账单冒烟测试",
      inputCount: 0,
      inputManifestHash: sha256(manifest),
      idempotencyKey,
    }),
  };
}

async function cancel(headers, runId) {
  const { body } = await request(functionUrl("agent-run"), {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "cancel", runId }),
  });
  assert.equal(body.status, "cancelled");
}

let account;
let testError;
try {
  account = await createAccount();

  // Same hold: both callers must converge on the database winner and receive
  // usable IDs rather than the losing caller's transient UUID/object key.
  const replayKey = `agent-same-${randomBytes(8).toString("hex")}`;
  const same = await Promise.all([
    request(functionUrl("agent-run"), createInit(account.headers, replayKey)),
    request(functionUrl("agent-run"), createInit(account.headers, replayKey)),
  ]);
  assert.equal(same[0].body.runId, same[1].body.runId, "同 hold 并发创建必须收敛到一个 Run");
  assert.equal(same[0].body.conversationId, same[1].body.conversationId, "同 hold 并发创建必须收敛到一个会话");
  assert.equal(same[0].body.holdId, same[1].body.holdId, "同幂等键不得重复 hold");
  await cancel(account.headers, same[0].body.runId);

  // Distinct holds: Free policy allows one active Agent Run, so the guarded
  // transaction must accept exactly one request and release the loser hold.
  const capacityKeys = [
    `agent-distinct-${randomBytes(8).toString("hex")}`,
    `agent-distinct-${randomBytes(8).toString("hex")}`,
  ];
  const distinct = await Promise.all(capacityKeys.map((key) =>
    request(functionUrl("agent-run"), createInit(account.headers, key), [200, 429])));
  assert.deepEqual(distinct.map((item) => item.status).sort((a, b) => a - b), [200, 429]);
  const winner = distinct.find((item) => item.status === 200)?.body;
  const loser = distinct.find((item) => item.status === 429)?.body;
  assert.ok(winner?.runId);
  assert.equal(loser?.error?.code, "rate_limited");
  await cancel(account.headers, winner.runId);

  for (const key of [replayKey, ...capacityKeys]) {
    const { body: holds } = await request(
      `${baseUrl}/rest/v1/credit_holds?idempotency_key=eq.${encodeURIComponent(key)}&select=id,status`,
      { method: "GET", headers: adminHeaders },
    );
    assert.equal(holds.length, 1, `幂等键 ${key} 应只有一个 hold`);
    assert.equal(holds[0].status, "rolled_back", `幂等键 ${key} 的 hold 应已释放`);
  }

  const winnerRuns = [same[0].body.runId, winner.runId];
  for (const runId of winnerRuns) {
    const { body: runs } = await request(
      `${baseUrl}/rest/v1/agent_runs?id=eq.${encodeURIComponent(runId)}&select=hold_id,status,actual_credits`,
      { method: "GET", headers: adminHeaders },
    );
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "cancelled");
    assert.equal(runs[0].actual_credits, 0);
    const { body: markers } = await request(
      `${baseUrl}/rest/v1/credit_transactions?hold_id=eq.${encodeURIComponent(runs[0].hold_id)}&kind=eq.adjust&select=amount,meta`,
      { method: "GET", headers: adminHeaders },
    );
    assert.equal(markers.length, 1, "每个终态 Run 必须恰有一个账单标记");
    assert.equal(markers[0].amount, 0);
    assert.deepEqual(
      Object.keys(markers[0].meta).sort(),
      ["actual_credits", "entity_type", "final_status", "image_provider", "pricing_version", "run_id", "skill_id", "skill_version"].sort(),
    );
    assert.equal(markers[0].meta.run_id, runId);
  }

  const { body: entitlement } = await request(functionUrl("entitlement"), {
    method: "GET",
    headers: account.headers,
  });
  const exposed = entitlement.recent_transactions.filter((tx) =>
    tx.meta?.entity_type === "agent_run" && winnerRuns.includes(tx.meta.run_id));
  assert.equal(exposed.length, 2, "权益账单应暴露两个已取消 Agent Run 标记");
  for (const tx of exposed) {
    assert.deepEqual(
      Object.keys(tx.meta).sort(),
      ["actual_credits", "entity_type", "final_status", "run_id", "skill_id"].sort(),
      "客户端账单只下发最小技术字段",
    );
  }

  console.log("AGENT_CAPACITY_BILLING_OK");
  console.log(`same_hold_run=${same[0].body.runId} capacity_run=${winner.runId} holds_released=3 markers=2`);
} catch (error) {
  testError = error;
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
} finally {
  if (account?.userId) {
    try {
      await fetch(`${baseUrl}/auth/v1/admin/users/${account.userId}`, {
        method: "DELETE",
        headers: adminHeaders,
        signal: AbortSignal.timeout(30_000),
      });
    } catch { /* cleanup is best-effort */ }
  }
}

if (testError) process.exit(1);
