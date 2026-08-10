import assert from "node:assert/strict";

const baseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");

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

if (!baseUrl || !publishableKey || !secretKey) {
  console.error("缺少 SUPABASE_URL、publishable key 或 secret key");
  process.exit(2);
}
assert.equal(process.env.BOWERBIRD_CLOUD_MOCK, "false", "真实 Cloud E2E 要求 BOWERBIRD_CLOUD_MOCK=false");

function safeError(label, response, body) {
  const code = body?.error?.code ?? body?.code ?? "unknown";
  const message = body?.error?.message ?? body?.message ?? "无错误详情";
  return new Error(`${label}失败（HTTP ${response.status}, ${code}）：${message}`);
}

async function jsonRequest(label, url, init, expectedStatuses = [200]) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(180_000) });
  const edgeRegion = response.headers.get("x-sb-edge-region");
  if (edgeRegion) observedRegions.set(label, edgeRegion);
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
  const region = process.env.CLOUD_E2E_FUNCTION_REGION?.trim();
  const query = region ? `?forceFunctionRegion=${encodeURIComponent(region)}` : "";
  return `${baseUrl}/functions/v1/${name}${query}`;
}

const adminHeaders = {
  apikey: secretKey,
  authorization: `Bearer ${secretKey}`,
  "content-type": "application/json",
};
const email = `cloud-e2e-${Date.now()}-${crypto.randomUUID().slice(0, 8)}@example.test`;
const password = `${crypto.randomUUID()}Aa1!`;
let userId;
let testError;
const observedRegions = new Map();

