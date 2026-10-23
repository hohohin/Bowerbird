import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { createAccountProxy } from "../account-proxy.mjs";

async function fixture(t, overrides = {}) {
  const calls = [];
  const proxy = createAccountProxy({
    upstream: "https://project.supabase.co", publicKey: "sb_publishable_test",
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      return Response.json({ ok: true });
    }, ...overrides,
  });
  const server = createServer(proxy).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const send = (path, method = "GET", body, headers = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: server.address().port, path: `/api/account${path}`, method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers } }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(body);
  });
  return { send, calls };
}

test("QR uses fixed upstream and region, strips client headers and never retries", async t => {
  const { send, calls } = await fixture(t);
  const res = await send("/functions/v1/wechat-login?state=dt_test&forceFunctionRegion=wrong", "GET", undefined,
    { apikey: "attacker-key", Authorization: "Bearer unwanted", Cookie: "secret", "Sb-Forwarded-For": "1.2.3.4" });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.href, "https://project.supabase.co/functions/v1/wechat-login?state=dt_test&forceFunctionRegion=ap-northeast-1");
  assert.deepEqual(calls[0].headers, { apikey: "sb_publishable_test", "Content-Type": "application/json" });
  assert.equal(calls[0].redirect, "manual");
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.headers["referrer-policy"], "no-referrer");
});

test("only exact allowlisted paths, methods, parameters and token grants reach upstream", async t => {
  const { send, calls } = await fixture(t);
  for (const [path, method] of [
    ["/auth/v1/admin/users", "GET"], ["/functions/v1/generate-proxy", "POST"],
    ["/functions/v1/../wechat-login", "GET"], ["/functions/v1/%77echat-login", "GET"],
    ["//evil.example/path", "GET"], ["/auth/v1/token?grant_type=password", "POST"],
    ["/auth/v1/token?grant_type=pkce&grant_type=refresh_token", "POST"],
    ["/functions/v1/wechat-login?url=https://evil.example", "GET"],
    ["/functions/v1/wechat-login", "DELETE"],
  ]) assert.ok([400, 404].includes((await send(path, method, method === "POST" ? "{}" : undefined)).status), path);
  assert.equal(calls.length, 0);
});

test("bearer required and preserved for entitlement and redemption; signed bytes unchanged", async t => {
  const payload = '{ "signature": "unaltered", "signature_version": 1 }';
  let forwarded;
  const { send } = await fixture(t, { fetchImpl: async (_, options) => {
    forwarded = options;
    return new Response(payload, { headers: { "content-type": "application/json", "set-cookie": "not-forwarded" } });
  } });
  assert.equal((await send("/functions/v1/entitlement")).status, 401);
  const res = await send("/functions/v1/entitlement", "GET", undefined, { Authorization: "Bearer user-token" });
  assert.equal(res.body, payload);
  assert.equal(forwarded.headers.Authorization, "Bearer user-token");
  assert.equal(res.headers["set-cookie"], undefined);
  assert.equal((await send("/functions/v1/redeem-code", "POST", '{"code":"test"}')).status, 401);
});

test("Comfy download authorizes POST only, preserves bearer and never caches grants", async t => {
  const { send, calls } = await fixture(t);
  const path = "/functions/v1/comfy-download", body = '{"version":"h3-v1-comfy-0.42.1","file":"portable.7z"}';
  assert.equal((await send(path, "POST", body)).status, 401);
  assert.equal((await send(path)).status, 404);
  const response = await send(path, "POST", body, { Authorization: "Bearer user-token" });
  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(calls.at(-1).headers.Authorization, "Bearer user-token");
  assert.equal(calls.at(-1).body.toString(), body);
  assert.equal(calls.at(-1).url.origin, "https://project.supabase.co");
  assert.equal(calls.at(-1).redirect, "manual");
});

