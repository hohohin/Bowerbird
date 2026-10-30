import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { createCloudProxy } from "../cloud-proxy.mjs";
import { startServer } from "../server.mjs";

const JOB = "11111111-2222-4333-8444-555555555555";
const CONTROL = "/functions/v1/generate-proxy";
const UPLOAD = `/storage/v1/object/upload/sign/generation-temp/jobs/${JOB}/inputs/video-0.mp4?token=test%2Bsigned`;
const DOWNLOAD = `/storage/v1/object/sign/generation-temp/jobs/${JOB}/outputs/result.mp4?token=test%2Bsigned`;
const AUTH = { Authorization: "Bearer user-token" };

async function fixture(t, overrides = {}) {
  const calls = [];
  const proxy = createCloudProxy({ upstream: "https://project.supabase.co", publicKey: "public-key",
    fetchImpl: async (url, options) => { calls.push({ url, ...options }); return Response.json({ ok: true }); }, ...overrides });
  const server = createServer(proxy).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const send = (path, method = "GET", body, headers = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: server.address().port, path: `/api/cloud${path}`, method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }), ...headers } }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject); req.end(body);
  });
  return { calls, send, port: server.address().port };
}

test("create, lookup, recovery, cancel and receipt preserve identities and user authorization", async t => {
  const { send, calls } = await fixture(t);
  for (const action of [undefined, "get", "get_by_key", "cancel", "artifact_received", "abandon_video_upload", "layer_quote"]) {
    const body = JSON.stringify({ action, idempotency_key: "original-local-key", job_id: JOB, media: "video", prompt: "unchanged" });
    const response = await send(`${CONTROL}?forceFunctionRegion=wrong`, "POST", body,
      { ...AUTH, apikey: "untrusted", Cookie: "secret", "Sb-Forwarded-For": "1.2.3.4" });
    assert.equal(response.status, 200);
    const call = calls.at(-1);
    assert.equal(call.url.href, "https://project.supabase.co/functions/v1/generate-proxy?forceFunctionRegion=ap-northeast-1");
    assert.equal(call.body.toString(), body);
    assert.deepEqual(call.headers, { ...AUTH, apikey: "public-key", "Content-Type": "application/json" });
    assert.equal(call.redirect, "manual");
    assert.equal(response.headers["cache-control"], "no-store");
  }
  assert.equal(calls.length, 7);
});

test("only fixed generation routes and signed job transfers reach upstream", async t => {
  const { send, calls } = await fixture(t);
  for (const [path, method, status] of [
    [CONTROL, "GET", 404], [CONTROL, "POST", 401],
    [CONTROL + "?url=https://evil.test", "POST", 400],
    [CONTROL + "?forceFunctionRegion=a&forceFunctionRegion=b", "POST", 400],
    ["/functions/v1/generation-worker", "POST", 404],
    ["/functions/v1/../generate-proxy", "POST", 404],
    ["/functions/v1/%67enerate-proxy", "POST", 404],
    ["//evil.test/path", "GET", 404],
    [DOWNLOAD.replace("generation-temp", "other-bucket"), "GET", 404],
    [DOWNLOAD.replace("outputs/result.mp4", "inputs/video-0.mp4"), "GET", 404],
    [DOWNLOAD.replace("outputs/result.mp4", "outputs/../result.mp4"), "GET", 404],
    [DOWNLOAD.replace("outputs/result.mp4", "outputs/%2e%2e/result.mp4"), "GET", 404],
    [DOWNLOAD.split("?")[0], "GET", 401],
    [DOWNLOAD + "&token=second", "GET", 400],
    [DOWNLOAD + "&download=1", "GET", 400],
    [UPLOAD, "POST", 404], [UPLOAD, "GET", 404], [DOWNLOAD, "PUT", 404],
  ]) {
    assert.equal((await send(path, method, method === "POST" ? "{}" : undefined)).status, status, path);
  }
  assert.equal(calls.length, 0);
});

test("reference-image JSON can exceed account limit; malformed and oversized requests are rejected", async t => {
  const { send, calls } = await fixture(t);
  const body = JSON.stringify({ reference_images: ["a".repeat(80_000)] });
  assert.equal((await send(CONTROL, "POST", body, AUTH)).status, 200);
  assert.equal(calls[0].body.toString(), body);
  for (const value of ["null", "[]", "invalid"]) assert.equal((await send(CONTROL, "POST", value, AUTH)).status, 400);
  assert.equal((await send(CONTROL, "POST", "{}", { ...AUTH, "Content-Type": "text/plain" })).status, 415);
  assert.equal((await send(CONTROL, "POST", "{}", { ...AUTH, "Content-Length": 21 * 1024 * 1024 })).status, 413);
  assert.equal(calls.length, 1);
});

