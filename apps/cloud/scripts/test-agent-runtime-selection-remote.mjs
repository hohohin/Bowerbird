// U4 remote control-plane smoke. It never runs a processor or calls a provider:
// the always-on VPS Worker must be stopped before this script claims and cancels
// its synthetic DSH Run directly through the Worker Edge endpoint.

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

const CLI_FLAG = "--allow-remote-control-plane-smoke";
if (!process.argv.includes(CLI_FLAG) || process.env.BOWERBIRD_U4_ALLOW_REMOTE_CONTROL_PLANE_SMOKE !== "1") {
  console.error(`需要 ${CLI_FLAG} 与 BOWERBIRD_U4_ALLOW_REMOTE_CONTROL_PLANE_SMOKE=1`);
  process.exit(2);
}

function namedKey(directName, objectName, legacyName) {
  const direct = process.env[directName]?.trim();
  if (direct) return direct;
  const objectValue = process.env[objectName]?.trim();
  if (objectValue) return JSON.parse(objectValue).default?.trim();
  return process.env[legacyName]?.trim();
}

const baseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
const publishableKey = namedKey("SUPABASE_PUBLISHABLE_KEY", "SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY");
const secretKey = namedKey("SUPABASE_SECRET_KEY", "SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY");
const workerToken = process.env.AGENT_WORKER_TOKEN?.trim();
if (!baseUrl || !publishableKey || !secretKey || !workerToken) {
  console.error("缺少远端 Supabase 或 Agent Worker 凭据");
  process.exit(2);
}
const parsedBaseUrl = new URL(baseUrl);
if (parsedBaseUrl.protocol !== "https:" || ["127.0.0.1", "localhost"].includes(parsedBaseUrl.hostname)) {
  console.error("本脚本只允许连接远端 HTTPS Supabase");
  process.exit(2);
}

const adminHeaders = {
  apikey: secretKey,
  authorization: `Bearer ${secretKey}`,
  "content-type": "application/json",
};
const workerHeaders = {
  authorization: `Bearer ${workerToken}`,
  "x-worker-id": "u4-runtime-selection-smoke",
  "content-type": "application/json",
};
const accounts = [];
let runId;
let ownerHeaders;
let leaseId;
let testError;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const functionUrl = (name) => `${baseUrl}/functions/v1/${name}`;

async function request(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: response.status, body };
}

async function jsonRequest(label, url, init, expected = [200]) {
  const result = await request(url, init);
  if (!expected.includes(result.status)) {
    throw new Error(`${label} failed: HTTP ${result.status} / ${result.body?.error?.code ?? "unknown"}`);
  }
  return result.body;
}

async function createAccount(isTest) {
  const email = `u4-runtime-${Date.now()}-${randomBytes(5).toString("hex")}@example.test`;
  const password = `${randomBytes(18).toString("hex")}Aa1!`;
  const created = await jsonRequest("create account", `${baseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      ...(isTest ? { app_metadata: { bowerbird_test: true } } : {}),
    }),
  });
  accounts.push(created.id);
  const session = await jsonRequest("login account", `${baseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: publishableKey, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return {
    apikey: publishableKey,
    authorization: `Bearer ${session.access_token}`,
    "content-type": "application/json",
  };
}

function createBody(idempotencyKey, runtime) {
  const manifest = JSON.stringify({ schemaVersion: 1, intentPrompt: "U4 runtime selection smoke", references: [] });
  return {
    manifest,
    body: {
      action: "create",
      skillId: "bowerbird-controlled-image-edit",
      goal: "U4 test-only runtime selection smoke",
      inputCount: 0,
      inputManifestHash: sha256(manifest),
      agentRuntime: runtime,
      idempotencyKey,
    },
  };
}

try {
  const ordinaryHeaders = await createAccount(false);
  const denied = createBody(`u4-ordinary-${randomBytes(8).toString("hex")}`, "dsh");
  const ordinaryResult = await request(functionUrl("agent-run"), {
    method: "POST",
    headers: ordinaryHeaders,
    body: JSON.stringify(denied.body),
  });
  assert.equal(ordinaryResult.status, 403, "ordinary account must not select DSH");

  ownerHeaders = await createAccount(true);
  const idempotencyKey = `u4-test-${randomBytes(8).toString("hex")}`;
  const selected = createBody(idempotencyKey, "dsh");
  const created = await jsonRequest("create DSH run", functionUrl("agent-run"), {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify(selected.body),
  });
  runId = created.runId;
  assert.equal(created.agentRuntime, "dsh");

  const drifted = createBody(idempotencyKey, "legacy_kernel");
  const driftResult = await request(functionUrl("agent-run"), {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify(drifted.body),
  });
  assert.equal(driftResult.status, 409, "idempotency replay must not change runtime");

  const upload = await fetch(created.uploadUrl, {
    method: "PUT",
    headers: {
      ...(created.uploadToken ? { authorization: `Bearer ${created.uploadToken}` } : {}),
      "content-type": "application/json",
      "x-upsert": "true",
    },
    body: selected.manifest,
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(upload.ok, true, `request upload failed: ${upload.status}`);
  await jsonRequest("enqueue DSH run", functionUrl("agent-run"), {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({ action: "enqueue", runId }),
  });

  const snapshot = await jsonRequest("get DSH run", functionUrl("agent-run"), {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({ action: "get", runId }),
  });
  assert.equal(snapshot.run?.agent_runtime, "dsh");

  const claim = await jsonRequest("claim DSH run", functionUrl("agent-worker"), {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({ action: "claim" }),
  });
  assert.equal(claim.run?.id, runId, "smoke must be the only claimable Agent Run");
  assert.equal(claim.run?.agentRuntime, "dsh");
  leaseId = claim.lease?.leaseId;
  assert.ok(leaseId);
  await jsonRequest("cancel DSH run", functionUrl("agent-worker"), {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({ action: "cancel", runId, leaseId }),
  });
  leaseId = undefined;

  const cancelled = await jsonRequest("get cancelled DSH run", functionUrl("agent-run"), {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({ action: "get", runId }),
  });
  assert.equal(cancelled.run?.status, "cancelled");
  assert.equal(cancelled.run?.agent_runtime, "dsh");

  console.log("AGENT_RUNTIME_SELECTION_REMOTE_OK");
  console.log("ordinary_denied=1 dsh_created=1 drift_rejected=1 runtime_get_bound=1 runtime_claim_bound=1 cancelled_without_processor=1 provider_calls=0");
} catch (error) {
  testError = error;
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
} finally {
  if (runId && ownerHeaders) {
    try {
      if (leaseId) {
        await request(functionUrl("agent-worker"), {
          method: "POST",
          headers: workerHeaders,
          body: JSON.stringify({ action: "cancel", runId, leaseId }),
        });
      } else {
        await request(functionUrl("agent-run"), {
          method: "POST",
          headers: ownerHeaders,
          body: JSON.stringify({ action: "cancel", runId }),
        });
      }
    } catch {
      // Best-effort cleanup continues with account deletion.
    }
  }
  for (const userId of accounts) {
    try {
      await fetch(`${baseUrl}/auth/v1/admin/users/${userId}`, {
        method: "DELETE",
        headers: adminHeaders,
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      // Best-effort cleanup; the script never logs credentials or user content.
    }
  }
}

if (testError) process.exit(1);
