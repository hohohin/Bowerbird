// G0 VPS Worker real E2E for the durable generation-job pipeline.
// Usage:
//   node scripts/test-generation-e2e.mjs basic    // scenario A (multi-reference real Ark) + B (corrupt reference -> failed/rollback)
//   node scripts/test-generation-e2e.mjs unknown  // scenario C (requires VPS ARK_BASE_URL pointed at an unreachable host)
// Reads apps/cloud/.env itself because inline `# comment` suffixes break `node --env-file`.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

const env = parseEnv(await readFile(new URL("../.env", import.meta.url), "utf8"));
const baseUrl = env.SUPABASE_URL?.replace(/\/$/, "");
const publishableKey = env.SUPABASE_PUBLISHABLE_KEY;
const secretKey = env.SUPABASE_SECRET_KEY;
if (!baseUrl || !publishableKey || !secretKey) {
  console.error("缺少 SUPABASE_URL、publishable key 或 secret key");
  process.exit(2);
}
const scenario = process.argv[2] ?? "basic";
if (!["basic", "long", "unknown"].includes(scenario)) {
  console.error("用法：node scripts/test-generation-e2e.mjs basic|long|unknown");
  process.exit(2);
}

const adminHeaders = {
  apikey: secretKey,
  authorization: `Bearer ${secretKey}`,
  "content-type": "application/json",
};

function safeError(label, response, body) {
  const code = body?.error?.code ?? body?.code ?? "unknown";
  const message = body?.error?.message ?? body?.message ?? "无错误详情";
  return new Error(`${label}失败（HTTP ${response.status}, ${code}）：${message}`);
}

async function jsonRequest(label, url, init, expectedStatuses = [200, 202]) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!expectedStatuses.includes(response.status)) throw safeError(label, response, body);
  return body;
}

function functionUrl(name) {
  return `${baseUrl}/functions/v1/${name}`;
}

async function createAccount() {
  const email = `gen-e2e-${Date.now()}-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const password = `${crypto.randomUUID()}Aa1!`;
  const created = await jsonRequest("创建临时账号", `${baseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ email, password, email_confirm: true }),
  }, [200, 201]);
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

async function entitlement(userHeaders) {
  return await jsonRequest("读取权益", functionUrl("entitlement"), {
    method: "GET",
    headers: userHeaders,
  });
}

async function createJob(userHeaders, body) {
  return await jsonRequest("创建云生成任务", functionUrl("generate-proxy"), {
    method: "POST",
    headers: userHeaders,
    body: JSON.stringify({ media: "image", service: "image_sd", ...body }),
  }, [202]);
}

const ACTIVE = ["uploading", "queued", "leased", "running", "cancel_requested"];

