/**
 * 构建期烙印 build-info.json（Dockerfile 内运行，stdout 重定向到 /app/build-info.json）。
 * 记录基础镜像 tag、playwright 精确版本、字体包版本 —— rendererFingerprint 的组成部分。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const FONT_PACKAGES = ["fonts-noto-cjk", "fonts-noto-core", "fonts-dejavu-core"];

const fontPackages = {};
for (const name of FONT_PACKAGES) {
  try {
    fontPackages[name] = execFileSync("dpkg-query", ["-W", "--showformat", "${Version}", name], { encoding: "utf8" }).trim();
  } catch {
    fontPackages[name] = "unknown";
  }
}

const info = {
  builtAt: new Date().toISOString(),
  baseImage: "node:24-bookworm-slim",
  playwrightVersion: pkg.dependencies.playwright,
  fontPackages,
};

process.stdout.write(JSON.stringify(info, null, 2) + "\n");
