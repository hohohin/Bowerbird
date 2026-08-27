/**
 * renderer fingerprint —— HTML-RENDER-PLAN.md §4.3。
 *
 * fingerprint 绑定：renderer 代码版本、Chromium 版本、Playwright 版本、构建期烙印的
 * 基础镜像/字体包信息（build-info.json，由 Dockerfile 在构建时生成）、默认样式版本。
 * 它是历史可追溯信息（同 fingerprint 下输出可复现），不用于放松任何输入校验。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

/** 与 package.json dependencies.playwright 保持一致（锁死单一来源需两处同步）。 */
export const PINNED_PLAYWRIGHT_VERSION = "1.62.1";

/** 注入的 reset/default stylesheet 版本（renderer.ts 内嵌样式的任何改动都要递增）。 */
export const DEFAULT_STYLESHEET_VERSION = 1;

export const RENDERER_CODE_VERSION = "0.1.0";

export type BuildInfo = {
  builtAt?: string;
  baseImage?: string;
  playwrightVersion?: string;
  fontPackages?: Record<string, string>;
};

let cachedBuildInfo: BuildInfo | undefined;
let cachedFingerprint: string | undefined;

export function loadBuildInfo(): BuildInfo {
  if (cachedBuildInfo) return cachedBuildInfo;
  try {
    const path = join(dirname(new URL(import.meta.url).pathname), "..", "build-info.json");
    cachedBuildInfo = JSON.parse(readFileSync(path, "utf8")) as BuildInfo;
  } catch {
    cachedBuildInfo = {};
  }
  return cachedBuildInfo;
}

/**
 * 计算 fingerprint：`bwr1-<sha256 前 32 hex>`。
 * @param chromiumVersion 运行时 browser.version()（Playwright 提供）。
 */
export function computeRendererFingerprint(chromiumVersion: string): string {
  if (cachedFingerprint) return cachedFingerprint;
  const buildInfo = loadBuildInfo();
  const canonical = JSON.stringify({
    rendererCodeVersion: RENDERER_CODE_VERSION,
    chromiumVersion,
    playwrightVersion: PINNED_PLAYWRIGHT_VERSION,
    baseImage: buildInfo.baseImage ?? "dev",
    fontPackages: buildInfo.fontPackages ?? {},
    defaultStylesheetVersion: DEFAULT_STYLESHEET_VERSION,
    pngEncoding: { filter: 0, zlibLevel: 6, colorTypes: [2, 6] },
  });
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 32);
  cachedFingerprint = `bwr1-${hash}`;
  return cachedFingerprint;
}
