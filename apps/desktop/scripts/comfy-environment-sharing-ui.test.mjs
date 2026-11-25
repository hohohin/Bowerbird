import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({
  cacheDir: ".tmp/comfy-environment-sharing/vite",
  server: { host: "127.0.0.1", port: 1776, strictPort: true, hmr: false, watch: null },
});
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:1776/scripts/fixtures/canvas-reference/preview.html");
  await page.evaluate(async () => {
    const { mountComfyEnvironment } = await import("/scripts/fixtures/canvas-reference/mountComfyEnvironment.tsx");
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.environmentChecks = [];
    window.environmentPhase = "missing";
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command !== "comfy_video_environment") return invoke(command, args);
      window.environmentChecks.push(args.action);
      if (args.action === "install") window.environmentPhase = "installing";
      return { mode: args.mode, phase: window.environmentPhase, message: "环境测试",
        endpoint: args.endpoint, directory: "D:/test", canInstall: true,
        installed: false, downloadBytes: 1024, completedBytes: 128, requiredBytes: 2048, totalBytes: 1024 };
    };
    window.mountEnvironment = (composer, mode) => {
      const host = document.createElement("section");
      host.dataset.environment = mode || (composer ? "composer" : "card");
      document.body.append(host);
      mountComfyEnvironment(host, composer, mode);
    };
    window.mountEnvironment(false);
  });
  await page.waitForFunction(() => window.environmentChecks.length === 1);
  await page.evaluate(() => window.mountEnvironment(true));
  const card = page.locator("[data-environment=card] button");
  const composer = page.locator("[data-environment=composer] button");
  await composer.waitFor();
  await page.waitForTimeout(600);
  assert.deepEqual(await page.evaluate(() => window.environmentChecks), ["detect"], "later mounts receive the same detection result");
  await page.evaluate(() => { for (let i = 0; i < 5; i++) window.dispatchEvent(new Event("focus")); });
  await page.waitForFunction(() => window.environmentChecks.length === 2);
  assert.deepEqual(await page.evaluate(() => window.environmentChecks), ["detect", "detect"], "focus shares one refresh");
  await card.dispatchEvent("click");
  const panel = page.getByRole("dialog", { name: "本地部署工作流环境设置" });
  await panel.getByRole("button", { name: "安装", exact: true }).click();
  await panel.getByLabel("环境下载进度").waitFor();
  await panel.press("Escape");
  await page.evaluate(() => window.mountEnvironment(false, "reference"));
  await page.locator("[data-environment=reference] button").dispatchEvent("click");
  await panel.getByLabel("环境下载进度").waitFor();
  await panel.press("Escape");
  await composer.click();
  await panel.getByLabel("环境下载进度").waitFor();
  await page.waitForFunction(() => window.environmentChecks.includes("status"));
  assert.equal(await page.evaluate(() => window.environmentChecks.filter(action => action === "status").length), 1);
  assert.equal(await page.evaluate(() => window.environmentChecks.filter(action => action === "install").length), 1);
  assert.equal(await page.evaluate(() => window.environmentChecks.filter(action => action === "detect").length), 2);
  console.log("Multiple controls share one detection, install and progress poll");
} finally {
  await browser.close();
  await server.close();
}
