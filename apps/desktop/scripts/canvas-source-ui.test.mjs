import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const output = ".tmp/canvas-source";
await mkdir(output, { recursive: true });
const server = await createServer({ cacheDir: `${output}/vite`, server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, reducedMotion: "reduce" });
page.setDefaultNavigationTimeout(60000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
const panel = page.getByRole("complementary", { name: "画板素材库", exact: true });
const sidebar = panel.getByRole("complementary", { name: "素材库导航", exact: true });
const button = name => sidebar.getByRole("button", { name, exact: true });
const card = id => panel.locator(`[data-asset-id="${id}"]`);
const selection = panel.getByRole("group", { name: "分类素材所选操作" });
try {
  await page.addInitScript(() => localStorage.setItem("bowerbird.canvasLibraryWidth", "480"));
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/canvas-reference/preview.html?source-library&canvas-library`);
  const stage = page.locator(".canvas-stage");
  await stage.waitFor();
  await page.getByRole("button", { name: "展开画板素材库", exact: true }).click();
  await card("existing").waitFor();
  assert.equal(await button("引用布局合成验收").getAttribute("aria-current"), "true");
  const width = (await panel.boundingBox()).width;
  const sidebarBox = await sidebar.boundingBox();
  const stageBox = await stage.boundingBox();
  assert.equal(width, 480);
  assert.ok(sidebarBox.width >= 120);
  await page.keyboard.press("e");
  await sidebar.getByRole("navigation", { name: "标签首字母索引" }).waitFor();
  assert.deepEqual(await sidebar.boundingBox(), sidebarBox);
  assert.deepEqual(await stage.boundingBox(), stageBox);
  await page.keyboard.press("q");
  await button("全部素材").click();
  await card("a").click({ modifiers: ["Shift"] });
  await card("d").click({ modifiers: ["Shift"] });
  await selection.getByText("4 项", { exact: true }).waitFor();
  await card("b").press("Space");
  await selection.getByText("3 项", { exact: true }).waitFor();
  await selection.getByRole("button", { name: "全选", exact: true }).click();
  await selection.getByText("5 项", { exact: true }).waitFor();
  await selection.getByRole("button", { name: "取消选择", exact: true }).click();
  await button("文件夹").click();
  await sidebar.getByRole("treeitem", { name: "测试目录", exact: true }).click();
  await panel.locator('[data-catalog-section="test-root"] [data-connection-entry]').first().waitFor();
  assert.equal(await (await panel.boundingBox()).width, width);
  await page.screenshot({ path: `${output}/narrow.png` });
  await stage.focus();
  await page.keyboard.press("Tab");
  await panel.waitFor({ state: "hidden" });
  await stage.focus();
  await page.keyboard.press("Tab");
  await panel.waitFor();
  assert.equal(await sidebar.getByRole("treeitem", { name: "测试目录", exact: true }).getAttribute("aria-selected"), "true");
  for (const height of [760, 568]) {
    await page.setViewportSize({ width: 900, height });
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    assert.equal(await panel.evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await page.screenshot({ path: `${output}/library-${height}.png` });
  }
  assert.deepEqual(errors, []);
  console.log("PASS canvas drawer scope, narrow layout, keyboard and range selection");
} catch (error) {
  console.error(errors);
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  throw error;
} finally {
  await browser.close(); await server.close();
}
