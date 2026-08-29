import { createHash } from "node:crypto";

const rendererUrl = (process.env.RENDERER_URL ?? "http://html-renderer:3917").replace(/\/+$/, "");
const token = process.env.RENDER_INTERNAL_TOKEN;
const runCount = Number(process.env.H0_RUNS ?? "100");

if (!token || token.length < 32) throw new Error("RENDER_INTERNAL_TOKEN_missing");
if (!Number.isInteger(runCount) || runCount < 1) throw new Error("H0_RUNS_invalid");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const samplePngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const samplePng = Buffer.from(samplePngBase64, "base64");
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function fixture(index) {
  const variant = index % 20;
  const repeated = Array.from({ length: variant === 7 || variant === 17 ? 36 : 4 }, (_, i) => `<p>第 ${i + 1} 段：中文字体、标点与 12345 ABCDE 的稳定排版。</p>`).join("");
  const useImage = variant === 5 || variant === 15;
  const mode = variant % 3 === 0 ? "viewport" : variant % 3 === 1 ? "full_page" : "full_page_and_slices";
  const capture = mode === "full_page_and_slices"
    ? { mode, sliceHeightCssPx: 420 + (variant % 4) * 40, overlapCssPx: 0 }
    : { mode };
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:"Noto Sans CJK SC",sans-serif;color:#172033;background:${variant % 2 ? "#f5f7fb" : "transparent"};padding:24px}
    .layout{display:${variant % 4 === 0 ? "grid" : "flex"};grid-template-columns:repeat(2,1fr);flex-direction:column;gap:12px}
    .card{padding:16px;border:1px solid #ccd3df;border-radius:8px;background:#fff}
    h1{font-size:${28 + (variant % 5) * 2}px;margin:0 0 16px} p{line-height:1.6;margin:6px 0}
    table{width:100%;border-collapse:collapse} td,th{border:1px solid #ccd3df;padding:8px;text-align:left}
  </style></head><body><main class="layout"><section class="card"><h1>合成排版样本 ${variant + 1}</h1>${useImage ? '<img src="asset:reference-1" alt="合成像素">' : ""}${repeated}</section><section class="card"><table><thead><tr><th>项目</th><th>值</th></tr></thead><tbody><tr><td>网格 / Flex</td><td>${variant}</td></tr><tr><td>DPR</td><td>${variant % 5 === 0 ? 2 : 1}</td></tr></tbody></table></section></main></body></html>`;
  const resources = useImage
    ? [{ key: "reference-1", mime: "image/png", sha256: sha256(samplePng), dataBase64: samplePngBase64 }]
    : [];
  return {
    html,
    resources,
    viewport: { widthCssPx: 720 + (variant % 4) * 80, heightCssPx: 640, deviceScaleFactor: variant % 5 === 0 ? 2 : 1 },
    capture,
    background: variant % 2 ? "opaque" : "transparent",
  };
}

async function health() {
  const response = await fetch(`${rendererUrl}/healthz`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`health_${response.status}`);
  return await response.json();
}

const before = await health();
const wallTimes = [];
const renderTimes = [];
let outputBytes = 0;
let outputCount = 0;
let fingerprint = "";

for (let i = 0; i < runCount; i += 1) {
  const item = fixture(i);
  const id = `h0-${String(i + 1).padStart(4, "0")}`;
  const argsHash = sha256(JSON.stringify(item));
  const request = { schemaVersion: 1, requestId: id, runId: id, callId: `${id}-render`, argsHash, ...item };
  const started = performance.now();
  const response = await fetch(`${rendererUrl}/render`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(40_000),
  });
  const result = await response.json();
  wallTimes.push(performance.now() - started);
  if (!response.ok || result.ok !== true) throw new Error(`render_${i + 1}_${response.status}_${result.code ?? "invalid"}`);
  if (result.runId !== id || result.callId !== `${id}-render` || result.argsHash !== argsHash) throw new Error(`echo_${i + 1}`);
  if (fingerprint && result.rendererFingerprint !== fingerprint) throw new Error(`fingerprint_changed_${i + 1}`);
  fingerprint = result.rendererFingerprint;
  renderTimes.push(result.renderMs);
  for (const output of result.outputs) {
    const bytes = Buffer.from(output.dataBase64, "base64");
    if (!bytes.subarray(0, 8).equals(pngSignature)) throw new Error(`png_signature_${i + 1}`);
    if (bytes.length !== output.bytes || sha256(bytes) !== output.sha256) throw new Error(`png_integrity_${i + 1}`);
    outputBytes += bytes.length;
    outputCount += 1;
  }
}

const after = await health();
let outboundBlocked = false;
try {
  await fetch("https://example.com", { signal: AbortSignal.timeout(2_000) });
} catch {
  outboundBlocked = true;
}
if (!outboundBlocked) throw new Error("probe_container_outbound_not_blocked");

console.log(JSON.stringify({
  ok: true,
  fixtureCount: 20,
  runCount,
  rendererFingerprint: fingerprint,
  chromiumVersion: after.chromiumVersion,
  renderedDelta: after.renderedCount - before.renderedCount,
  failedDelta: after.failedCount - before.failedCount,
  outputCount,
  outputBytes,
  wallMs: { min: Math.min(...wallTimes), p50: percentile(wallTimes, 0.5), p95: percentile(wallTimes, 0.95), max: Math.max(...wallTimes) },
  renderMs: { min: Math.min(...renderTimes), p50: percentile(renderTimes, 0.5), p95: percentile(renderTimes, 0.95), max: Math.max(...renderTimes) },
  probeContainerOutboundBlocked: outboundBlocked,
}));