async function pollJob(userHeaders, jobId, { maxWaitMs = 6 * 60_000, intervalMs = 3_000 } = {}) {
  const startedAt = Date.now();
  for (;;) {
    const job = await jsonRequest("查询云生成任务", functionUrl("generate-proxy"), {
      method: "POST",
      headers: userHeaders,
      body: JSON.stringify({ action: "get", job_id: jobId }),
    }, [200, 202]);
    if (!ACTIVE.includes(job.status)) return { job, elapsedMs: Date.now() - startedAt };
    if (Date.now() - startedAt > maxWaitMs) {
      throw new Error(`任务 ${jobId} 在 ${maxWaitMs / 1000}s 内未到终态（最后状态 ${job.status}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function cleanup(userId, jobIds) {
  for (const jobId of jobIds ?? []) {
    try {
      await fetch(`${baseUrl}/storage/v1/object/generation-temp`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ prefixes: [`jobs/${jobId}/`] }),
        signal: AbortSignal.timeout(30_000),
      });
      await fetch(`${baseUrl}/rest/v1/generation_jobs?id=eq.${jobId}`, {
        method: "DELETE",
        headers: adminHeaders,
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      // account deletion below is the hard requirement; leftovers hit TTL cleanup later
    }
  }
  if (userId) {
    await jsonRequest("删除临时账号", `${baseUrl}/auth/v1/admin/users/${userId}`, {
      method: "DELETE",
      headers: adminHeaders,
    }, [200, 204]);
    console.log("临时账号已清理");
  }
}

let account;
let testError;
const jobIds = [];

try {
  account = await createAccount();

  if (scenario === "basic") {
    // --- Scenario A: multi-reference real Ark generation on the VPS worker ---
    const before = await entitlement(account.headers);
    assert.equal(before.balances.daily, 30, "新账号应获得 30 每日积分");

    const refs = [];
    for (const name of ["p1.jpg", "p2.jpg"]) {
      const bytes = await readFile(new URL(`../../../website/assets/presets/${name}`, import.meta.url));
      refs.push({ mime: "image/jpeg", base64: bytes.toString("base64") });
    }
    const created = await createJob(account.headers, {
      idempotency_key: `gen-e2e-a-${crypto.randomUUID()}`,
      ratio: "1:1",
      prompt: "参考两张图的构图与色彩气质，生成一张极简的静物摄影：一只素色陶瓷杯放在浅木桌上，柔和自然光，大面积留白。",
      reference_images: refs,
    });
    jobIds.push(created.job_id);
    assert.ok(ACTIVE.includes(created.status) || created.status === "succeeded", `创建后状态异常：${created.status}`);

    const { job, elapsedMs } = await pollJob(account.headers, created.job_id, { maxWaitMs: 8 * 60_000 });
    assert.equal(job.status, "succeeded", `场景A未成功：${job.error?.code} ${job.error?.message}`);
    assert.equal(job.progress, 100);
    assert.equal(job.charge.estimated, 5);
    assert.equal(job.charge.actual, 5);
    assert.ok(job.artifact?.url && job.artifact.bytes > 1_024 && /^[0-9a-f]{64}$/.test(job.artifact.sha256));

    const artifactResponse = await fetch(job.artifact.url, { signal: AbortSignal.timeout(60_000) });
    assert.ok(artifactResponse.ok, `产物下载 HTTP ${artifactResponse.status}`);
    const artifactBytes = new Uint8Array(await artifactResponse.arrayBuffer());
    const artifactSha = createHash("sha256").update(artifactBytes).digest("hex");
    assert.equal(artifactSha, job.artifact.sha256, "产物 SHA-256 与控制面记录不一致");
    assert.equal(artifactBytes.byteLength, job.artifact.bytes, "产物字节数与控制面记录不一致");

    const received = await jsonRequest("确认产物接收", functionUrl("generate-proxy"), {
      method: "POST",
      headers: account.headers,
      body: JSON.stringify({ action: "artifact_received", job_id: created.job_id }),
    });
    assert.equal(received.status, "received");

    const after = await entitlement(account.headers);
    assert.equal(after.balances.daily, 25, "真实出图后应从 30 分扣至 25 分");
    console.log(`场景A（多参考图真实出图）通过：job=${created.job_id} 耗时=${(elapsedMs / 1000).toFixed(1)}s ` +
      `产物=${artifactBytes.byteLength}B 心跳续租${elapsedMs > 90_000 ? "已跨过90s初始租约（>150s等待机制成立）" : "未跨过90s初始租约"}`);

    // --- Scenario B: corrupt reference image -> Ark rejects -> failed + rollback ---
    const corrupt = Buffer.alloc(2_048);
    corrupt[0] = 0xff; corrupt[1] = 0xd8; corrupt[2] = 0xff; corrupt[3] = 0xe0;
    for (let i = 4; i < corrupt.length; i++) corrupt[i] = (i * 31) & 0xff;
    const failing = await createJob(account.headers, {
      idempotency_key: `gen-e2e-b-${crypto.randomUUID()}`,
      ratio: "1:1",
      prompt: "一张极简的静物摄影。",
      reference_images: [{ mime: "image/jpeg", base64: corrupt.toString("base64") }],
    });
    jobIds.push(failing.job_id);
    const failed = await pollJob(account.headers, failing.job_id);
    assert.equal(failed.job.status, "failed", `损坏参考图应失败，实际 ${failed.job.status}`);
    assert.ok(failed.job.error?.code, "失败任务缺少 error_code");
    const afterB = await entitlement(account.headers);
    assert.equal(afterB.balances.daily, 25, "失败任务应回滚积分（保持 25）");
    console.log(`场景B（失败注入→回滚）通过：job=${failing.job_id} error=${failed.job.error.code} 积分保持 25`);
  } else if (scenario === "long") {
    // --- Scenario L: upstream hangs 200s (fake Ark) -> no timeout, heartbeat renews lease, settles ---
    const before = await entitlement(account.headers);
    assert.equal(before.balances.daily, 30, "新账号应获得 30 每日积分");

    const created = await createJob(account.headers, {
      idempotency_key: `gen-e2e-l-${crypto.randomUUID()}`,
      ratio: "1:1",
      prompt: "一张极简的静物摄影：一只素色陶瓷杯。",
      reference_images: [],
    });
    jobIds.push(created.job_id);
    const { job, elapsedMs } = await pollJob(account.headers, created.job_id, { maxWaitMs: 6 * 60_000 });
    assert.equal(job.status, "succeeded", `长等待任务未成功：${job.error?.code} ${job.error?.message}`);
    assert.ok(elapsedMs > 150_000, `任务耗时 ${elapsedMs}ms，未超过 150s 无法证明无超时等待`);
    assert.equal(job.charge.actual, 5);
    assert.ok(job.artifact?.bytes > 0 && /^[0-9a-f]{64}$/.test(job.artifact.sha256));
    const after = await entitlement(account.headers);
    assert.equal(after.balances.daily, 25, "长任务成功后应从 30 分扣至 25 分");
    console.log(`场景L（200s挂起上游→无超时+心跳续租→成功）通过：job=${created.job_id} 耗时=${(elapsedMs / 1000).toFixed(1)}s 积分 30→25`);
  } else {
    // --- Scenario C: unreachable Ark -> submitted then network failure -> outcome_unknown ---
    const before = await entitlement(account.headers);
    assert.equal(before.balances.daily, 30, "新账号应获得 30 每日积分");

    const created = await createJob(account.headers, {
      idempotency_key: `gen-e2e-c-${crypto.randomUUID()}`,
      ratio: "1:1",
      prompt: "一张极简的静物摄影：一只素色陶瓷杯。",
      reference_images: [],
    });
    jobIds.push(created.job_id);
    const { job, elapsedMs } = await pollJob(account.headers, created.job_id, { maxWaitMs: 3 * 60_000 });
    assert.equal(job.status, "outcome_unknown", `断网注入应为 outcome_unknown，实际 ${job.status}`);
    assert.equal(job.error?.code, "network_error", `error_code 应为 network_error，实际 ${job.error?.code}`);
    const after = await entitlement(account.headers);
    assert.equal(after.balances.daily, 25, "outcome_unknown 应保持挂起扣留（30-5=25），不确认也不回滚");
    console.log(`场景C（outcome_unknown 注入）通过：job=${created.job_id} 耗时=${(elapsedMs / 1000).toFixed(1)}s 积分挂起 25`);
  }
} catch (error) {
  testError = error;
} finally {
  try {
    await cleanup(account?.userId, jobIds);
  } catch (cleanupError) {
    testError ??= cleanupError;
  }
}

if (testError) throw testError;
console.log("GENERATION_E2E_OK");