test("upstream business errors and signed artifact metadata remain unchanged", async t => {
  for (const status of [200, 401, 402, 403, 404, 409, 429, 500]) {
    const body = JSON.stringify({ remote_task_id: JOB, artifact: { url: `https://project.supabase.co${DOWNLOAD}` }, error: { message: "业务提示" } });
    const { send } = await fixture(t, { fetchImpl: async () => new Response(body,
      { status, headers: { "Content-Type": "application/json", "Retry-After": "5", "Set-Cookie": "secret" } }) });
    const response = await send(CONTROL, "POST", "{}", AUTH);
    assert.equal(response.status, status); assert.equal(response.body.toString(), body);
    assert.equal(response.headers["retry-after"], "5"); assert.equal(response.headers["set-cookie"], undefined);
  }
});

test("connection reset, redirect, malformed response and timeout never replay paid POST", async t => {
  for (const [mode, expected] of [["reset", 502], ["redirect", 502], ["html", 502], ["json", 502], ["timeout", 504]]) {
    let calls = 0;
    const { send } = await fixture(t, { timeoutMs: 30, fetchImpl: async (_, { signal }) => {
      calls++;
      if (mode === "reset") throw new Error("10054 secret-upstream-token");
      if (mode === "redirect") return new Response(null, { status: 307, headers: { Location: "https://evil.test/?token=secret" } });
      if (mode === "html") return new Response("secret html", { headers: { "content-type": "text/html" } });
      if (mode === "json") return new Response("bad secret json", { headers: { "content-type": "application/json" } });
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    } });
    const response = await send(CONTROL, "POST", "{}", AUTH);
    assert.equal(response.status, expected, mode); assert.equal(calls, 1);
    assert.ok(!response.body.toString().includes("secret")); assert.equal(response.headers.location, undefined);
  }
});

test("signed video upload streams exact bytes without bearer, cookies or API key", async t => {
  const bytes = Buffer.from([0, 1, 2, 0, 255]); let seen;
  const { send } = await fixture(t, { fetchImpl: async (url, options) => {
    const chunks = []; for await (const chunk of options.body) chunks.push(chunk);
    seen = { url, options, bytes: Buffer.concat(chunks) };
    return Response.json({ Key: `generation-temp/jobs/${JOB}/inputs/video-0.mp4` });
  } });
  const response = await send(UPLOAD, "PUT", bytes, { ...AUTH, Cookie: "secret", "Content-Type": "video/mp4" });
  assert.equal(response.status, 200); assert.deepEqual(seen.bytes, bytes);
  assert.equal(seen.url.href, `https://project.supabase.co${UPLOAD}`);
  assert.deepEqual(seen.options.headers, { "Content-Type": "video/mp4", "Content-Length": "5" });
  assert.equal(seen.options.duplex, "half"); assert.equal(seen.options.redirect, "manual");
});

test("uploads enforce media and size limits before contacting storage", async t => {
  const { send, calls } = await fixture(t);
  assert.equal((await send(UPLOAD, "PUT", "x", { "Content-Type": "text/plain" })).status, 415);
  for (const length of [0, 201 * 1024 * 1024]) {
    assert.equal((await send(UPLOAD, "PUT", undefined, { "Content-Type": "video/mp4", "Content-Length": length })).status, 413);
  }
  assert.equal(calls.length, 0);
});

test("image, video and layer package downloads preserve bytes and do not forward credentials", async t => {
  const bytes = Buffer.from([0, 255, 123, 10]);
  for (const [extension, mime] of [["png", "image/png"], ["mp4", "video/mp4"], ["json", "application/json"]]) {
    let options;
    const { send } = await fixture(t, { fetchImpl: async (_, opts) => {
      options = opts;
      return new Response(new ReadableStream({ start(c) { c.enqueue(bytes.subarray(0, 2)); c.enqueue(bytes.subarray(2)); c.close(); } }),
        { headers: { "Content-Type": mime, "Content-Length": String(bytes.length), "Set-Cookie": "secret" } });
    } });
    const result = await send(DOWNLOAD.replace(".mp4?", `.${extension}?`), "GET", undefined, { ...AUTH, Cookie: "secret" });
    assert.equal(result.status, 200); assert.deepEqual(result.body, bytes);
    assert.equal(result.headers["content-type"], mime); assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(result.headers["set-cookie"], undefined); assert.deepEqual(options.headers, {});
  }
});