test("PKCE, refresh and email requests preserve bodies without privilege elevation", async t => {
  const { send, calls } = await fixture(t);
  for (const grant of ["pkce", "refresh_token"]) {
    const body = JSON.stringify(grant === "pkce" ? { auth_code: "test", code_verifier: "test-verifier" } : { refresh_token: "test-refresh" });
    assert.equal((await send(`/auth/v1/token?grant_type=${grant}`, "POST", body)).status, 200);
    assert.equal(calls.at(-1).body.toString(), body);
  }
  const callback = encodeURIComponent("bowerbird://auth/callback?state=abc");
  assert.equal((await send(`/auth/v1/otp?redirect_to=${callback}`, "POST", '{"email":"test@example.invalid","code_challenge":"test"}')).status, 200);
  assert.equal((await send("/auth/v1/otp?redirect_to=https://evil.example", "POST", '{"email":"test@example.invalid"}')).status, 400);
  assert.equal((await send("/auth/v1/otp", "POST", '{"phone":"123"}')).status, 400);
});

test("email verification returns allowed deep link intact without following or copying response body", async t => {
  const callback = "bowerbird://auth/callback?state=abc&code=one-time-code";
  const { send } = await fixture(t, { fetchImpl: async () => new Response("sensitive upstream HTML", { status: 303, headers: { location: callback } }) });
  const res = await send(`/auth/v1/verify?token=pkce_test&type=magiclink&redirect_to=${encodeURIComponent("bowerbird://auth/callback?state=abc")}`);
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, callback);
  assert.equal(res.body, "");
});

test("upstream redirects cannot leak tokens to arbitrary origins", async t => {
  const { send } = await fixture(t, { fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://evil.example/?token=secret" } }) });
  const res = await send("/auth/v1/verify?token=test&type=signup");
  assert.equal(res.status, 502);
  assert.equal(res.headers.location, undefined);
  assert.ok(!res.body.includes("secret"));
  assert.equal((await send("/functions/v1/wechat-login?state=dt_test")).status, 502);
});

test("invalid JSON, media types and large bodies are rejected", async t => {
  const { send, calls } = await fixture(t);
  const path = "/auth/v1/token?grant_type=pkce";
  assert.equal((await send(path, "POST", "broken")).status, 400);
  assert.equal((await send(path, "POST", "[]")).status, 400);
  assert.equal((await send(path, "POST", "{}", { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await send(path, "POST", "x".repeat(65_537))).status, 413);
  assert.equal(calls.length, 0);
});

test("upstream auth errors and numeric retry delay retained; oversized/error text sanitized", async t => {
  let mode = "auth";
  const { send } = await fixture(t, { fetchImpl: async () => mode === "auth"
    ? Response.json({ code: "refresh_token_not_found" }, { status: 400, headers: { "retry-after": "60" } })
    : new Response(mode === "large" ? "x".repeat(1_048_577) : "https://secret/?token=secret", { status: mode === "error" ? 500 : 200, headers: { "content-type": "application/json" } }) });
  const res = await send("/auth/v1/token?grant_type=refresh_token", "POST", "{}");
  assert.equal(res.status, 400);
  assert.equal(res.headers["retry-after"], "60");
  assert.equal(JSON.parse(res.body).code, "refresh_token_not_found");
  for (mode of ["large", "error"]) {
    const failed = await send("/functions/v1/wechat-login");
    assert.equal(failed.status, 502);
    assert.ok(!failed.body.includes("secret"));
  }
});

test("transport failure and timeout return safe errors and make only one attempt", async t => {
  let attempts = 0;
  const { send } = await fixture(t, { timeoutMs: 15, fetchImpl: async (_, { signal }) => {
    attempts++;
    if (attempts === 1) throw new Error("https://private/?token=secret");
    await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  } });
  const res = await send("/functions/v1/wechat-login");
  assert.equal(res.status, 502);
  assert.ok(!res.body.includes("secret"));
  assert.equal(attempts, 1);
  assert.equal((await send("/functions/v1/wechat-login")).status, 504);
  assert.equal(attempts, 2);
});

test("IP limits apply even when clients spoof forwarding headers", async t => {
  const { send, calls } = await fixture(t);
  for (let i = 0; i < 5; i++) assert.equal((await send("/auth/v1/otp", "POST", '{"email":"test@example.invalid"}', { "x-real-ip": `1.1.1.${i}` })).status, 200);
  assert.equal((await send("/auth/v1/otp", "POST", '{"email":"test@example.invalid"}', { "x-real-ip": "2.2.2.2" })).status, 429);
  assert.equal(calls.length, 5);
});
