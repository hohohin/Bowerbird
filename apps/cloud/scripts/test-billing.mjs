import assert from "node:assert/strict";

const url = process.env.SUPABASE_URL;
function readSecretKey() {
  if (process.env.SUPABASE_SECRET_KEY) return process.env.SUPABASE_SECRET_KEY;
  if (process.env.SUPABASE_SECRET_KEYS) {
    return JSON.parse(process.env.SUPABASE_SECRET_KEYS).default;
  }
  return process.env.SUPABASE_SERVICE_ROLE_KEY;
}

const serviceKey = readSecretKey();
const userId = process.env.BILLING_TEST_USER_ID;

if (!url || !serviceKey || !userId) {
  console.error(
    "缺少 SUPABASE_URL、SUPABASE_SECRET_KEY（或 SUPABASE_SECRET_KEYS）或 BILLING_TEST_USER_ID；先启动本地 Supabase 并创建测试用户。",
  );
  process.exit(2);
}

const endpoint = `${url.replace(/\/$/, "")}/rest/v1/rpc/credit_hold`;
const headers = {
  apikey: serviceKey,
  authorization: `Bearer ${serviceKey}`,
  "content-type": "application/json",
};
const key = `concurrent-${crypto.randomUUID()}`;

// The same idempotency key is deliberately raced twenty times. PostgreSQL should return one hold.
const responses = await Promise.all(
  Array.from({ length: 20 }, () =>
    fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        p_user_id: userId,
        p_idempotency_key: key,
        p_service: "image_sd",
        p_estimated_amount: 5,
      }),
    }),
  ),
);

const bodies = await Promise.all(
  responses.map(async (response) => ({ status: response.status, body: await response.text() })),
);
for (const item of bodies) {
  assert.equal(item.status, 200, item.body);
}

const holdIds = new Set(
  bodies.flatMap(({ body }) => JSON.parse(body)).map((row) => row.hold_id),
);
assert.equal(holdIds.size, 1, "并发幂等 hold 必须只产生一个 hold_id");
console.log(`并发 hold 通过：20 个请求共享 hold ${[...holdIds][0]}`);