test("storage redirects, HTML and oversized files are refused; expired signatures retain status", async t => {
  for (const [status, headers, body, expected] of [
    [302, { Location: "https://evil.test" }, null, 502],
    [200, { "Content-Type": "text/html" }, "unsafe", 502],
    [200, { "Content-Type": "video/mp4", "Content-Length": String(501 * 1024 * 1024) }, "x", 502],
    [403, { "Content-Type": "application/json" }, '{"message":"expired"}', 403],
  ]) {
    const { send } = await fixture(t, { fetchImpl: async () => new Response(body, { status, headers }) });
    assert.equal((await send(DOWNLOAD)).status, expected);
  }
});

test("real Node fetch streams uploads and downloads through the gateway", async t => {
  const bytes = Buffer.alloc(256 * 1024, 7); let received;
  const storage = createServer(async (request, response) => {
    if (request.method === "PUT") {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      received = Buffer.concat(chunks);
      response.writeHead(200, { "Content-Type": "application/json" }); response.end('{"ok":true}');
    } else {
      response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": bytes.length }); response.end(bytes);
    }
  }).listen(0, "127.0.0.1");
  await once(storage, "listening");
  t.after(() => { storage.closeAllConnections(); return new Promise(resolve => storage.close(resolve)); });
  const { send } = await fixture(t, { fetchImpl: (url, options) => fetch(`http://127.0.0.1:${storage.address().port}${url.pathname}${url.search}`, options) });
  assert.equal((await send(UPLOAD, "PUT", bytes, { "Content-Type": "video/mp4" })).status, 200);
  assert.deepEqual(received, bytes);
  assert.deepEqual((await send(DOWNLOAD)).body, bytes);
});

test("slow request ingestion times out before any submission", async t => {
  const { port, calls } = await fixture(t, { timeoutMs: 50 });
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: `/api/cloud${CONTROL}`, method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json", "Content-Length": 10 } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject); req.write("{");
  });
  assert.equal(status, 504); assert.equal(calls.length, 0);
});

test("client disconnect aborts upstream without resubmitting", async t => {
  let started, aborted;
  const ready = new Promise(resolve => { started = resolve; });
  const stopped = new Promise(resolve => { aborted = resolve; });
  let count = 0;
  const { port } = await fixture(t, { fetchImpl: async (_, { signal }) => {
    count++; started();
    return new Promise((_, reject) => signal.addEventListener("abort", () => { aborted(); reject(signal.reason); }, { once: true }));
  } });
  const req = httpRequest({ host: "127.0.0.1", port, path: `/api/cloud${CONTROL}`, method: "POST", headers: { ...AUTH, "Content-Type": "application/json" } });
  req.on("error", () => {}); req.end("{}");
  await ready; req.destroy(); await stopped; assert.equal(count, 1);
});

test("file bytes reach the client before upstream finishes", async t => {
  let finish;
  const { port } = await fixture(t, { fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array([1, 2]));
    finish = () => { controller.enqueue(new Uint8Array([3, 4])); controller.close(); };
  } }), { headers: { "Content-Type": "video/mp4" } }) });
  const bytes = await new Promise((resolve, reject) => {
    httpRequest({ host: "127.0.0.1", port, path: `/api/cloud${DOWNLOAD}` }, res => {
      const chunks = [];
      res.once("data", () => finish());
      res.on("data", chunk => chunks.push(chunk));
      res.on("error", reject); res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject).end();
  });
  assert.deepEqual(bytes, Buffer.from([1, 2, 3, 4]));
});

test("concurrent admissions are bounded and released when requests finish", async t => {
  const releases = []; let admitted;
  const ready = new Promise(resolve => { admitted = resolve; });
  const { send } = await fixture(t, { fetchImpl: () => new Promise(resolve => {
    releases.push(() => resolve(Response.json({ ok: true })));
    if (releases.length === 8) admitted();
  }) });
  const pending = Array.from({ length: 8 }, () => send(CONTROL, "POST", "{}", AUTH));
  await ready;
  const limited = await send(CONTROL, "POST", "{}", AUTH);
  assert.equal(limited.status, 429); assert.equal(limited.headers["retry-after"], "60");
  for (const release of releases) release();
  assert.ok((await Promise.all(pending)).every(result => result.status === 200));
});

test("website mounts generation separately from the existing account gateway", async t => {
  const server = startServer({ root: ".", host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/cloud${CONTROL}`, { method: "POST" });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "cloud_gateway_401");
  assert.equal((await fetch(`${base}/api/account${CONTROL}`, { method: "POST" })).status, 404);
  assert.equal((await fetch(`${base}/healthz`)).status, 204);
});
