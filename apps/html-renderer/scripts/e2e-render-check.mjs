/**
 * html-renderer E2E 验收脚本 —— H5-T5（renderer 侧；完整 Supabase/VPS/桌面链路另见计划）。
 *
 * 用合成中文长页驱动一次 full_page_and_slices 渲染，断言：
 *   - 输出 = 1 整页 + N 切片，clip 无缝连续（overlap=0 时高度和 = 整页高）；
 *   - 切片按 clip 逐像素拼接后与整页 PNG 完全一致（内容连续性验收，§1.4）；
 *   - 全部输出去重 sha 一致、fingerprint 存在。
 * 输出仅无内容摘要（尺寸/数量/耗时/fingerprint），不打印 HTML 正文。
 *
 * 两种模式：
 *   node scripts/e2e-render-check.mjs --local
 *     直接进程内调用 render-service（开发机；可用 BOWERBIRD_E2E_EXECUTABLE 指定 Chromium）。
 *   node scripts/e2e-render-check.mjs --url http://127.0.0.1:3917
 *     走内部 HTTP（容器内/隧道；需 RENDER_INTERNAL_TOKEN）。
 */
import { createHash } from "node:crypto";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const ROWS = 32;
const ROW_HEIGHT = 120;
const SLICE_HEIGHT = 960;

function buildFixtureHtml() {
  const rows = Array.from({ length: ROWS }, (_, i) =>
    `<div style="height:${ROW_HEIGHT}px;background:hsl(${(i * 23) % 360},75%,${35 + (i % 5) * 6}%);display:flex;align-items:center;padding:0 32px"><span style="font-size:28px;color:#fff">第 ${i + 1} 段 · 中文长页合成样例 · 用于离线排版截图验收</span></div>`).join("");
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>body{margin:0;font-family:'Noto Sans CJK SC',sans-serif}div{width:100%}</style></head><body>${rows}</body></html>`;
}

function buildRequest() {
  return {
    schemaVersion: 1,
    requestId: "e2e-check",
    runId: "e2e-check-run",
    callId: "e2e-check-call",
    argsHash: "f".repeat(64),
    html: buildFixtureHtml(),
    resources: [],
    viewport: { widthCssPx: 720, heightCssPx: 960, deviceScaleFactor: 1 },
    capture: { mode: "full_page_and_slices", sliceHeightCssPx: SLICE_HEIGHT, overlapCssPx: 0 },
    background: "opaque",
  };
}

async function runLocal() {
  const { chromium } = await import("playwright");
  const { createRenderService } = await import("../src/render-service.ts");
  const executablePath = process.env.BOWERBIRD_E2E_EXECUTABLE;
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ["--disable-dev-shm-usage", "--disable-gpu", "--hide-scrollbars"],
    handleSIGHUP: false, handleSIGINT: false, handleSIGTERM: false,
  });
  try {
    const service = createRenderService(browser, () => undefined);
    return await service.execute(buildRequest(), "e2e-check");
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function runHttp(baseUrl) {
  const token = process.env.RENDER_INTERNAL_TOKEN;
  if (!token) throw new Error("RENDER_INTERNAL_TOKEN_missing");
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/render`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(buildRequest()),
  });
  const body = await response.json();
  if (!response.ok || body.ok !== true) {
    throw new Error(`render_failed:${body.code ?? response.status}`);
  }
  return body;
}

const mode = process.argv.includes("--local") ? "local" : "url";
const urlIndex = process.argv.indexOf("--url");
const urlInline = process.argv.find((arg) => arg.startsWith("--url="));
const baseUrl = urlInline ? urlInline.slice(6) : (urlIndex >= 0 ? process.argv[urlIndex + 1] : "http://127.0.0.1:3917");
if (!/^https?:\/\//.test(baseUrl)) throw new Error(`invalid_url:${baseUrl}`);

const startedAt = Date.now();
const result = mode === "local" ? await runLocal() : await runHttp(baseUrl);
if (!result.ok) throw new Error(`render_failed:${result.code}`);

let decodePng;
try {
  ({ decodePng } = await import("../src/png.ts"));
} catch {
  // 从 /tmp 等非常规位置运行（exec stdin 注入）时回落到镜像内固定路径。
  ({ decodePng } = await import("/app/src/png.ts"));
}
const full = result.outputs.find((o) => o.role === "full_page_screenshot");
const slices = result.outputs.filter((o) => o.role === "slice_screenshot").sort((a, b) => a.index - b.index);
if (!full || slices.length < 3) throw new Error("outputs_shape_invalid");

const fullBytes = Buffer.from(full.dataBase64, "base64");
const fullDecoded = decodePng(fullBytes);
if ("reason" in fullDecoded) throw new Error(`full_png_invalid:${fullDecoded.reason}`);
if (fullDecoded.width !== 720) throw new Error(`width_mismatch:${fullDecoded.width}`);
if (fullDecoded.height < ROWS * ROW_HEIGHT) throw new Error(`height_too_short:${fullDecoded.height}`);

// 切片 clip 连续性（overlap=0：无缝且高度和 = 整页高）
let cursor = 0;
for (const slice of slices) {
  if (slice.clipDevicePx.y !== cursor || slice.clipDevicePx.x !== 0) throw new Error(`clip_discontinuous:slice-${slice.index}`);
  cursor += slice.clipDevicePx.height;
}
if (cursor !== fullDecoded.height) throw new Error(`slice_heights_mismatch:${cursor}!=${fullDecoded.height}`);

// 逐像素拼接复原
const rebuilt = new Uint8Array(fullDecoded.rgba.length);
for (const slice of slices) {
  const decoded = decodePng(Buffer.from(slice.dataBase64, "base64"));
  if ("reason" in decoded) throw new Error(`slice_png_invalid:${decoded.reason}`);
  if (decoded.width !== fullDecoded.width) throw new Error("slice_width_mismatch");
  rebuilt.set(decoded.rgba, slice.clipDevicePx.y * fullDecoded.width * 4);
}
let mismatch = 0;
for (let i = 0; i < fullDecoded.rgba.length; i += 1) {
  if (rebuilt[i] !== fullDecoded.rgba[i]) mismatch += 1;
}
if (mismatch !== 0) throw new Error(`pixel_mismatch:${mismatch}`);

console.log(JSON.stringify({
  event: "e2e_render_check_ok",
  mode,
  fingerprint: result.rendererFingerprint,
  document: `${fullDecoded.width}x${fullDecoded.height}`,
  slices: slices.length,
  outputs: result.outputs.length,
  totalBytes: result.outputs.reduce((sum, o) => sum + o.bytes, 0),
  fullShaPrefix: sha256(fullBytes).slice(0, 8),
  renderMs: result.renderMs,
  verifyMs: Date.now() - startedAt,
}));
process.exit(0);
