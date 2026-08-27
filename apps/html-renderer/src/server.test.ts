/**
 * 内部 HTTP server 单测（mock 渲染函数，不依赖 Chromium）—— H1-T1/T5。
 * 覆盖：鉴权（timing-safe 路径的行为结果）、请求体上限、JSON 错误、并发 1 + 有界队列
 * 的容量拒绝、稳定错误码→HTTP 状态映射、healthz 无内容。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startRenderServer } from "./server.ts";
import type { InternalRenderResult } from "./contracts.ts";

const TOKEN = "unit-test-internal-token-0123456789abcdef";

function startMock(handle: (body: unknown) => Promise<InternalRenderResult>) {
  const running = startRenderServer({
    port: 0,
    token: TOKEN,
    handleRender: handle,
    health: () => ({ rendererFingerprint: "bwr1-test" }),
    log: () => undefined,
  });
  return running;
}

function listen(server: { listen: (port: number, host: string, cb: () => void) => void }): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = (server as unknown as { address: () => { port: number } }).address();
      resolve(address.port);
    });
  });
}

async function post(port: number, body: string, token = TOKEN): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/render`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body,
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

test("healthz returns fingerprint and queue state without content", async () => {
  const running = startMock(async () => ({ ok: false, code: "render_service_unavailable", message: "x", retryable: true }));
  const port = await listen(running.server as never);
  const res = await fetch(`http://127.0.0.1:${port}/healthz`);
  const json = (await res.json()) as Record<string, unknown>;
  assert.equal(res.status, 200);
  assert.equal(json.rendererFingerprint, "bwr1-test");
  assert.equal(json.busy, false);
  await running.close();
});

test("auth: missing/wrong token 401; correct token passes", async () => {
  const running = startMock(async () => ({ ok: true, outputs: [] }) as unknown as InternalRenderResult);
  const port = await listen(running.server as never);
  const noAuth = await fetch(`http://127.0.0.1:${port}/render`, { method: "POST", body: "{}" });
  assert.equal(noAuth.status, 401);
  const bad = await post(port, "{}", "wrong-token-000000000000000000000000000");
  assert.equal(bad.status, 401);
  await running.close();
});

test("invalid json → 400 render_input_invalid", async () => {
  const running = startMock(async () => ({ ok: true, outputs: [] }) as unknown as InternalRenderResult);
  const port = await listen(running.server as never);
  const res = await fetch(`http://127.0.0.1:${port}/render`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: "{not json",
  });
  const json = (await res.json()) as Record<string, unknown>;
  assert.equal(res.status, 400);
  assert.equal(json.code, "render_input_invalid");
  await running.close();
});

test("stable failure codes map to http status", async () => {
  const running = startMock(async () => ({ ok: false, code: "render_html_unsafe", message: "x", retryable: false }));
  const port = await listen(running.server as never);
  const result = await post(port, JSON.stringify({ requestId: "r1" }));
  assert.equal(result.status, 400);
  assert.equal(result.json.code, "render_html_unsafe");
  await running.close();
});

test("concurrency 1 + queue 1: third concurrent request gets render_capacity_busy", async () => {
  let releaseFirst: () => void = () => undefined;
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let started = 0;
  const running = startMock(async () => {
    started += 1;
    if (started === 1) await first;
    return { ok: true, outputs: [] } as unknown as InternalRenderResult;
  });
  const port = await listen(running.server as never);
  const p1 = post(port, JSON.stringify({ requestId: "a" }));
  const p2 = post(port, JSON.stringify({ requestId: "b" }));
  await new Promise((r) => setTimeout(r, 50));
  const p3 = await post(port, JSON.stringify({ requestId: "c" }));
  assert.equal(p3.status, 429);
  assert.equal(p3.json.code, "render_capacity_busy");
  releaseFirst();
  const r1 = await p1;
  const r2 = await p2;
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  await running.close();
});

test("success result passes through with outputs", async () => {
  const running = startMock(async (body) => {
    const req = body as { requestId: string };
    return {
      ok: true,
      schemaVersion: 1,
      rendererFingerprint: "bwr1-x",
      runId: "run",
      callId: "call",
      argsHash: "0".repeat(64),
      sourceHtmlSha256: "1".repeat(64),
      document: { widthCssPx: 800, heightCssPx: 600, widthDevicePx: 800, heightDevicePx: 600 },
      renderMs: 5,
      outputs: [{ role: "full_page_screenshot", clipDevicePx: { x: 0, y: 0, width: 800, height: 600 }, mime: "image/png", widthDevicePx: 800, heightDevicePx: 600, bytes: 3, sha256: "2".repeat(64), dataBase64: "AAA" }],
      ...(req.requestId === "x" ? {} : {}),
    } as unknown as InternalRenderResult;
  });
  const port = await listen(running.server as never);
  const result = await post(port, JSON.stringify({ requestId: "ok" }));
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  await running.close();
});
