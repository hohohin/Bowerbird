/**
 * H5-T1 恶意向量安全矩阵 —— HTML-RENDER-PLAN §10「Offline security」行的全量覆盖。
 *
 * 每个向量的断言都落在确定性防线（sanitizer / 契约 / 路由分类 / 资源尺寸防护），
 * 不依赖浏览器行为；容器断网是部署层承诺，由 scripts/verify-container.mjs 在 VPS 上验证。
 * 全部向量必须 fail closed：或被 sanitizer 拒绝（render_html_unsafe）、或被请求契约拒绝
 * （render_input_invalid）、或被路由层 abort、或被资源防护拒绝（render_resource_invalid）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeHtml } from "./sanitizer.ts";
import { classifyRouteRequest } from "./route-policy.ts";
import { validateRenderRequest } from "./contracts.ts";
import { declaredImageDimensions, withinResourceDimensionLimits } from "./image-dimensions.ts";
import { RENDER_LIMITS } from "./limits.ts";

type Vector = {
  vector: string;
  layer: "sanitizer" | "route" | "contract" | "resource";
  expect: string;
  run: () => boolean; // true = 被拦截（fail closed）
};

function sanitizerRejected(html: string, reason?: string): boolean {
  const result = sanitizeHtml(html);
  return !result.ok && (!reason || (result as { reason: string }).reason === reason);
}

function requestRejected(request: Record<string, unknown>): boolean {
  return !validateRenderRequest(request).ok;
}

const BASE_REQUEST: Record<string, unknown> = {
  schemaVersion: 1,
  requestId: "req-matrix",
  runId: "run-matrix",
  callId: "call-matrix",
  argsHash: "a".repeat(64),
  html: "<!DOCTYPE html><html><body><p>布局</p></body></html>",
  resources: [],
  viewport: { widthCssPx: 800, heightCssPx: 600, deviceScaleFactor: 1 },
  capture: { mode: "full_page" },
  background: "opaque",
};

const VECTORS: Vector[] = [
  // —— 公网出口（HTML 与 CSS 双通道）——
  { vector: "公网 https 图片", layer: "sanitizer", expect: "img_src_not_asset_ref", run: () => sanitizerRejected('<img src="https://evil.example/a.png">', "img_src_not_asset_ref") },
  { vector: "协议相对 URL 图片", layer: "sanitizer", expect: "img_src_not_asset_ref", run: () => sanitizerRejected('<img src="//evil.example/a.png">', "img_src_not_asset_ref") },
  { vector: "CSS 公网背景", layer: "sanitizer", expect: "css_url_not_asset_ref", run: () => sanitizerRejected('<style>body{background:url(https://evil.example/bg.png)}</style>', "css_url_not_asset_ref") },
  { vector: "CSS 协议相对背景", layer: "sanitizer", expect: "css_url_not_asset_ref", run: () => sanitizerRejected('<style>body{background:url(//evil.example/bg.png)}</style>', "css_url_not_asset_ref") },
  { vector: "CSS 首页跳转 import", layer: "sanitizer", expect: "css_at_rule_forbidden", run: () => sanitizerRejected('<style>@import url("https://evil.example/x.css");</style>', "css_at_rule_forbidden") },

  // —— localhost / 私网 / 云元数据 / DNS（路由层兜底）——
  { vector: "localhost 请求", layer: "route", expect: "abort", run: () => classifyRouteRequest("http://127.0.0.1:8080/").action === "abort" },
  { vector: "IPv6 回环请求", layer: "route", expect: "abort", run: () => classifyRouteRequest("http://[::1]:8080/").action === "abort" },
  { vector: "私网 10/8", layer: "route", expect: "abort", run: () => classifyRouteRequest("http://10.1.2.3/").action === "abort" },
  { vector: "私网 192.168/16", layer: "route", expect: "abort", run: () => classifyRouteRequest("http://192.168.1.1/router").action === "abort" },
  { vector: "AWS 元数据", layer: "route", expect: "abort", run: () => classifyRouteRequest("http://169.254.169.254/latest/meta-data/").action === "abort" },
  { vector: "GCP 元数据（DNS 名）", layer: "route", expect: "abort", run: () => classifyRouteRequest("http://metadata.google.internal/computeMetadata/v1/").action === "abort" },
  { vector: "任意 DNS 主机", layer: "route", expect: "abort", run: () => classifyRouteRequest("http://dns-exfil.evil.example/").action === "abort" },
  { vector: "非 http scheme（ws/file/data/javascript）", layer: "route", expect: "abort", run: () => ["ws://x/", "wss://x/", "file:///etc/passwd", "data:text/html;base64,PHM", "javascript:alert(1)", "ftp://x/"].every((u) => classifyRouteRequest(u).action === "abort") },

  // —— 重定向（HTML 层唯一入口已被禁；路由层不留可重定向通道）——
  { vector: "meta refresh 跳转", layer: "sanitizer", expect: "attr_not_allowed", run: () => sanitizerRejected('<meta http-equiv="refresh" content="0;url=https://evil.example">', "attr_not_allowed") },
  { vector: "base href 劫持", layer: "sanitizer", expect: "tag_not_allowed", run: () => sanitizerRejected('<base href="https://evil.example/">', "tag_not_allowed") },
  { vector: "虚拟文档 origin 的非文档路径", layer: "route", expect: "abort", run: () => classifyRouteRequest("http://bowerbird-render.invalid/redirect").action === "abort" },

  // —— 嵌入与脚本 ——
  { vector: "iframe 嵌入", layer: "sanitizer", expect: "tag_not_allowed", run: () => sanitizerRejected('<iframe src="https://evil.example"></iframe>', "tag_not_allowed") },
  { vector: "script 标签", layer: "sanitizer", expect: "tag_not_allowed", run: () => sanitizerRejected("<script>alert(1)</script>", "tag_not_allowed") },
  { vector: "事件属性（onerror）", layer: "sanitizer", expect: "attr_not_allowed", run: () => sanitizerRejected('<img src="asset:r" onerror="alert(1)">', "attr_not_allowed") },
  { vector: "svg foreignObject", layer: "sanitizer", expect: "tag_not_allowed", run: () => sanitizerRejected("<svg><foreignObject></foreignObject></svg>", "tag_not_allowed") },
  { vector: "object/embed", layer: "sanitizer", expect: "tag_not_allowed", run: () => sanitizerRejected('<object data="x"></object><embed src="y">', "tag_not_allowed") },

  // —— 超大 data URI ——
  { vector: "img data URI", layer: "sanitizer", expect: "img_src_not_asset_ref", run: () => sanitizerRejected(`<img src="data:image/png;base64,${"A".repeat(100_000)}">`, "img_src_not_asset_ref") },
  { vector: "CSS data URI 背景", layer: "sanitizer", expect: "css_url_not_asset_ref", run: () => sanitizerRejected('<style>body{background:url(data:image/png;base64,AAAA)}</style>', "css_url_not_asset_ref") },

  // —— 契约层（模型可表达面）——
  { vector: "请求携带任意 URL 字段", layer: "contract", expect: "unknown_request_field", run: () => requestRejected({ ...BASE_REQUEST, url: "https://evil.example" }) },
  { vector: "请求携带路径字段", layer: "contract", expect: "unknown_request_field", run: () => requestRejected({ ...BASE_REQUEST, browserPath: "/etc/passwd" }) },
  { vector: "资源 key 路径注入", layer: "contract", expect: "resource_key", run: () => requestRejected({ ...BASE_REQUEST, resources: [{ key: "../../etc", mime: "image/png", sha256: "a".repeat(64), dataBase64: "AAA" }] }) },
  { vector: "HTML 超大请求体", layer: "contract", expect: "html_too_large", run: () => requestRejected({ ...BASE_REQUEST, html: "x".repeat(2 * 1024 * 1024 + 16) }) },

  // —— 解压炸弹图片（尺寸声明防护）——
  { vector: "PNG 声明超大画布", layer: "resource", expect: "resource_dimensions_exceeded", run: () => {
    const bomb = new Uint8Array(33);
    bomb.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    bomb.set([0x49, 0x48, 0x44, 0x52], 12);
    const view = new DataView(bomb.buffer);
    view.setUint32(16, 40000);
    view.setUint32(20, 40000);
    const dims = declaredImageDimensions(bomb, "image/png");
    return !!dims && !withinResourceDimensionLimits(dims, { maxSidePx: RENDER_LIMITS.maxResourceImageSidePx, maxPixels: RENDER_LIMITS.maxResourceImagePixels });
  } },
];

test("H5-T1 malicious vector matrix: every vector fails closed at its declared layer", () => {
  const layers = new Set(VECTORS.map((v) => v.layer));
  assert.equal(layers.size, 4, "矩阵应覆盖 sanitizer/route/contract/resource 四层");
  for (const vector of VECTORS) {
    assert.ok(vector.run(), `向量未被拦截: ${vector.vector}（期望 ${vector.expect}）`);
  }
});

test("H5-T1 sanity: legitimate closed-set document still passes all layers", () => {
  const ok = sanitizeHtml('<!DOCTYPE html><html><body><style>.a{background:url(asset:bg-1)}</style><img src="asset:r-1"></body></html>');
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.equal(classifyRouteRequest("http://bowerbird-assets.invalid/bg-1").action, "fulfill_resource");
  assert.ok(validateRenderRequest(BASE_REQUEST).ok);
});
