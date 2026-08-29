/**
 * html-renderer 服务入口 —— H1-T5。
 *
 * 启动：校验 env（内部 token 必填）→ 清理孤儿临时目录 → 启动 Chromium（保留 sandbox）
 * → 启动内部 HTTP 服务。退出：SIGTERM/SIGINT 优雅关闭 server 与浏览器。
 */
import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchRendererBrowser } from "./renderer.ts";
import { createRenderService } from "./render-service.ts";
import { startRenderServer } from "./server.ts";
import { RENDERER_CODE_VERSION, PINNED_PLAYWRIGHT_VERSION, computeRendererFingerprint } from "./fingerprint.ts";
import { RenderMetrics } from "./metrics.ts";
import { RENDER_LIMITS } from "./limits.ts";
import { runtimeResourceSnapshot } from "./runtime-resources.ts";

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
}

function requireToken(): string {
  const token = process.env.RENDER_INTERNAL_TOKEN;
  if (!token || token.length < 32) {
    console.error(JSON.stringify({ event: "startup_failed", reason: "RENDER_INTERNAL_TOKEN_missing_or_too_short" }));
    process.exit(1);
  }
  return token;
}

function renderRoot(): string {
  return process.env.RENDER_TMP_DIR ?? join(tmpdir(), "bowerbird-render");
}

/** 启动时孤儿清理：移除上次异常退出遗留的 render-* 请求目录。 */
function cleanupOrphanDirs(root: string): void {
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("render-")) {
        rmSync(join(root, entry.name), { recursive: true, force: true });
      }
    }
  } catch {
    // root 不存在等：忽略
  }
}

async function main(): Promise<void> {
  const token = requireToken();
  const root = renderRoot();
  cleanupOrphanDirs(root);

  let browser;
  try {
    browser = await launchRendererBrowser();
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 160) : "unknown";
    console.error(JSON.stringify({ event: "startup_failed", reason: `chromium_launch_failed: ${reason}` }));
    process.exit(1);
  }
  const chromiumVersion = browser.version();
  const rendererFingerprint = computeRendererFingerprint(chromiumVersion);
  const metrics = new RenderMetrics(RENDER_LIMITS.renderTimeoutMs);
  const service = createRenderService(browser, log, metrics);

  const port = Number(process.env.RENDER_PORT ?? 3917);
  const running = startRenderServer({
    port,
    token,
    handleRender: (body) => service.execute(body, extractRequestIdOf(body)),
    health: () => ({
      rendererFingerprint,
      chromiumVersion,
      playwrightVersion: PINNED_PLAYWRIGHT_VERSION,
      codeVersion: RENDERER_CODE_VERSION,
      metrics: metrics.snapshot(),
      resources: runtimeResourceSnapshot(),
    }),
    log,
  });
  await new Promise<void>((resolve) => {
    running.server.listen(port, "0.0.0.0", () => resolve());
  });
  log({ event: "renderer_started", port, rendererFingerprint, chromiumVersion });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log({ event: "renderer_stopping", signal });
    void running.close().finally(() => {
      void browser.close().catch(() => undefined).finally(() => {
        cleanupOrphanDirs(root);
        process.exit(0);
      });
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

function extractRequestIdOf(body: unknown): string {
  if (typeof body === "object" && body !== null && "requestId" in body && typeof (body as { requestId: unknown }).requestId === "string") {
    return (body as { requestId: string }).requestId;
  }
  return "unknown";
}

void main();
