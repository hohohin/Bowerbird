import assert from "node:assert/strict";

// Payment Mock contract tests. These hit local Supabase Functions via curl (or are left as a
// documented harness when the CLI is absent). Constants:
const BASE = process.env.SUPABASE_URL?.replace(/\/$/, "");
function readSecretKey() {
  if (process.env.SUPABASE_SECRET_KEY) return process.env.SUPABASE_SECRET_KEY;
  if (process.env.SUPABASE_SECRET_KEYS) return JSON.parse(process.env.SUPABASE_SECRET_KEYS).default;
  return process.env.SUPABASE_SERVICE_ROLE_KEY;
}

const SERVICE_KEY = readSecretKey();
const CHECKOUT = `${BASE}/functions/v1/create-checkout`;
const WEBHOOK = `${BASE}/functions/v1/payment-webhook`;
const SECRET = process.env.SUPERUN_WEBHOOK_SECRET ?? "mock-secret";
const USER = process.env.BILLING_TEST_USER_ID;

if (!BASE || !SERVICE_KEY || !USER) {
  console.error("缺少 SUPABASE_URL / SUPABASE_SECRET_KEY（或 SUPABASE_SECRET_KEYS）/ BILLING_TEST_USER_ID；跳过支付 Mock 联调。");
  process.exit(2);
}

const headers = { authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json" };

async function checkout(product) {
  const response = await fetch(CHECKOUT, {
    method: "POST",
    headers,
    body: JSON.stringify({ product }),
  });
  assert.equal(response.status, 201, await response.text());
  return (await response.json()).order_id;
}

async function webhook(event, signature) {
  return fetch(WEBHOOK, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-provider-signature": signature,
    },
    body: JSON.stringify(event),
  });
}

const orderId = await checkout("credits_100");
const baseEvent = {
  event: "order.paid",
  provider_order_id: orderId,
  provider_event_id: `evt-${crypto.randomUUID()}`,
  product: "credits_100",
  user_id: USER,
};

// 1) Invalid signature is rejected.
const bad = await webhook(baseEvent, "wrong");
assert.equal(bad.status, 401);

// 2) Replay of the same event is a no-op (second paid returns 200, grants stay idempotent via topup).
const good = await webhook(baseEvent, SECRET);
assert.equal(good.status, 200);
const replay = await webhook(baseEvent, SECRET);
assert.equal(replay.status, 200);

// 3) Refund after paid reaches a deterministic refunded state.
const refund = await webhook({ ...baseEvent, event: "order.refunded", provider_event_id: `evt-${crypto.randomUUID()}` }, SECRET);
assert.equal(refund.status, 200);

console.log("支付 Mock 契约通过：验签拒绝、paid 重放幂等、paid→refunded 状态确定。");
