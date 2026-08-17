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
if (!["basic", "long", "unknown", "guard", "crash-create", "crash-check"].includes(scenario)) {
  console.error("用法：node scripts/test-generation-e2e.mjs basic|long|unknown|guard|crash-create|crash-check <job_id>");
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
    body: JSON.stringify({ media: "image", service: "image_lite", ...body }),
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
  if (scenario === "crash-create") {
    // Orchestration phase 1: create one job and exit, leaving the account alive.
    // The operator then kills the VPS worker mid-generation and restarts it.
    account = await createAccount();
    const created = await createJob(account.headers, {
      idempotency_key: `gen-e2e-crash-${crypto.randomUUID()}`,
      ratio: "1:1",
      prompt: "一张极简的静物摄影：一只素色陶瓷杯。",
      reference_images: [],
    });
    console.log(`CRASH_JOB_ID=${created.job_id}`);
    console.log(`CRASH_USER_ID=${account.userId}`);
    process.exit(0);
  } else if (scenario === "crash-check") {
    // Orchestration phase 2 (admin REST, no user JWT): after lease expiry +
    // reconcile, the job must be frozen as outcome_unknown with the hold left
    // pending settlement — proving the crash path never re-submits to Ark.
    const jobId = process.argv[3];
    assert.ok(/^[0-9a-f-]{36}$/.test(jobId ?? ""), "缺少 job_id 参数");
    const rows = await jsonRequest("读取崩溃任务", `${baseUrl}/rest/v1/generation_jobs?id=eq.${jobId}&select=*`, {
      method: "GET",
      headers: adminHeaders,
    });
    const job = rows[0];
    assert.ok(job, "任务不存在");
    assert.equal(job.status, "outcome_unknown", `崩溃恢复应为 outcome_unknown，实际 ${job.status}`);
    assert.equal(job.error_code, "worker_lost_after_submit", `error_code 应为 worker_lost_after_submit，实际 ${job.error_code}`);
    const holdRows = await jsonRequest("读取挂起 hold", `${baseUrl}/rest/v1/credit_holds?id=eq.${job.hold_id}&select=status`, {
      method: "GET",
      headers: adminHeaders,
    });
    assert.ok(holdRows[0]?.status.startsWith("pending"), `hold 应为 pending settlement，实际 ${holdRows[0]?.status}`);
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
    if (job.user_id) {
      // generation_jobs row (restrict FK) already deleted above; billing_accounts cascades from the auth user.
      await jsonRequest("删除临时账号", `${baseUrl}/auth/v1/admin/users/${job.user_id}`, {
        method: "DELETE",
        headers: adminHeaders,
      }, [200, 204]);
    }
    console.log(`场景CR（Worker 提交后崩溃→租约过期→reconcile 冻结）通过：job=${jobId} hold=${holdRows[0].status}`);
    process.exit(0);
  }

  account = await createAccount();

  if (scenario === "guard") {
    // --- Scenario G: idempotent replay + cross-account IDOR ---
    const idempotencyKey = `gen-e2e-g-${crypto.randomUUID()}`;
    const payload = {
      idempotency_key: idempotencyKey,
      ratio: "1:1",
      prompt: "一张极简的静物摄影：一只素色陶瓷杯。",
      reference_images: [],
    };
    const created = await createJob(account.headers, payload);
    jobIds.push(created.job_id);

    // Same idempotency key + identical payload must return the SAME job, not a second one.
    const replayed = await createJob(account.headers, payload);
    assert.equal(replayed.job_id, created.job_id, "幂等重放应返回同一 job_id");
    assert.equal(replayed.charge.transaction_id, created.charge.transaction_id, "幂等重放不应二次 hold");

    const { job } = await pollJob(account.headers, created.job_id);
    assert.equal(job.status, "succeeded", `guard 基线任务未成功：${job.error?.code}`);

    // Cross-account access must 404 without leaking existence.
    const stranger = await createAccount();
    try {
      const stolen = await jsonRequest("越权查询", functionUrl("generate-proxy"), {
        method: "POST",
        headers: stranger.headers,
        body: JSON.stringify({ action: "get", job_id: created.job_id }),
      }, [404]);
      assert.equal(stolen?.error?.code, "invalid_request");
      const cancelled = await jsonRequest("越权取消", functionUrl("generate-proxy"), {
        method: "POST",
        headers: stranger.headers,
        body: JSON.stringify({ action: "cancel", job_id: created.job_id }),
      }, [404]);
      assert.equal(cancelled?.error?.code, "invalid_request");
    } finally {
      await jsonRequest("删除陌生账号", `${baseUrl}/auth/v1/admin/users/${stranger.userId}`, {
        method: "DELETE",
        headers: adminHeaders,
      }, [200, 204]);
    }
    console.log(`场景G（幂等重放返回同任务 + 越权 get/cancel 均 404）通过：job=${created.job_id}`);

    // Lite 档（image_lite）：创建即按 1 分预授权，随后取消。
    const lite = await createJob(account.headers, {
      idempotency_key: `gen-e2e-lite-${crypto.randomUUID()}`,
      ratio: "1:1",
      prompt: "一张极简的静物摄影。",
      reference_images: [],
      service: "image_lite",
    });
    jobIds.push(lite.job_id);
    assert.equal(lite.charge.estimated, 1, "image_lite 档应按 1 分预授权");
    const cancelledLite = await jsonRequest("取消 lite 任务", functionUrl("generate-proxy"), {
      method: "POST",
      headers: account.headers,
      body: JSON.stringify({ action: "cancel", job_id: lite.job_id }),
    });
    assert.ok(
      ["cancelled", "cancel_requested", "failed"].includes(cancelledLite.status),
      `lite 取消后状态异常：${cancelledLite.status}`,
    );
    console.log(`场景G 补充（image_lite 档创建+取消）通过：job=${lite.job_id}`);
  } else if (scenario === "basic") {
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
    assert.equal(job.charge.estimated, 1);
    assert.equal(job.charge.actual, 1);
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
    assert.equal(after.balances.daily, 29, "真实出图后应从 30 分扣至 29 分");
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
    assert.equal(afterB.balances.daily, 29, "失败任务应回滚积分（保持 29）");
    console.log(`场景B（失败注入→回滚）通过：job=${failing.job_id} error=${failed.job.error.code} 积分保持 29`);
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
    assert.equal(job.charge.actual, 1);
    assert.ok(job.artifact?.bytes > 0 && /^[0-9a-f]{64}$/.test(job.artifact.sha256));
    const after = await entitlement(account.headers);
    assert.equal(after.balances.daily, 29, "长任务成功后应从 30 分扣至 29 分");
    console.log(`场景L（200s挂起上游→无超时+心跳续租→成功）通过：job=${created.job_id} 耗时=${(elapsedMs / 1000).toFixed(1)}s 积分 30→29`);
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
    assert.equal(after.balances.daily, 29, "outcome_unknown 应保持挂起扣留（30-1=29），不确认也不回滚");
    console.log(`场景C（outcome_unknown 注入）通过：job=${created.job_id} 耗时=${(elapsedMs / 1000).toFixed(1)}s 积分挂起 29`);
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
