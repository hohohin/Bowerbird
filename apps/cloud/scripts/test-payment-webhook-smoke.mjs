import assert from "node:assert/strict";

const baseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
const secret = process.env.SUPERUN_WEBHOOK_SECRET?.trim();
if (!baseUrl) {
  console.error("缺少 SUPABASE_URL");
  process.exit(2);
}

const endpoint = `${baseUrl}/functions/v1/payment-webhook?forceFunctionRegion=ap-northeast-1`;
const event = {
  event: "order.paid",
  provider_order_id: `smoke-unknown-${crypto.randomUUID()}`,
  provider_event_id: `smoke-event-${crypto.randomUUID()}`,
};

async function send(signature) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-provider-signature": signature,
    },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json();
  return { status: response.status, body };
}

const rejected = await send("invalid-smoke-signature");
assert.equal(rejected.status, 401, JSON.stringify(rejected.body));
assert.equal(rejected.body?.error?.code, "unauthorized");

if (secret) {
  const verified = await send(secret);
  assert.equal(verified.status, 400, JSON.stringify(verified.body));
  assert.equal(verified.body?.error?.code, "invalid_request");
  console.log("payment-webhook 远端冒烟通过：错误签名 401；正确签名进入订单校验并返回未知订单 400。");
} else {
  console.log("payment-webhook 远端冒烟通过：错误签名 401；本地未保存回调密钥，跳过正确签名分支。");
}
