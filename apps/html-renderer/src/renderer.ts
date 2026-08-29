/**
 * Playwright 离线渲染会话 —— HTML-RENDER-PLAN.md §5.1–§5.3（H1-T2/T3）。
 *
 * 安全层次：
 *   1. 容器无公网出口（部署层）；
 *   2. 本文件的全请求拦截（classifyRouteRequest）：只 fulfill 文档与资源表两个虚拟 origin；
 *   3. BrowserContext javaScriptEnabled=false + 封闭 CSP + 禁下载/弹窗等默认。
 *
 * 稳定性：注入版本化 reset/freeze 样式（关 animation/transition/caret），networkidle 后
 * 用 CDP Page.getLayoutMetrics 连续采样确认尺寸稳定，再执行**唯一一次** rasterization；
 * 切片一律由 render-service 从该整页 PNG 裁出（本文件绝不滚动重截）。
 */
import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Route, type Request } from "playwright";
import { ASSETS_HOST, DOCUMENT_URL, classifyRouteRequest } from "./route-policy.ts";
import type { RenderBackground, RenderCaptureMode, RenderResourceMime } from "./contracts.ts";
import { DEFAULT_STYLESHEET_VERSION } from "./fingerprint.ts";

export const CHROMIUM_LAUNCH_ARGS: readonly string[] = [
  // 不含 --no-sandbox：Chromium sandbox 是硬边界（计划 H0-T5），绝不默认关闭。
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--force-color-profile=srgb",
  "--font-render-hinting=none",
  "--disable-lcd-text",
  "--hide-scrollbars",
];

export const CHROMIUM_LAUNCH_OPTIONS: LaunchOptions = {
  args: [...CHROMIUM_LAUNCH_ARGS],
  chromiumSandbox: true,
  handleSIGHUP: false,
  handleSIGINT: false,
  handleSIGTERM: false,
};

/** 封闭 CSP：无脚本、无外部源、无表单/框架/连接；样式仅内联。 */
const CSP_HEADER =
  "default-src 'none'; img-src http://" + ASSETS_HOST + "; style-src 'unsafe-inline'; font-src 'none'; " +
  "script-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; connect-src 'none'; " +
  "form-action 'none'; base-uri 'none'";

function defaultStylesheet(opaque: boolean): string {
  const lines = [
    "*,*::before,*::after{box-sizing:border-box;animation:none !important;transition:none !important;caret-color:transparent !important;scroll-behavior:auto !important;}",
    "html,body{margin:0;padding:0;}",
    "img{display:inline-block;max-width:100%;}",
  ];
  if (opaque) lines.push("html{background:#ffffff;}");
  return lines.join("\n");
}

/** 注入点：<head> 开标签后 → <html> 开标签后 → 文档开头（三档确定性行为）。 */
export function injectDefaultStyles(html: string, opaque: boolean): string {
  const styleTag = `<style id="bowerbird-render-defaults-v${DEFAULT_STYLESHEET_VERSION}">${defaultStylesheet(opaque)}</style>`;
  const headOpen = /<head(\s[^>]*)?>/i.exec(html);
  if (headOpen && headOpen.index !== undefined) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + styleTag + html.slice(at);
  }
  const htmlOpen = /<html(\s[^>]*)?>/i.exec(html);
  if (htmlOpen && htmlOpen.index !== undefined) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return html.slice(0, at) + "<head>" + styleTag + "</head>" + html.slice(at);
  }
  return "<!DOCTYPE html><html><head>" + styleTag + "</head>" + html;
}

/**
 * 把已通过 sanitizer 的 `asset:<key>` 引用改写到资源虚拟 origin。
 * 两个锚定上下文：img 的 src 属性值、CSS url(...)；sanitizer 已保证合法形态才会命中
 * 这些语法位置（正文文本里恰好出现同形字符串的极端 corner 会一并改写，仅影响显示文本，
 * 不影响安全与确定性）。
 */
