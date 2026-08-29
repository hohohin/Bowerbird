/**
 * Playwright 实机 e2e（本地/容器均可跑；未安装 Chromium 时整体 skip）。
 * 覆盖 H1 验收的核心断言：
 *   - viewport / full_page 渲染产出可验证 PNG；
 *   - 默认无重叠切片可从同一整页像素结果**逐像素复原**；
 *   - 透明背景输出带 α 通道；
 *   - 资源表闭集在真实浏览器链路生效；
 *   - 恶意/坏输入在 sanitizer 与 service 层 fail closed。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import { CHROMIUM_LAUNCH_OPTIONS, launchRendererBrowser, renderDocument } from "./renderer.ts";
import { createRenderService } from "./render-service.ts";
import { decodePng, encodePng } from "./png.ts";
import type { InternalRenderRequest } from "./contracts.ts";

let browser: Browser | undefined;
let browserError = "";

// 本地回退：官方 CDN 不可达时可用 BOWERBIRD_E2E_EXECUTABLE 指向已存在的 Chromium
// （协议兼容性尽力而为，仅本地开发信号；生产容器内始终是钉版 revision）。
const fallbackExecutable = process.env.BOWERBIRD_E2E_EXECUTABLE;

try {
  browser = await launchRendererBrowser();
} catch (error) {
  browserError = error instanceof Error ? error.message : String(error);
  if (fallbackExecutable) {
    try {
      browser = await chromium.launch({ executablePath: fallbackExecutable, args: ["--disable-dev-shm-usage", "--disable-gpu", "--hide-scrollbars"], handleSIGHUP: false, handleSIGINT: false, handleSIGTERM: false });
      browserError = "";
    } catch (fallbackError) {
      browserError = `${browserError} | fallback: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`;
    }
  }
}

const skipReason = browser ? false : `chromium unavailable: ${browserError.slice(0, 120)}`;

test("Chromium sandbox is explicitly enabled", () => {
  assert.equal(CHROMIUM_LAUNCH_OPTIONS.chromiumSandbox, true);
  assert.ok(!(CHROMIUM_LAUNCH_OPTIONS.args ?? []).includes("--no-sandbox"));
});

function makeRequest(overrides: Partial<InternalRenderRequest> & { html: string; resources?: InternalRenderRequest["resources"] }): InternalRenderRequest {
  return {
    schemaVersion: 1,
    requestId: "e2e-req",
    runId: "e2e-run",
    callId: "e2e-call",
    argsHash: "f".repeat(64),
    resources: [],
    viewport: { widthCssPx: 800, heightCssPx: 600, deviceScaleFactor: 1 },
    capture: { mode: "full_page" },
    background: "opaque",
    ...overrides,
  };
}

test("viewport render: zh poster produces valid png at viewport dims", { skip: skipReason }, async () => {
  assert.ok(browser);
  const html = '<!DOCTYPE html><html><head><style>body{margin:0}.poster{width:800px;height:600px;background:#ff5533;color:#fff;font-size:48px;display:flex;align-items:center;justify-content:center}</style></head><body><div class="poster">中文海报标题</div></body></html>';
  const result = await renderDocument(browser, {
    html,
    resources: new Map(),
    referencedResourceKeys: new Set(),
    viewport: { widthCssPx: 800, heightCssPx: 600, deviceScaleFactor: 1 },
    capture: { mode: "viewport" },
    background: "opaque",
    timeoutMs: 30_000,
  });
  assert.ok(!("code" in result), `render failed: ${JSON.stringify(result)}`);
  const ok = result as Extract<typeof result, { basePng: Uint8Array }>;
  assert.equal(ok.baseRole, "viewport_screenshot");
  const decoded = decodePng(ok.basePng);
  assert.ok(!("reason" in decoded));
  const d = decoded as { width: number; height: number; rgba: Uint8Array };
  assert.equal(d.width, 800);
  assert.equal(d.height, 600);
  // 中心像素应为海报橙红（字体反锯齿不影响大片纯色区域）
  const center = (300 * 800 + 400) * 4;
  assert.equal(d.rgba[center], 0xff);
  assert.equal(d.rgba[center + 1], 0x55);
  assert.equal(d.rgba[center + 2], 0x33);
  assert.equal(d.rgba[center + 3], 255);
});

test("full_page render: tall document height follows content", { skip: skipReason }, async () => {
  assert.ok(browser);
  const html = '<html><head><style>.col{width:100px;height:2600px;background:#3366cc}</style></head><body><div class="col"></div></body></html>';
  const result = await renderDocument(browser, {
    html,
    resources: new Map(),
    referencedResourceKeys: new Set(),
    viewport: { widthCssPx: 400, heightCssPx: 400, deviceScaleFactor: 1 },
    capture: { mode: "full_page" },
    background: "opaque",
    timeoutMs: 30_000,
  });
  assert.ok(!("code" in result));
  const ok = result as Extract<typeof result, { basePng: Uint8Array; documentDeviceHeight: number }>;
  const decoded = decodePng(ok.basePng) as { height: number };
  assert.ok(decoded.height >= 2600, `expected >=2600, got ${decoded.height}`);
  assert.equal(ok.documentDeviceHeight, decoded.height);
});

test("transparent background yields alpha channel with transparent corner", { skip: skipReason }, async () => {
  assert.ok(browser);
  const html = '<html><body><div style="width:200px;height:100px;background:#123456"></div></body></html>';
  const result = await renderDocument(browser, {
    html,
    resources: new Map(),
    referencedResourceKeys: new Set(),
    viewport: { widthCssPx: 300, heightCssPx: 200, deviceScaleFactor: 1 },
    capture: { mode: "viewport" },
    background: "transparent",
    timeoutMs: 30_000,
  });
  assert.ok(!("code" in result));
  const ok = result as Extract<typeof result, { basePng: Uint8Array }>;
  const decoded = decodePng(ok.basePng) as { colorType: number; rgba: Uint8Array };
  assert.equal(decoded.colorType, 6, "transparent capture must keep alpha");
  const corner = (0 * 300 + 250) * 4; // 右上角，div 之外
  assert.equal(decoded.rgba[corner + 3], 0, "outside div must be transparent");
});

test("resource table: img from asset ref renders and closed set is enforced by service", { skip: skipReason }, async () => {
  assert.ok(browser);
  const tile = encodePng({ width: 16, height: 16, rgba: new Uint8Array(16 * 16 * 4).fill(0).map((_, i) => (i % 4 === 3 ? 255 : 60)) });
  const sha = createHash("sha256").update(tile).digest("hex");
  const service = createRenderService(browser, () => undefined);
  const request = makeRequest({
    html: '<html><body><img src="asset:tile-1" width="16" height="16"></body></html>',
    resources: [{ key: "tile-1", mime: "image/png", sha256: sha, dataBase64: Buffer.from(tile).toString("base64") }],
  });
  const result = await service.execute(request, "e2e-req");
  assert.ok(result.ok, `resource render failed: ${JSON.stringify(result.ok ? "" : result)}`);
  assert.equal(result.document.widthDevicePx >= 16, true);

  // 引用不存在的资源 → fail closed
  const missing = await service.execute(makeRequest({ html: '<html><body><img src="asset:missing-1"></body></html>' }), "e2e-req2");
  assert.ok(!missing.ok);
  assert.equal(missing.code, "render_resource_invalid");

  // sha 不匹配 → fail closed
  const badSha = "0".repeat(64);
  const corrupted = await service.execute(
    makeRequest({ html: '<html><body><img src="asset:tile-1"></body></html>', resources: [{ key: "tile-1", mime: "image/png", sha256: badSha, dataBase64: Buffer.from(tile).toString("base64") }] }),
    "e2e-req3",
  );
  assert.ok(!corrupted.ok);
  assert.equal(corrupted.code, "render_resource_invalid");
});

test("service: sanitizer rejections never reach the browser", { skip: skipReason }, async () => {
  assert.ok(browser);
  const service = createRenderService(browser, () => undefined);
  const script = await service.execute(makeRequest({ html: "<html><body><script>alert(1)</script></body></html>" }), "e2e-x1");
  assert.ok(!script.ok);
  assert.equal(script.code, "render_html_unsafe");

  const externalUrl = await service.execute(makeRequest({ html: '<html><body style="background:url(https://evil.example/x.png)">x</body></html>' }), "e2e-x2");
  assert.ok(!externalUrl.ok);
  assert.equal(externalUrl.code, "render_html_unsafe");

  const unknownField = await service.execute({ schemaVersion: 1, requestId: "r", runId: "u", callId: "c", argsHash: "0".repeat(64), html: "<p>x</p>", resources: [], viewport: { widthCssPx: 800, heightCssPx: 600, deviceScaleFactor: 1 }, capture: { mode: "full_page", extra: true }, background: "opaque" }, "e2e-x3");
  assert.ok(!unknownField.ok);
  assert.equal(unknownField.code, "render_input_invalid");
});

test("slices: full_page_and_slices reconstructs the full page pixel-exactly", { skip: skipReason }, async () => {
  assert.ok(browser);
  const rows = Array.from({ length: 26 }, (_, i) => `<div style="height:100px;background:hsl(${(i * 14) % 360},80%,55%)"></div>`).join("");
  const html = `<!DOCTYPE html><html><head><style>body{margin:0}div{width:400px}</style></head><body>${rows}</body></html>`;
  const service = createRenderService(browser, () => undefined);
  const result = await service.execute(
    makeRequest({
      html,
      viewport: { widthCssPx: 400, heightCssPx: 500, deviceScaleFactor: 1 },
      capture: { mode: "full_page_and_slices", sliceHeightCssPx: 1000 },
    }),
    "e2e-slices",
  );
  assert.ok(result.ok, `slice render failed: ${JSON.stringify(result.ok ? "" : result)}`);
  if (!result.ok) return;
  const full = result.outputs.find((o) => o.role === "full_page_screenshot")!;
  const slices = result.outputs.filter((o) => o.role === "slice_screenshot").sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  assert.ok(slices.length >= 2, `expected multiple slices, got ${slices.length}`);
  assert.equal(result.document.heightDevicePx >= 2600, true);

  const fullDecoded = decodePng(Buffer.from(full.dataBase64, "base64")) as { width: number; height: number; rgba: Uint8Array };
  const width = fullDecoded.width;
  // 逐像素复原：切片行拼接后与整页 rgba 完全一致
  const rebuilt = new Uint8Array(fullDecoded.rgba.length);
  let offset = 0;
  for (const slice of slices) {
    assert.equal(slice.clipDevicePx.width, width);
    assert.equal(slice.clipDevicePx.x, 0);
    const decoded = decodePng(Buffer.from(slice.dataBase64, "base64")) as { height: number; rgba: Uint8Array };
    const expectedY = slice.clipDevicePx.y;
    rebuilt.set(decoded.rgba, expectedY * width * 4);
    offset += decoded.height;
  }
  assert.equal(offset, fullDecoded.height, "slice heights must sum to full height (overlap=0)");
  assert.deepEqual(rebuilt, fullDecoded.rgba, "slices must reconstruct the full page pixel-exactly");
  // manifest 记录 clip（§2.3）
  for (const slice of slices) {
    assert.ok(slice.clipDevicePx.height > 0);
    assert.ok(slice.index! >= 1);
  }
});

test("browser version reachable for fingerprint", { skip: skipReason }, async () => {
  assert.ok(browser);
  const version = browser.version();
  assert.match(version, /^\d+\.\d+\.\d+\.\d+/);
});

test("chromium executable pinned via playwright package", () => {
  // 非 e2e：仅验证 playwright 依赖可解析（未装浏览器时本测试仍应通过）
  const path = chromium.executablePath();
  assert.equal(typeof path, "string");
});

after(async () => {
  await browser?.close().catch(() => undefined);
});
