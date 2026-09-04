import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createRenderService } from "../../../../../apps/html-renderer/src/render-service.ts";
import { sanitizeHtml } from "../../../../../apps/html-renderer/src/sanitizer.ts";

const REPO_ROOT = join(import.meta.dirname, "../../../../../");
const PRODUCT_PATH = join(REPO_ROOT, "apps/desktop/src-tauri/resources/samples/preset-01.webp");
const STYLE_PATH = join(REPO_ROOT, "apps/desktop/src-tauri/resources/samples/preset-11.webp");

function sha256(bytesOrText) {
  return createHash("sha256").update(bytesOrText).digest("hex");
}

function option(argv, name) {
  const prefix = `--${name}=`;
  const value = argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`${name.replaceAll("-", "_")}_required`);
  return value;
}

function findChromiumExecutable(env) {
  const candidates = [
    env.BOWERBIRD_E2E_EXECUTABLE,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
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

async function render(service, { runId, html, resources, viewport, capture }) {
  const callId = `call-${randomUUID()}`;
  const result = await service.execute({
    schemaVersion: 1,
    requestId: `request-${randomUUID()}`,
    runId,
    callId,
    argsHash: sha256(JSON.stringify({ runId, callId, html: sha256(html) })),
    html,
    resources,
    viewport,
    capture,
    background: "opaque",
  }, runId);
  assert.equal(result.ok, true, result.ok ? undefined : result.code);
  return result;
}

function pngResource(key, bytes) {
  return { key, mime: "image/png", sha256: sha256(bytes), dataBase64: Buffer.from(bytes).toString("base64") };
}

function imageResource(key, mime, bytes) {
  return { key, mime, sha256: sha256(bytes), dataBase64: Buffer.from(bytes).toString("base64") };
}

function saveOutputs(outputDir, prefix, result) {
  const saved = [];
  for (const item of result.outputs) {
    const suffix = item.role === "slice_screenshot" ? `-${String(item.index).padStart(4, "0")}` : "";
    const filePath = join(outputDir, `${prefix}-${item.role}${suffix}.png`);
    writeFileSync(filePath, Buffer.from(item.dataBase64, "base64"));
    saved.push({ role: item.role, index: item.index ?? null, filePath, sha256: item.sha256, bytes: item.bytes });
  }
  return saved;
}

export async function buildU3BlindComparison({ argv = process.argv, env = process.env } = {}) {
  const baselineDir = resolve(process.cwd(), option(argv, "baseline-dir"));
  const candidateReportPath = resolve(process.cwd(), option(argv, "candidate-report"));
  const outputDir = resolve(process.cwd(), option(argv, "output-dir"));
  mkdirSync(outputDir, { recursive: true });

  const originalHtmlPath = join(baselineDir, "baseline.html");
  const originalHtml = readFileSync(originalHtmlPath, "utf8");
  const comments = [...originalHtml.matchAll(/\/\*[\s\S]*?\*\//g)];
  assert.ok(comments.length > 0, "expected_css_comment_missing");
  const salvagedHtml = originalHtml.replace(/\/\*[\s\S]*?\*\//g, "");
  const sanitized = sanitizeHtml(salvagedHtml);
  assert.equal(sanitized.ok, true, sanitized.ok ? undefined : `${sanitized.code}:${sanitized.reason}`);
  const salvagedHtmlPath = join(outputDir, "legacy-visual-salvage.html");
  writeFileSync(salvagedHtmlPath, salvagedHtml, "utf8");

  const candidateReport = JSON.parse(readFileSync(candidateReportPath, "utf8"));
  assert.equal(candidateReport.ok, true);
  const candidatePath = candidateReport.artifacts.primary;
  const product = new Uint8Array(readFileSync(PRODUCT_PATH));
  const style = new Uint8Array(readFileSync(STYLE_PATH));
  const logs = [];
  const launched = await launchBrowser(env);
  try {
    const service = createRenderService(launched.browser, (event) => logs.push(event));
    const baselineRender = await render(service, {
      runId: `blind-baseline-${randomUUID()}`,
      html: salvagedHtml,
      resources: [
        imageResource("reference-1", "image/webp", product),
        imageResource("reference-2", "image/webp", style),
      ],
      viewport: { widthCssPx: 1080, heightCssPx: 900, deviceScaleFactor: 1 },
      capture: { mode: "full_page_and_slices", sliceHeightCssPx: 1080, overlapCssPx: 0 },
    });
    const baselineOutputs = saveOutputs(outputDir, "legacy-visual-salvage", baselineRender);
    const baselinePath = baselineOutputs.find((item) => item.role === "full_page_screenshot")?.filePath;
    assert.ok(baselinePath);

    const candidateBytes = new Uint8Array(readFileSync(candidatePath));
    const baselineBytes = new Uint8Array(readFileSync(baselinePath));
    const candidateIsA = randomInt(2) === 0;
    const leftBytes = candidateIsA ? candidateBytes : baselineBytes;
    const rightBytes = candidateIsA ? baselineBytes : candidateBytes;
    const contactHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>A/B</title><style>*{box-sizing:border-box}html,body{margin:0;padding:0;background:#d8d8df;font-family:Arial,"Microsoft YaHei",sans-serif}.sheet{display:grid;grid-template-columns:1080px 1080px;align-items:start}.panel{width:1080px;padding:0 15px 20px}.label{height:100px;display:flex;align-items:center;justify-content:center;font-size:56px;font-weight:800;color:#111;background:#fff;border-bottom:4px solid #111}.panel img{display:block;width:1050px;height:auto;background:#fff}</style></head><body><main class="sheet"><section class="panel"><div class="label">A</div><img src="asset:reference-1" alt="A"></section><section class="panel"><div class="label">B</div><img src="asset:reference-2" alt="B"></section></main></body></html>`;
    const contactRender = await render(service, {
      runId: `blind-contact-${randomUUID()}`,
      html: contactHtml,
      resources: [pngResource("reference-1", leftBytes), pngResource("reference-2", rightBytes)],
      viewport: { widthCssPx: 2160, heightCssPx: 900, deviceScaleFactor: 1 },
      capture: { mode: "full_page" },
    });
    const contact = saveOutputs(outputDir, "blind-comparison", contactRender)[0];
    assert.ok(contact?.filePath);

    const nonce = randomBytes(32).toString("hex");
    const mapping = {
      schemaVersion: 1,
      nonce,
      A: candidateIsA ? "unified-u3" : "legacy-visual-salvage",
      B: candidateIsA ? "legacy-visual-salvage" : "unified-u3",
    };
    const commitment = sha256(JSON.stringify(mapping));
    const privateMappingPath = join(outputDir, "blind-mapping.private.json");
    writeFileSync(privateMappingPath, `${JSON.stringify(mapping, null, 2)}\n`, "utf8");
    const publicReport = {
      ok: true,
      comparison: "anonymous-a-b",
      contactSheet: contact.filePath,
      mappingCommitmentSha256: commitment,
      baseline: {
        sourceRunStatus: "failed_renderer_safety",
        sourceFailure: "render_html_unsafe:css_comment_forbidden",
        visualSalvage: "removed CSS comments only; visual semantics unchanged",
        removedCssComments: comments.length,
        document: baselineRender.document,
        renderMs: baselineRender.renderMs,
        primary: baselinePath,
      },
      candidate: { runId: candidateReport.runId, primary: candidatePath },
      privateMappingPath,
      deployed: false,
      externalProviderCalls: 0,
    };
    const reportPath = join(outputDir, "blind-comparison-report.json");
    writeFileSync(reportPath, `${JSON.stringify(publicReport, null, 2)}\n`, "utf8");
    return { ...publicReport, reportPath };
  } finally {
    await launched.browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await buildU3BlindComparison();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
