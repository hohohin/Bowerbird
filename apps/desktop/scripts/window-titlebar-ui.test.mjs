import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const config = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
const capability = JSON.parse(await readFile("src-tauri/capabilities/default.json", "utf8"));
assert.equal(config.app.windows[0].decorations, false);
for (const action of ["minimize", "toggle-maximize", "close", "start-dragging"]) {
  assert.ok(capability.permissions.includes(`core:window:allow-${action}`));
}
const server = await createServer({ server: { host: "127.0.0.1", port: 1594, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto("http://127.0.0.1:1594/scripts/fixtures/window-titlebar/preview.html");
  await page.getByRole("button", { name: "最大化窗口", exact: true }).click();
  await page.getByRole("button", { name: "还原窗口", exact: true }).click();
  await page.getByRole("button", { name: "最大化窗口", exact: true }).waitFor();
  await page.evaluate(() => window.externalResize());
  await page.getByRole("button", { name: "还原窗口", exact: true }).waitFor();
  await page.locator(".app-window-drag-region").dblclick();
  await page.getByRole("button", { name: "最大化窗口", exact: true }).waitFor();
  await page.getByRole("button", { name: "最小化窗口", exact: true }).click();
  await page.getByRole("button", { name: "关闭窗口", exact: true }).click();
  const calls = await page.evaluate(() => window.calls);
  for (const action of ["minimize", "close", "start_dragging"]) assert.ok(calls.includes(`plugin:window|${action}`));
  assert.equal(calls.filter(command => command === "plugin:window|toggle_maximize").length, 3);
  assert.equal(await page.getByText("生成图", { exact: true }).count(), 0);
  assert.equal(await page.getByText("项目素材", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "只看", exact: true }).click();
  assert.equal(await page.evaluate(() => window.store.getState().smartFilter), "source:generated");
  await page.getByRole("button", { name: "展开", exact: true }).click();
  assert.equal(await page.evaluate(() => window.store.getState().projectAssetsCollapsed), false);
  await mkdir(".tmp/window-titlebar", { recursive: true });
  const colors = [];
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    colors.push(await page.locator(".app-window-titlebar").evaluate(el => getComputedStyle(el).backgroundColor));
    await page.screenshot({ path: `.tmp/window-titlebar/${theme}.png` });
  }
  assert.notEqual(colors[0], colors[1]);
  await page.setViewportSize({ width: 900, height: 600 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: ".tmp/window-titlebar/compact.png" });
  assert.deepEqual(errors, []);
  console.log("PASS: window actions, double-click and external resize, theme switching, removed labels, retained filters, 900px layout, configuration permissions");
} finally {
  await browser.close();
  await server.close();
}
