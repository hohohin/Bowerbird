// Understand (caption) VPS Worker real E2E for the durable understand-job pipeline.
// Mirrors test-generation-e2e.mjs. Usage:
//   node scripts/test-understand-e2e.mjs basic    // scenario A (real Ark vision) + B (corrupt image -> failed/rollback/quota-undo)
//   node scripts/test-understand-e2e.mjs unknown  // scenario C (requires VPS ARK_BASE_URL pointed at an unreachable host)
// Reads apps/cloud/.env itself because inline `# comment` suffixes break `node --env-file`.

import assert from "node:assert/strict";
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
  console.error("用法：node scripts/test-understand-e2e.mjs basic|long|unknown|guard|crash-create|crash-check <job_id>");
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
  const email = `und-e2e-${Date.now()}-${crypto.randomUUID().slice(0, 8)}@example.test`;
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
  // 与桌面端 CloudUnderstandProvider 完全一致：显式 action:"create"。
  return await jsonRequest("创建云理解任务", functionUrl("understand-proxy"), {
    method: "POST",
    headers: userHeaders,
    body: JSON.stringify({ action: "create", operation: "caption", ...body }),
  });
}

const ACTIVE = ["uploading", "queued", "leased", "running", "cancel_requested"];

async function pollJob(userHeaders, jobId, { maxWaitMs = 4 * 60_000, intervalMs = 3_000 } = {}) {
  const startedAt = Date.now();
  for (;;) {
    const job = await jsonRequest("查询云理解任务", functionUrl("understand-proxy"), {
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

async function understandCount(userId) {
  const rows = await jsonRequest("读取理解配额计数",
    `${baseUrl}/rest/v1/usage_daily?user_id=eq.${userId}&select=understand_count`, {
      method: "GET",
      headers: adminHeaders,
    }, [200]);
  return rows[0]?.understand_count ?? 0;
}

async function cleanup(userId, jobIds) {
  for (const jobId of jobIds ?? []) {
    try {
      await fetch(`${baseUrl}/storage/v1/object/generation-temp`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ prefixes: [`understand/${jobId}/`] }),
        signal: AbortSignal.timeout(30_000),
      });
      await fetch(`${baseUrl}/rest/v1/understand_jobs?id=eq.${jobId}`, {
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
    // The operator then kills the VPS worker mid-understanding and restarts it.
    account = await createAccount();
    const bytes = await readFile(new URL("../../../website/assets/presets/p1.jpg", import.meta.url));
    const created = await createJob(account.headers, {
      idempotency_key: `und-e2e-crash-${crypto.randomUUID()}`,
      image: { mime: "image/jpeg", base64: bytes.toString("base64") },
      instruction: "请描述这张图片",
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
    const rows = await jsonRequest("读取崩溃任务", `${baseUrl}/rest/v1/understand_jobs?id=eq.${jobId}&select=*`, {
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
      body: JSON.stringify({ prefixes: [`understand/${jobId}/`] }),
      signal: AbortSignal.timeout(30_000),
    });
    await fetch(`${baseUrl}/rest/v1/understand_jobs?id=eq.${jobId}`, {
      method: "DELETE",
      headers: adminHeaders,
      signal: AbortSignal.timeout(30_000),
    });
    if (job.user_id) {
      await jsonRequest("删除临时账号", `${baseUrl}/auth/v1/admin/users/${job.user_id}`, {
        method: "DELETE",
        headers: adminHeaders,
      }, [200, 204]);
    }
    console.log(`场景CR（Worker 提交后崩溃→租约过期→reconcile 冻结）通过：job=${jobId} hold=${holdRows[0].status}`);
    process.exit(0);
  }

  account = await createAccount();
  const presetBytes = await readFile(new URL("../../../website/assets/presets/p1.jpg", import.meta.url));
  const presetImage = { mime: "image/jpeg", base64: presetBytes.toString("base64") };

  if (scenario === "guard") {
    // --- Scenario G: idempotent replay + cross-account IDOR ---
    const idempotencyKey = `und-e2e-g-${crypto.randomUUID()}`;
    const payload = {
      idempotency_key: idempotencyKey,
      image: presetImage,
      instruction: "请描述这张图片",
    };
    const created = await createJob(account.headers, payload);
    jobIds.push(created.job_id);

    // Same idempotency key + identical payload must return the SAME job, not a second one.
    const replayed = await createJob(account.headers, payload);
    assert.equal(replayed.job_id, created.job_id, "幂等重放应返回同一 job_id");
    assert.equal(replayed.charge.transaction_id, created.charge.transaction_id, "幂等重放不应二次 hold");

    const { job } = await pollJob(account.headers, created.job_id);
    assert.equal(job.status, "succeeded", `guard 基线任务未成功：${job.error?.code}`);
    assert.ok(typeof job.text === "string" && job.text.length > 0, "成功任务缺少反推文本");

    // Cross-account access must 404 without leaking existence.
    const stranger = await createAccount();
    try {
      const stolen = await jsonRequest("越权查询", functionUrl("understand-proxy"), {
        method: "POST",
        headers: stranger.headers,
        body: JSON.stringify({ action: "get", job_id: created.job_id }),
      }, [404]);
      assert.equal(stolen?.error?.code, "invalid_request");
    } finally {
      await jsonRequest("删除陌生账号", `${baseUrl}/auth/v1/admin/users/${stranger.userId}`, {
        method: "DELETE",
        headers: adminHeaders,
      }, [200, 204]);
    }
    console.log(`场景G（幂等重放返回同任务 + 越权 get 404）通过：job=${created.job_id}`);
  } else if (scenario === "basic") {
    // --- Scenario A: real Ark vision caption on the VPS worker ---
    const before = await entitlement(account.headers);
    assert.equal(before.balances.daily, 30, "新账号应获得 30 每日积分");

    const created = await createJob(account.headers, {
      idempotency_key: `und-e2e-a-${crypto.randomUUID()}`,
      image: presetImage,
      instruction: "请描述这张图片",
    });
    jobIds.push(created.job_id);
    assert.ok(ACTIVE.includes(created.status) || created.status === "succeeded", `创建后状态异常：${created.status}`);

    const { job, elapsedMs } = await pollJob(account.headers, created.job_id);
    assert.equal(job.status, "succeeded", `场景A未成功：${job.error?.code} ${job.error?.message}`);
    assert.ok(typeof job.text === "string" && job.text.trim().length > 0, "场景A缺少反推文本");
    assert.equal(job.charge.estimated, 1);
    assert.equal(job.charge.actual, 1);

    const after = await entitlement(account.headers);
    assert.equal(after.balances.daily, 29, "真实反推后应从 30 分扣至 29 分");
    assert.equal(await understandCount(account.userId), 1, "成功反推应占用 1 次免费额度计数");
    console.log(`场景A（真实 Vision 反推）通过：job=${created.job_id} 耗时=${(elapsedMs / 1000).toFixed(1)}s 文本=${job.text.length}字`);

    // --- Scenario B: corrupt image -> Ark rejects -> failed + rollback + quota undo ---
    const corrupt = Buffer.alloc(2_048);
    corrupt[0] = 0xff; corrupt[1] = 0xd8; corrupt[2] = 0xff; corrupt[3] = 0xe0;
    for (let i = 4; i < corrupt.length; i++) corrupt[i] = (i * 31) & 0xff;
    const failing = await createJob(account.headers, {
      idempotency_key: `und-e2e-b-${crypto.randomUUID()}`,
      image: { mime: "image/jpeg", base64: corrupt.toString("base64") },
      instruction: "请描述这张图片",
    });
    jobIds.push(failing.job_id);
    const failed = await pollJob(account.headers, failing.job_id);
    assert.equal(failed.job.status, "failed", `损坏图片应失败，实际 ${failed.job.status}`);
    assert.ok(failed.job.error?.code, "失败任务缺少 error_code");
    const afterB = await entitlement(account.headers);
    assert.equal(afterB.balances.daily, 29, "失败任务应回滚积分（保持 29）");
    assert.equal(await understandCount(account.userId), 1, "失败任务应回补免费额度计数（保持 1）");
    console.log(`场景B（失败注入→回滚+额度回补）通过：job=${failing.job_id} error=${failed.job.error.code} 积分保持 29`);
  } else if (scenario === "long") {
    // --- Scenario L: upstream hangs 200s (fake Ark) -> no timeout, heartbeat renews lease, settles ---
    const before = await entitlement(account.headers);
    assert.equal(before.balances.daily, 30, "新账号应获得 30 每日积分");

    const created = await createJob(account.headers, {
      idempotency_key: `und-e2e-l-${crypto.randomUUID()}`,
      image: presetImage,
      instruction: "请描述这张图片",
    });
    jobIds.push(created.job_id);
    const { job, elapsedMs } = await pollJob(account.headers, created.job_id, { maxWaitMs: 6 * 60_000 });
    assert.equal(job.status, "succeeded", `长等待任务未成功：${job.error?.code} ${job.error?.message}`);
    assert.ok(elapsedMs > 150_000, `任务耗时 ${elapsedMs}ms，未超过 150s 无法证明无超时等待`);
    assert.equal(job.charge.actual, 1);
    const after = await entitlement(account.headers);
    assert.equal(after.balances.daily, 29, "长任务成功后应从 30 分扣至 29 分");
    console.log(`场景L（200s挂起上游→无超时+心跳续租→成功）通过：job=${created.job_id} 耗时=${(elapsedMs / 1000).toFixed(1)}s 积分 30→29`);
  } else {
    // --- Scenario C: unreachable Ark -> submitted then network failure -> outcome_unknown ---
    const before = await entitlement(account.headers);
    assert.equal(before.balances.daily, 30, "新账号应获得 30 每日积分");

    const created = await createJob(account.headers, {
      idempotency_key: `und-e2e-c-${crypto.randomUUID()}`,
      image: presetImage,
      instruction: "请描述这张图片",
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
console.log("UNDERSTAND_E2E_OK");
