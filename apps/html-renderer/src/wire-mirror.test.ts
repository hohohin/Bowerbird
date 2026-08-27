/**
 * Worker ↔ renderer wire 契约镜像测试（跨包，仅测试代码）。
 * agent-worker 的 HtmlRenderExecutor 构造的内部请求必须被本包（renderer）的
 * validateRenderRequest 接受；worker 侧模型输入校验的拒绝样例也必须被同构拒绝。
 * worker 侧 contracts/render-html.ts 是零 node 依赖的纯模块，可直接导入。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { validateRenderRequest } from "./contracts.ts";
import { base64Encode, validateRenderHtmlInput } from "../../agent-worker/src/contracts/render-html.ts";

function wireFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const resourceBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  return {
    schemaVersion: 1,
    requestId: "run-1.call-1",
    runId: "run-1",
    callId: "call-1",
    argsHash: "a".repeat(64),
    html: "<!DOCTYPE html><html><body><p>中文排版</p></body></html>",
    resources: [
      {
        key: "reference-1",
        mime: "image/png",
        sha256: createHash("sha256").update(resourceBytes).digest("hex"),
        dataBase64: base64Encode(resourceBytes),
      },
    ],
    viewport: { widthCssPx: 800, heightCssPx: 600, deviceScaleFactor: 1 },
    capture: { mode: "full_page_and_slices", sliceHeightCssPx: 1000, overlapCssPx: 0 },
    background: "opaque",
    ...overrides,
  };
}

test("worker executor-shaped wire request passes renderer contract", () => {
  const result = validateRenderRequest(wireFixture());
  assert.ok(result.ok, `renderer 应接受: ${JSON.stringify(result)}`);
});

test("shapes rejected by worker input validator are rejected by renderer contract too", () => {
  // 非切片模式携带切片参数：两侧同构拒绝
  assert.ok(!validateRenderRequest(wireFixture({ capture: { mode: "full_page", sliceHeightCssPx: 1000 } })).ok);
  // 越界视口
  assert.ok(!validateRenderRequest(wireFixture({ viewport: { widthCssPx: 100, heightCssPx: 600, deviceScaleFactor: 1 } })).ok);
  // 未知字段
  assert.ok(!validateRenderRequest(wireFixture({ url: "https://evil.example" })).ok);
  // 闭集 mime 外
  assert.ok(
    !validateRenderRequest(
      wireFixture({ resources: [{ key: "reference-1", mime: "image/gif", sha256: "a".repeat(64), dataBase64: "AAA" }] }),
    ).ok,
  );
});

test("worker model-input validator mirrors renderer numeric closed sets", () => {
  const base = {
    schemaVersion: 1,
    htmlArtifactId: "art-html-1",
    resourceArtifactIds: [],
    viewport: { widthCssPx: 800, heightCssPx: 600, deviceScaleFactor: 2 },
    capture: { mode: "full_page" },
    background: "transparent",
  };
  assert.ok(validateRenderHtmlInput(base).ok);
  assert.ok(!validateRenderHtmlInput({ ...base, viewport: { ...base.viewport, widthCssPx: 9999 } }).ok);
  assert.ok(!validateRenderHtmlInput({ ...base, capture: { mode: "viewport", sliceHeightCssPx: 500 } }).ok);
  assert.ok(!validateRenderHtmlInput({ ...base, capture: { mode: "full_page_and_slices" } }).ok);
});