try {
  const created = await jsonRequest("创建临时账号", `${baseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  userId = created.id;
  assert.ok(userId, "临时账号缺少 user id");

  const session = await jsonRequest("临时账号登录", `${baseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: publishableKey, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.ok(session.access_token, "临时账号登录未返回 access token");

  const userHeaders = {
    apikey: publishableKey,
    authorization: `Bearer ${session.access_token}`,
    "content-type": "application/json",
  };
  const before = await jsonRequest("读取生成前权益", functionUrl("entitlement"), {
    method: "GET",
    headers: userHeaders,
  });
  assert.equal(before.tier, "free");
  assert.equal(before.balances.daily, 30, "新账号应获得 30 每日积分");

  // Exercise the billing RPC directly first so database errors are reported with their
  // PostgreSQL code instead of being intentionally hidden by the public Function response.
  const preflight = await jsonRequest("积分预授权预检", `${baseUrl}/rest/v1/rpc/credit_hold`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      p_user_id: userId,
      p_idempotency_key: `cloud-e2e-preflight-${crypto.randomUUID()}`,
      p_service: "image_sd",
      p_estimated_amount: null,
    }),
  });
  assert.ok(Array.isArray(preflight) && preflight[0]?.hold_id, "积分预授权预检无返回");
  const rolledBack = await jsonRequest("积分预授权回滚预检", `${baseUrl}/rest/v1/rpc/credit_rollback`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ p_hold_id: preflight[0].hold_id, p_reason: "cloud_e2e_preflight" }),
  });
  assert.equal(rolledBack[0]?.daily_balance, 30, "预检回滚后应恢复 30 分");

  const generateBody = {
    idempotency_key: `cloud-e2e-${crypto.randomUUID()}`,
    media: "image",
    service: "image_sd",
    ratio: "1:1",
    prompt: "A minimal flat vector illustration of a single blue circle centered on a warm white background, clean edges, no text.",
    reference_images: [],
  };
  const generated = await jsonRequest("真实 Cloud 出图", functionUrl("generate-proxy"), {
    method: "POST",
    headers: userHeaders,
    body: JSON.stringify(generateBody),
  });
  assert.equal(generated.status, "succeeded");
  assert.equal(generated.charge.estimated, 5);
  assert.equal(generated.charge.actual, 5);
  assert.ok(Array.isArray(generated.images) && generated.images.length > 0, "生成响应缺少图片");
  const imageBytes = Buffer.from(generated.images[0].base64, "base64").byteLength;
  assert.ok(imageBytes > 1_024, "生成图片字节数异常");

  const holdRows = await jsonRequest(
    "读取生成用量预留",
    `${baseUrl}/rest/v1/credit_holds?id=eq.${encodeURIComponent(generated.charge.transaction_id)}&select=status,reserved_cost_micros`,
    { method: "GET", headers: adminHeaders },
  );
  assert.equal(holdRows[0]?.status, "confirmed", "生成 hold 应已确认");
  assert.equal(holdRows[0]?.reserved_cost_micros, 235_000, "5 分应按 ¥0.047/分预留 ¥0.235 成本");

  const replay = await jsonRequest("生成幂等重放", functionUrl("generate-proxy"), {
    method: "POST",
    headers: userHeaders,
    body: JSON.stringify(generateBody),
  }, [400]);
  assert.equal(replay?.error?.code, "invalid_request", "同一幂等键重放必须在调用上游前拒绝");

  // Reserve one zero-cost guard claim, then use the current minute count as the exact
  // limit for a second hold. The second claim must be rejected atomically.
  const secondsIntoMinute = new Date().getUTCSeconds();
  if (secondsIntoMinute >= 55) {
    await new Promise((resolve) => setTimeout(resolve, (61 - secondsIntoMinute) * 1_000));
  }
  const guardHoldOne = await jsonRequest("创建限流测试 hold 1", `${baseUrl}/rest/v1/rpc/credit_hold`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      p_user_id: userId,
      p_idempotency_key: `guard-rate-one-${crypto.randomUUID()}`,
      p_service: "caption",
      p_estimated_amount: 1,
    }),
  });
  const guardHoldOneId = guardHoldOne[0]?.hold_id;
  assert.ok(guardHoldOneId, "限流测试 hold 1 无返回");
  const firstGuard = await jsonRequest("建立限流测试基线", `${baseUrl}/rest/v1/rpc/reserve_managed_usage`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      p_user_id: userId,
      p_hold_id: guardHoldOneId,
      p_cost_micros: 0,
      p_daily_cost_limit_micros: 1_000_000_000,
      p_per_user_per_min: 100,
    }),
  });
  assert.equal(firstGuard[0]?.already_reserved, false);
  const minuteRows = await jsonRequest(
    "读取当前分钟用量",
    `${baseUrl}/rest/v1/usage_minute?user_id=eq.${encodeURIComponent(userId)}&select=request_count&order=minute_start.desc&limit=1`,
    { method: "GET", headers: adminHeaders },
  );
  const currentMinuteCount = Number(minuteRows[0]?.request_count ?? 0);
  assert.ok(currentMinuteCount > 0, "当前分钟用量未写入");

  const guardHoldTwo = await jsonRequest("创建限流测试 hold 2", `${baseUrl}/rest/v1/rpc/credit_hold`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      p_user_id: userId,
      p_idempotency_key: `guard-rate-two-${crypto.randomUUID()}`,
      p_service: "caption",
      p_estimated_amount: 1,
    }),
  });
  const guardHoldTwoId = guardHoldTwo[0]?.hold_id;
  assert.ok(guardHoldTwoId, "限流测试 hold 2 无返回");
  const rateRejected = await jsonRequest("单用户分钟限流", `${baseUrl}/rest/v1/rpc/reserve_managed_usage`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      p_user_id: userId,
      p_hold_id: guardHoldTwoId,
      p_cost_micros: 0,
      p_daily_cost_limit_micros: 1_000_000_000,
      p_per_user_per_min: currentMinuteCount,
    }),
  }, [400]);
  assert.equal(rateRejected?.details, "rate_limit_per_minute", "分钟限流应返回稳定 detail");

  const systemUsage = await jsonRequest(
    "读取全站当日用量",
    `${baseUrl}/rest/v1/system_usage_daily?select=cost_micros&order=business_date.desc&limit=1`,
    { method: "GET", headers: adminHeaders },
  );
  const currentDailyCost = Number(systemUsage[0]?.cost_micros ?? 0);
  assert.ok(currentDailyCost >= 235_000, "全站当日成本未包含本次真实出图预留");
  const costRejected = await jsonRequest("全站日成本熔断", `${baseUrl}/rest/v1/rpc/reserve_managed_usage`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      p_user_id: userId,
      p_hold_id: guardHoldTwoId,
      p_cost_micros: 47_000,
      p_daily_cost_limit_micros: currentDailyCost,
      p_per_user_per_min: 100,
    }),
  }, [400]);
  assert.equal(costRejected?.details, "daily_cost_limit", "成本熔断应返回稳定 detail");

  for (const guardHoldId of [guardHoldOneId, guardHoldTwoId]) {
    await jsonRequest("回滚守卫测试 hold", `${baseUrl}/rest/v1/rpc/credit_rollback`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ p_hold_id: guardHoldId, p_reason: "cloud_e2e_usage_guard" }),
    });
  }

  const after = await jsonRequest("读取生成后权益", functionUrl("entitlement"), {
    method: "GET",
    headers: userHeaders,
  });
  assert.equal(after.balances.daily, 25, "真实出图后应从 30 分扣至 25 分");
  assert.ok(
    after.recent_transactions.some((tx) => tx.kind === "confirm" && tx.service === "image_sd"),
    "积分流水缺少 image_sd confirm",
  );

  console.log("Cloud E2E 通过");
  console.log(`注册积分：${before.balances.daily}`);
  console.log(`实际扣费：${generated.charge.actual}`);
  console.log(`预留成本微元：${holdRows[0].reserved_cost_micros}`);
  console.log("幂等认领 / 分钟限流 / 每日成本熔断：通过");
  console.log(`生成后积分：${after.balances.daily}`);
  console.log(`生成图片字节：${imageBytes}`);
  console.log(`Edge 区域：${observedRegions.get("真实 Cloud 出图") ?? "unknown"}`);
} catch (error) {
  testError = error;
} finally {
  if (userId) {
    try {
      await jsonRequest("删除临时账号", `${baseUrl}/auth/v1/admin/users/${userId}`, {
        method: "DELETE",
        headers: adminHeaders,
      });
      console.log("临时账号已清理");
    } catch (cleanupError) {
      testError ??= cleanupError;
    }
  }
}

if (testError) throw testError;
