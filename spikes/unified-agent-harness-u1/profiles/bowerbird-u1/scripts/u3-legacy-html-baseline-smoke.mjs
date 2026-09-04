import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { DeepSeekBackend } from "../../../../../apps/agent-worker/src/providers/deepseek/backend.ts";
import { composeHtmlDocumentWithModel } from "../../../../../apps/agent-worker/src/skills/bowerbird-html-layout-render/model-turn.ts";
import { validateHtmlLayoutRenderInput } from "../../../../../apps/agent-worker/src/skills/bowerbird-html-layout-render/schemas.ts";
import { createRenderService } from "../../../../../apps/html-renderer/src/render-service.ts";

const REAL_BASELINE_FLAG = "--allow-real-u3-legacy-baseline";
const REPO_ROOT = join(import.meta.dirname, "../../../../../");
const PRODUCT_PATH = join(REPO_ROOT, "apps/desktop/src-tauri/resources/samples/preset-01.webp");
const STYLE_PATH = join(REPO_ROOT, "apps/desktop/src-tauri/resources/samples/preset-11.webp");
const DEFAULT_OUTPUT_ROOT = join(REPO_ROOT, "spikes/unified-agent-harness-u1/results/u3-html-baseline");

function required(value, name) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name}_missing`);
  return normalized;
}

function sha256(bytesOrText) {
  return createHash("sha256").update(bytesOrText).digest("hex");
}

function outputRoot(argv) {
  const option = argv.find((value) => value.startsWith("--output-dir="));
  return option ? join(process.cwd(), option.slice("--output-dir=".length)) : DEFAULT_OUTPUT_ROOT;
}

function findChromiumExecutable(env) {
  const candidates = [
    env.BOWERBIRD_E2E_EXECUTABLE,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

function baselineInput() {
  const product = new Uint8Array(readFileSync(PRODUCT_PATH));
  const style = new Uint8Array(readFileSync(STYLE_PATH));
  return validateHtmlLayoutRenderInput({
    schemaVersion: 1,
    layoutPrompt: "为紫白色双罐护理产品制作 1080px 宽 HTML 长图。用户推文：『双罐悬浮，紫白未来感；一眼看见包装、质感和展示方式。』第 1 张是产品图且是唯一产品事实来源；第 2 张仅是排版参考，只参考大字与留白节奏，不展示原图。禁止新增功效、成分、品类、品牌、认证或购买事实。",
    references: [
      {
        artifactId: "asset-product",
        token: "产品图（唯一产品事实来源）",
        ordinal: 1,
        mime: "image/webp",
        bytes: product.byteLength,
        sha256: sha256(product),
      },
      {
        artifactId: "asset-typography-style",
        token: "排版参考（只参考大字和留白，不展示）",
        ordinal: 2,
        mime: "image/webp",
        bytes: style.byteLength,
        sha256: sha256(style),
      },
    ],
    viewport: { widthCssPx: 1080, heightCssPx: 900, deviceScaleFactor: 1 },
    capture: { mode: "full_page_and_slices", sliceHeightCssPx: 1080, overlapCssPx: 0 },
    background: "opaque",
  });
}

async function launchBrowser(env) {
  const require = createRequire(join(REPO_ROOT, "apps/html-renderer/package.json"));
  const { chromium } = require("playwright");
  const executablePath = findChromiumExecutable(env);
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    headless: true,
    args: ["--disable-dev-shm-usage", "--disable-gpu", "--force-color-profile=srgb", "--hide-scrollbars"],
    handleSIGHUP: false,
    handleSIGINT: false,
    handleSIGTERM: false,
  });
  return { browser, executablePath: executablePath ?? "playwright-managed" };
}

function safeUsage(usage) {
  return {
    promptTokens: Number.isInteger(usage?.promptTokens) ? usage.promptTokens : 0,
    completionTokens: Number.isInteger(usage?.completionTokens) ? usage.completionTokens : 0,
    totalTokens: Number.isInteger(usage?.totalTokens) ? usage.totalTokens : 0,
    upstreamElapsedMs: Number.isInteger(usage?.upstreamElapsedMs) ? usage.upstreamElapsedMs : null,
  };
}

export async function runU3LegacyHtmlBaselineSmoke({ argv = process.argv, env = process.env } = {}) {
  if (!argv.includes(REAL_BASELINE_FLAG)) throw new Error("real_u3_legacy_baseline_flag_required");
  if (env.BOWERBIRD_U1_ALLOW_NETWORK !== "1") throw new Error("BOWERBIRD_U1_ALLOW_NETWORK_required");
  const apiKey = required(env.DEEPSEEK_API_KEY, "DEEPSEEK_API_KEY");
  const modelName = (env.DEEPSEEK_MODEL || "deepseek-v4-flash").trim();
  const runId = `run-u3-legacy-${randomUUID()}`;
  const outputDir = join(outputRoot(argv), runId);
  mkdirSync(outputDir, { recursive: true });
  const input = baselineInput();
  const providerTurns = [];
  const backend = new DeepSeekBackend({
    apiKey,
    baseUrl: (env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, ""),
    model: modelName,
    timeoutMs: 120_000,
  });
  const model = {
    id: backend.id,
    async turn(request, signal) {
      const startedAt = Date.now();
      const result = await backend.turn(request, signal);
      providerTurns.push({ durationMs: Date.now() - startedAt, usage: safeUsage(result.providerUsage) });
      return result;
    },
  };
  const startedAt = Date.now();
  let browser;
  try {
    const composeStartedAt = Date.now();
    const action = await composeHtmlDocumentWithModel({ runId, input, model });
    const composeMs = Date.now() - composeStartedAt;
    const htmlPath = join(outputDir, "baseline.html");
    writeFileSync(htmlPath, action.html, "utf8");

    const launched = await launchBrowser(env);
    browser = launched.browser;
    const logs = [];
    const service = createRenderService(browser, (event) => logs.push(event));
    const product = new Uint8Array(readFileSync(PRODUCT_PATH));
    const style = new Uint8Array(readFileSync(STYLE_PATH));
    const callId = `call-${randomUUID()}`;
    const argsHash = sha256(JSON.stringify({ runId, callId, html: sha256(action.html) }));
    const rendered = await service.execute({
      schemaVersion: 1,
      requestId: `request-${randomUUID()}`,
      runId,
      callId,
      argsHash,
      html: action.html,
      resources: [
        { key: "reference-1", mime: "image/webp", sha256: sha256(product), dataBase64: Buffer.from(product).toString("base64") },
        { key: "reference-2", mime: "image/webp", sha256: sha256(style), dataBase64: Buffer.from(style).toString("base64") },
      ],
      viewport: input.viewport,
      capture: input.capture,
      background: input.background,
    }, runId);
    if (!rendered.ok) throw new Error(rendered.code);
    const outputs = [];
    for (const item of rendered.outputs) {
      const suffix = item.role === "slice_screenshot" ? `-${String(item.index).padStart(4, "0")}` : "";
      const filePath = join(outputDir, `${item.role}${suffix}.png`);
      writeFileSync(filePath, Buffer.from(item.dataBase64, "base64"));
      outputs.push({
        role: item.role,
        ...(item.index ? { index: item.index } : {}),
        filePath,
        clipDevicePx: item.clipDevicePx,
        bytes: item.bytes,
        sha256: item.sha256,
      });
    }
    const manifest = {
      schemaVersion: rendered.schemaVersion,
      rendererFingerprint: rendered.rendererFingerprint,
      sourceHtmlSha256: rendered.sourceHtmlSha256,
      document: rendered.document,
      renderMs: rendered.renderMs,
      outputs: outputs.map(({ filePath: _filePath, ...item }) => item),
    };
    const manifestPath = join(outputDir, "manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const primary = outputs.find((item) => item.role === "full_page_screenshot")?.filePath;
    assert.ok(primary);
    const report = {
      ok: true,
      baseline: "bowerbird-html-layout-render@0.1.0",
      real: { deepSeek: true, renderer: true, arkVision: false },
      runId,
      timing: { totalMs: Date.now() - startedAt, composeMs, rendererMs: rendered.renderMs },
      usage: {
        deepSeekTurns: providerTurns.length,
        deepSeekInputTokens: providerTurns.reduce((sum, turn) => sum + turn.usage.promptTokens, 0),
        deepSeekOutputTokens: providerTurns.reduce((sum, turn) => sum + turn.usage.completionTokens, 0),
        arkVisionCalls: 0,
        htmlRenderCalls: 1,
        actualCredits: providerTurns.length,
      },
      renderer: { fingerprint: rendered.rendererFingerprint, chromiumVersion: browser.version(), executable: launched.executablePath },
      document: rendered.document,
      artifacts: { html: htmlPath, manifest: manifestPath, primary, visible: outputs.map((item) => item.filePath) },
      providerTurns,
      secretsStayedInParent: { deepSeek: true },
      deployed: false,
    };
    const reportPath = join(outputDir, "report.json");
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return { ...report, reportPath };
  } catch (error) {
    const safeErrorCode = error instanceof Error && /^[A-Za-z0-9 ._():-]{1,200}$/.test(error.message)
      ? error.message
      : "u3_legacy_html_baseline_failed";
    const failure = {
      ok: false,
      runId,
      safeErrorCode,
      elapsedMs: Date.now() - startedAt,
      usage: {
        deepSeekTurns: providerTurns.length,
        deepSeekInputTokens: providerTurns.reduce((sum, turn) => sum + turn.usage.promptTokens, 0),
        deepSeekOutputTokens: providerTurns.reduce((sum, turn) => sum + turn.usage.completionTokens, 0),
      },
      deployed: false,
    };
    const failurePath = join(outputDir, "failure-report.json");
    writeFileSync(failurePath, `${JSON.stringify(failure, null, 2)}\n`, "utf8");
    throw new Error(`u3_legacy_html_baseline_failed:${JSON.stringify({ ...failure, failurePath })}`);
  } finally {
    await browser?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runU3LegacyHtmlBaselineSmoke();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
