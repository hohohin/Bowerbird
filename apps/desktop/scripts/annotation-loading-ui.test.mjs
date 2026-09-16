import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1561, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const dialog = page.getByRole("dialog", { name: "图片标注", exact: true });
try {
  await page.goto("http://127.0.0.1:1561/scripts/fixtures/canvas-reference/preview.html");
  await page.waitForFunction(() => window.store && document.querySelector(".canvas-node"));
  await page.evaluate(() => {
    const original = window.__TAURI_INTERNALS__.invoke;
    window.pendingAssets = {};
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "get_assets_by_ids") {
        if (window.deferAssets) return new Promise(resolve => { window.pendingAssets[args.assetIds[0]] = resolve; });
        if (window.failAssets) throw "模拟素材读取失败";
        return (await original(command, args)).map(asset => ({ ...asset, ext: "png" }));
      }
      return original(command, args);
    };
    window.store.setState({ assets: [] });
    window.emitChange();
  });
  // The canvas owns its loaded assets even when the filtered library list is empty.
  await page.waitForFunction(() => window.calls.filter(call => call.command === "get_assets_by_ids").length >= 2);
  await page.locator('[data-canvas-node-id="old"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "图片标注", exact: true }).click();
  await dialog.getByAltText("合成参考 existing", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.store.getState().assets.length), 0);
  assert.equal(await dialog.getByText("素材不存在或已删除", { exact: true }).count(), 0);
  const box = await dialog.locator("svg.cursor-crosshair").boundingBox();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 5 });
  await page.mouse.up();
  await dialog.getByRole("button", { name: "保存到素材库", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const saved = await page.evaluate(() => window.calls.find(call => call.command === "save_annotated_image").args);
  assert.equal(JSON.parse(saved.annotationJson).source_asset_id, "existing");
  assert.equal(JSON.parse(saved.annotationJson).shapes.length, 1);
  assert.match(saved.fileName, /合成参考 existing/);

  await page.evaluate(() => {
    window.deferAssets = true;
    window.store.getState().openAnnotator("a");
  });
  await page.waitForFunction(() => window.pendingAssets.a);
  await dialog.getByText("正在加载素材…", { exact: true }).waitFor();
  assert.equal(await dialog.getByText("素材不存在或已删除", { exact: true }).count(), 0);
  await page.evaluate(() => window.store.getState().openAnnotator("b"));
  await page.waitForFunction(() => window.pendingAssets.b);
  await page.evaluate(() => window.pendingAssets.b([{ id: "b", name: "当前图片", ext: "png", store_path: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>' }]));
  await dialog.getByAltText("当前图片", { exact: true }).waitFor();
  await page.evaluate(() => window.pendingAssets.a([]));
  assert.equal(await dialog.getByAltText("当前图片", { exact: true }).isVisible(), true);

  // Closing and reopening the same ID must not reuse the previous pending request.
  await page.evaluate(() => { delete window.pendingAssets.a; window.store.getState().openAnnotator("a"); });
  await page.waitForFunction(() => window.pendingAssets.a);
  await page.evaluate(() => { window.oldRequest = window.pendingAssets.a; delete window.pendingAssets.a; window.store.getState().closeAnnotator(); });
  await dialog.waitFor({ state: "hidden" });
  await page.evaluate(() => window.store.getState().openAnnotator("a"));
  await page.waitForFunction(() => window.pendingAssets.a);
  await page.evaluate(() => window.oldRequest([]));
  await dialog.getByText("正在加载素材…", { exact: true }).waitFor();
  await page.evaluate(() => window.pendingAssets.a([]));
  await dialog.getByText("素材不存在或已删除", { exact: true }).waitFor();

  await page.evaluate(() => { window.deferAssets = false; window.failAssets = true; window.store.getState().openAnnotator("failure"); });
  await dialog.getByText("素材加载失败：模拟素材读取失败", { exact: true }).waitFor();
  assert.equal(await dialog.getByText("素材不存在或已删除", { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS annotation loading: canvas context menu with empty library list, export source identity, loading/missing/error states, switching images and close/reopen races");
} finally { await browser.close(); await server.close(); }
