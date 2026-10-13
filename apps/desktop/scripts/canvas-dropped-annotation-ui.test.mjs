import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1589, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const panel = page.getByRole("complementary", { name: "画板素材库" });
const annotate = page.getByRole("menuitem", { name: "图片标注", exact: true });
try {
  await page.goto("http://127.0.0.1:1589/scripts/fixtures/canvas-reference/preview.html?source-library");
  await panel.locator('[data-asset-id="a"]').waitFor();
  await page.evaluate(() => {
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      const result = await original(command, args);
      if (["list_assets", "get_assets_by_ids"].includes(command)) {
        return result.map(asset => ({ ...asset, ext: asset.id === "b" ? "avif" : "png" }));
      }
      return result;
    };
    // Source-panel assets are independent of the filtered global list.
    window.store.setState({ assets: [] });
    window.emitAssetsChanged();
  });
  await panel.getByRole("tab", { name: "中央素材", exact: true }).click();
  await page.waitForFunction(() => window.calls.some(call => call.command === "list_assets"));
  await panel.locator('[data-asset-id="a"]').click({ button: "right" });
  assert.equal(await annotate.isEnabled(), true, "the source library permits annotating the PNG");
  await page.keyboard.press("Escape");

  for (const id of ["a", "b"]) {
    await panel.locator(`[data-asset-id="${id}"]`).evaluate((el, id) => {
      const dataTransfer = new DataTransfer();
      el.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer }));
      const stage = document.querySelector(".canvas-stage");
      const rect = stage.getBoundingClientRect();
      stage.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer,
        clientX: rect.x + 80, clientY: rect.y + (id === "a" ? 140 : 400) }));
      el.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer }));
    }, id);
    await page.waitForFunction(id => window.snapshot().nodes.some(node => node.assetId === id), id);
    const nodeId = await page.evaluate(id => window.snapshot().nodes.find(node => node.assetId === id).id, id);
    await page.locator(`[data-canvas-node-id="${nodeId}"]`).click({ button: "right" });
    assert.equal(await annotate.isEnabled(), id === "a", "dropping preserves the library's format eligibility");
    if (id === "a") {
      assert.equal(await page.evaluate(() => window.store.getState().contextMenu.asset.id), "a");
      await annotate.click();
      const dialog = page.getByRole("dialog", { name: "图片标注", exact: true });
      await dialog.getByAltText("合成参考 a", { exact: true }).waitFor();
      await dialog.getByRole("button", { name: "关闭（Esc）", exact: true }).click();
    } else await page.keyboard.press("Escape");
  }
  assert.equal(await page.evaluate(() => window.store.getState().assets.length), 0);
  assert.deepEqual(errors, []);
  console.log("PASS dropped canvas annotation: source-library PNG remains annotatable with an empty global list, exact asset opens, unsupported AVIF stays disabled");
} finally { await browser.close(); await server.close(); }
