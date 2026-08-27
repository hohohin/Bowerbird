/**
 * 内部请求契约单测 —— H1-T1。
 * 覆盖：合法请求、未知字段、整数闭集、模式互斥、id/hash 形状、资源形状与总量。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { validateRenderRequest } from "./contracts.ts";

function validRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    requestId: "req-001",
    runId: "run-abc",
    callId: "call-xyz",
    argsHash: "a".repeat(64),
    html: "<!DOCTYPE html><html><body><p>你好</p></body></html>",
    resources: [],
    viewport: { widthCssPx: 800, heightCssPx: 600, deviceScaleFactor: 1 },
    capture: { mode: "full_page" },
    background: "opaque",
    ...overrides,
  };
}

function reasonOf(overrides: Record<string, unknown>): string | undefined {
  const result = validateRenderRequest(validRequest(overrides));
  return result.ok ? undefined : result.violation.reason;
}

test("accepts a valid request", () => {
  const result = validateRenderRequest(validRequest());
  assert.ok(result.ok);
  assert.equal(result.value.capture.mode, "full_page");
});

test("rejects unknown top-level field", () => {
  assert.equal(reasonOf({ extra: 1 }), "unknown_request_field");
});

test("rejects wrong schemaVersion / bad ids / bad argsHash", () => {
  assert.equal(reasonOf({ schemaVersion: 2 }), "schema_version");
  assert.equal(reasonOf({ runId: "../etc" }), "run_id");
  assert.equal(reasonOf({ runId: "a..b" }), "run_id");
  assert.equal(reasonOf({ argsHash: "XYZ" }), "args_hash");
});

test("rejects html over byte cap", () => {
  assert.equal(reasonOf({ html: "x".repeat(2 * 1024 * 1024 + 10) }), "html_too_large");
});

test("viewport integer closed ranges", () => {
  assert.equal(reasonOf({ viewport: { widthCssPx: 100, heightCssPx: 600, deviceScaleFactor: 1 } }), "viewport_width");
  assert.equal(reasonOf({ viewport: { widthCssPx: 9999, heightCssPx: 600, deviceScaleFactor: 1 } }), "viewport_width");
  assert.equal(reasonOf({ viewport: { widthCssPx: 800, heightCssPx: 100, deviceScaleFactor: 1 } }), "viewport_height");
  assert.equal(reasonOf({ viewport: { widthCssPx: 800, heightCssPx: 600, deviceScaleFactor: 3 } }), "device_scale_factor");
  assert.equal(reasonOf({ viewport: { widthCssPx: 800.5, heightCssPx: 600, deviceScaleFactor: 1 } }), "viewport_width");
});

test("slice params only allowed in full_page_and_slices mode", () => {
  assert.equal(reasonOf({ capture: { mode: "full_page", sliceHeightCssPx: 800 } }), "slice_params_without_slice_mode");
  const good = validateRenderRequest(validRequest({ capture: { mode: "full_page_and_slices", sliceHeightCssPx: 800 } }));
  assert.ok(good.ok);
  assert.equal(reasonOf({ capture: { mode: "full_page_and_slices", sliceHeightCssPx: 200, overlapCssPx: 200 } }), "slice_overlap_ge_height");
  assert.equal(reasonOf({ capture: { mode: "full_page_and_slices" } }), "slice_height");
});

test("resource shape: mime closed set, duplicate keys, sha hex, total bytes", () => {
  const bytes = Buffer.from("hello");
  const data = bytes.toString("base64");
  const sha = createHash("sha256").update(bytes).digest("hex");
  assert.equal(reasonOf({ resources: [{ key: "a", mime: "image/gif", sha256: sha, dataBase64: data }] }), "resource_mime");
  assert.equal(
    reasonOf({
      resources: [
        { key: "a", mime: "image/png", sha256: sha, dataBase64: data },
        { key: "a", mime: "image/png", sha256: sha, dataBase64: data },
      ],
    }),
    "resource_key_duplicate",
  );
  assert.equal(reasonOf({ resources: [{ key: "bad/key", mime: "image/png", sha256: sha, dataBase64: data }] }), "resource_key");
  const bigPayload = "A".repeat(Math.ceil(((20 * 1024 * 1024) + 1024) * 4 / 3));
  assert.equal(reasonOf({ resources: [{ key: "a", mime: "image/png", sha256: sha, dataBase64: bigPayload }] }), "resources_total_bytes");
});

test("background closed set", () => {
  assert.equal(reasonOf({ background: "translucent" }), "background");
});
