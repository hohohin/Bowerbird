import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { createPaymentProxy } from "../payment-proxy.mjs";

const signedHeaders = {
  "content-type": "application/json", "wechatpay-timestamp": "1793721600",
  "wechatpay-nonce": "test-nonce", "wechatpay-signature": "synthetic-signature",
  "wechatpay-serial": "PUB_KEY_ID_test", "wechatpay-signature-type": "WECHATPAY2-SHA256-RSA2048",
};
async function fixture(t, options = {}) {
  const calls = [];
  const proxy = createPaymentProxy({ upstream: "https://example.supabase.co", fetchImpl: async (url, init) => {
    calls.push({ url, ...init }); return new Response(null, { status: 204 });
  }, ...options });
  const server = createServer(proxy).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise(done => server.close(done)); });
  const send = (path = "/api/pay/wechat/notify", body = "{}", headers = signedHeaders, method = "POST") => new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port: server.address().port, path, method, headers }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    request.on("error", reject);
    request.end(body);
  });
  return { calls, send };
}

test("payment and refund callbacks retain signed UTF-8 bytes and exact signature headers", async t => {
  const { calls, send } = await fixture(t);
  const body = '{\n "description": "微信支付", "resource": {"ciphertext":"abc"}\n}';
  for (const path of ["/api/pay/wechat/notify", "/api/pay/wechat/refund-notify"]) {
    const response = await send(path, body, { ...signedHeaders, Authorization: "Bearer never-forward", apikey: "never-forward", Cookie: "never-forward", "x-provider-signature": "never-forward" });
    assert.equal(response.status, 204);
    assert.equal(response.headers["cache-control"], "no-store");
    const call = calls.at(-1);
    assert.deepEqual(call.body, Buffer.from(body));
    assert.equal(call.url.href, "https://example.supabase.co/functions/v1/payment-webhook?forceFunctionRegion=ap-northeast-1");
    assert.equal(call.redirect, "manual");
    assert.equal(call.headers["wechatpay-signature"], signedHeaders["wechatpay-signature"]);
    assert.ok(!JSON.stringify(call.headers).includes("never-forward"));
  }
});

test("only exact POST routes, bounded identity bodies and signature headers pass", async t => {
  const { calls, send } = await fixture(t);
  assert.equal((await send("/api/pay/wechat/notify?target=https://other.invalid")).status, 404);
  assert.equal((await send("/api/pay/wechat/notify/../notify")).status, 404);
  assert.equal((await send(undefined, "", signedHeaders, "GET")).status, 405);
  assert.equal((await send(undefined, "{}", { "content-type": "application/json", "x-provider-signature": "mock" })).status, 400);
  assert.equal((await send(undefined, "{}", { ...signedHeaders, "content-encoding": "gzip" })).status, 415);
  assert.equal((await send(undefined, "x".repeat(65_537))).status, 413);
  assert.equal(calls.length, 0);
});

test("unknown signatures reach Edge for verification; upstream rejection never becomes success", async t => {
  let status = 401;
  const { send } = await fixture(t, { fetchImpl: async () => new Response("secret diagnostic", { status }) });
  for (status of [401, 400, 500, 302]) {
    const result = await send();
    assert.equal(result.status, status < 500 && status >= 400 ? status : 502);
    assert.ok(!result.body.includes("secret"));
  }
});

test("transport errors and timeouts are not acknowledged or retried", async t => {
  let count = 0;
  const { send } = await fixture(t, { timeoutMs: 20, fetchImpl: async (_, { signal }) => {
    if (++count === 1) throw new Error("private URL");
    await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  } });
  assert.equal((await send()).status, 502);
  assert.equal((await send()).status, 504);
  assert.equal(count, 2);
});

test("an upstream success is acknowledged without forwarding arbitrary response content", async t => {
  const { send } = await fixture(t, { fetchImpl: async () => new Response("not relayed", { status: 200 }) });
  const response = await send();
  assert.equal(response.status, 204);
  assert.equal(response.body, "");
});