export function rewriteAssetRefs(html: string): string {
  return html
    .replace(/(src\s*=\s*)(["'])asset:([A-Za-z0-9_-]{1,64})\2/gi, (_m, pre: string, quote: string, key: string) => `${pre}${quote}http://${ASSETS_HOST}/${key}${quote}`)
    .replace(/url\(\s*(["']?)asset:([A-Za-z0-9_-]{1,64})\1\s*\)/gi, (_m, quote: string, key: string) => `url(${quote}http://${ASSETS_HOST}/${key}${quote})`);
}

export type RenderSessionInput = {
  /** 已通过 sanitizer 的 HTML（含 asset: 引用）。 */
  html: string;
  /** 资源表（key → 字节）。 */
  resources: Map<string, { mime: RenderResourceMime; bytes: Uint8Array }>;
  /** sanitizer 报告的被引用 key 闭集（渲染后核对全部真实发出请求）。 */
  referencedResourceKeys: ReadonlySet<string>;
  viewport: { widthCssPx: number; heightCssPx: number; deviceScaleFactor: 1 | 2 };
  capture: { mode: RenderCaptureMode };
  background: RenderBackground;
  /** 本会话的剩余时间预算（ms）。 */
  timeoutMs: number;
};

export type RenderSessionOk = {
  baseRole: "viewport_screenshot" | "full_page_screenshot";
  basePng: Uint8Array;
  documentCssWidth: number;
  documentCssHeight: number;
  documentDeviceWidth: number;
  documentDeviceHeight: number;
};

export type RenderSessionError = { code: "render_layout_unstable" | "render_timeout" | "render_resource_invalid" | "render_document_too_large" | "render_service_unavailable" | "render_output_invalid"; reason: string };

export async function launchRendererBrowser(): Promise<Browser> {
  return chromium.launch(CHROMIUM_LAUNCH_OPTIONS);
}

export async function renderDocument(browser: Browser, input: RenderSessionInput): Promise<RenderSessionOk | RenderSessionError> {
  const context = await browser.newContext({
    viewport: { width: input.viewport.widthCssPx, height: input.viewport.heightCssPx },
    deviceScaleFactor: input.viewport.deviceScaleFactor,
    javaScriptEnabled: false,
    bypassCSP: false,
    colorScheme: "light",
    reducedMotion: "reduce",
    forcedColors: "none",
    isMobile: false,
    hasTouch: false,
  });
  try {
    return await renderInContext(context, input);
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function renderInContext(context: BrowserContext, input: RenderSessionInput): Promise<RenderSessionOk | RenderSessionError> {
  const requestedKeys = new Set<string>();
  await context.route("**/*", (route: Route, request: Request) => {
    const decision = classifyRouteRequest(request.url());
    if (decision.action === "fulfill_document") {
      void route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        headers: {
          "content-security-policy": CSP_HEADER,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
        body: rewriteAssetRefs(injectDefaultStyles(input.html, input.background === "opaque")),
      });
      return;
    }
    if (decision.action === "fulfill_resource") {
      const resource = input.resources.get(decision.key);
      if (!resource) {
        void route.abort("blockedbyclient");
        return;
      }
      requestedKeys.add(decision.key);
      void route.fulfill({
        status: 200,
        contentType: resource.mime,
        headers: { "cache-control": "no-store" },
        body: Buffer.from(resource.bytes),
      });
      return;
    }
    void route.abort("blockedbyclient");
  });

  const page = await context.newPage();
  try {
    await page.goto(DOCUMENT_URL, { waitUntil: "networkidle", timeout: input.timeoutMs });

    // 资源闭集核对：sanitizer 引用的每个 key 都必须真实发出并被 fulfill。
    for (const key of input.referencedResourceKeys) {
      if (!requestedKeys.has(key)) {
        return { code: "render_resource_invalid", reason: "resource_not_requested" };
      }
    }

    // 布局稳定：CDP 尺寸连续采样（不依赖页面 JS）。
    const cdp = await context.newCDPSession(page);
    let cssWidth = 0;
    let cssHeight = 0;
    for (let sample = 0; sample < 3; sample += 1) {
      const metrics = (await cdp.send("Page.getLayoutMetrics")) as {
        cssContentSize?: { width: number; height: number };
      };
      const w = round2(metrics.cssContentSize?.width ?? 0);
      const h = round2(metrics.cssContentSize?.height ?? 0);
      if (w <= 0 || h <= 0) return { code: "render_layout_unstable", reason: "layout_metrics_invalid" };
      if (sample === 0) {
        cssWidth = w;
        cssHeight = h;
      } else if (w !== cssWidth || h !== cssHeight) {
        return { code: "render_layout_unstable", reason: "layout_size_changed_during_settle" };
      }
      if (sample < 2) await page.waitForTimeout(60);
    }

    // 预检设备像素上限（截图前拒绝，避免超大 rasterization）。
    const dsf = input.viewport.deviceScaleFactor;
    const estWidth = Math.ceil(cssWidth * dsf);
    const estHeight = Math.ceil(cssHeight * dsf);
    if (estWidth * estHeight > 64 * 1024 * 1024) {
      return { code: "render_document_too_large", reason: "device_pixels_exceed_limit" };
    }

    const fullPage = input.capture.mode !== "viewport";
    const png = await page.screenshot({
      type: "png",
      fullPage,
      omitBackground: input.background === "transparent",
      timeout: input.timeoutMs,
    });
    if (!(png instanceof Uint8Array)) {
      return { code: "render_output_invalid", reason: "screenshot_not_png_bytes" };
    }
    return {
      baseRole: fullPage ? "full_page_screenshot" : "viewport_screenshot",
      basePng: new Uint8Array(png),
      documentCssWidth: cssWidth,
      documentCssHeight: cssHeight,
      documentDeviceWidth: fullPage ? estWidth : input.viewport.widthCssPx * dsf,
      documentDeviceHeight: fullPage ? estHeight : input.viewport.heightCssPx * dsf,
    };
  } finally {
    await page.close().catch(() => undefined);
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
