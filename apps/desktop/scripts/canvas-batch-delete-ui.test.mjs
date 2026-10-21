import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE || "playwright");
const server = await createServer({ server: { host: "127.0.0.1", port: 1487, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const node = id => page.locator(`[data-canvas-node-id="${id}"]`);
const dialog = () => page.getByRole("dialog");
const deleteCalls = () => page.evaluate(() => window.deleteCalls ?? []);
async function openDelete(id = "a") {
  await node(id).click({ button: "right", position: { x: 30, y: 30 } });
  await page.getByRole("menuitem", { name: "删除", exact: true }).click();
  await page.getByRole("menuitem", { name: "物理删除", exact: true }).click();
  await dialog().getByRole("list", { name: "待删除素材" }).waitFor();
}
async function marquee() {
  const rect = await page.locator(".canvas-stage").boundingBox();
  // Start below the cards, outside the floating canvas toolbar.
  await page.mouse.move(rect.x + 710, rect.y + 290);
  await page.mouse.down();
  await page.mouse.move(rect.x + 55, rect.y + 60, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelectorAll("[data-canvas-node-id].is-selected").length === 3);
}
async function reset() {
  await page.reload();
  await node("outside").waitFor();
  await page.evaluate(() => {
    document.activeElement?.blur();
    // Unrelated library selection must never replace the canvas selection.
    window.store.setState({ boardOpen: false, mode: "manage", selectedIds: new Set(["a", "b", "c"]), assets: [] });
    window.deleteCalls = [];
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "delete_asset_with_mode") {
        window.deleteCalls.push(args);
        if (window.holdDelete) await new Promise(resolve => { window.releaseDelete = resolve; });
        if (args.id === window.failDeleteId) throw "模拟单图删除失败";
      }
      if (command === "get_assets_by_ids" && window.failPreview) throw "模拟预览读取失败";
      const result = await original(command, args);
      if (command === "get_assets_by_ids" && window.externalPreview) return result.map(asset => ({ ...asset, source: "external" }));
      return result;
    };
  });
  await page.waitForFunction(() => !document.querySelector(".canvas-stage.is-creation-mode"));
}
try {
  await page.goto("http://127.0.0.1:1487/scripts/fixtures/canvas-reference/preview.html");
  await node("old").waitFor();
  await page.evaluate(() => {
    const s = window.snapshot(), base = s.nodes[0];
    s.nodes = [{ ...base, x: 60, y: 80 },
      { ...base, id: "a", assetId: "a", x: 280, y: 80 },
      { ...base, id: "duplicate-a", assetId: "a", x: 500, y: 80 },
      { ...base, id: "outside", assetId: "b", x: 60, y: 400 }];
    s.view = { ...s.view, panX: 0, panY: 0, zoom: 1 };
    sessionStorage.setItem("reference-fixture", JSON.stringify(s));
  });
  await reset();
  await marquee();
  await openDelete();
  assert.deepEqual(await dialog().locator("[data-delete-asset-id]").evaluateAll(items => items.map(item => item.dataset.deleteAssetId)), ["existing", "a"]);
  assert.equal(await dialog().getByRole("list", { name: "待删除素材" }).locator("img").count(), 2);
  assert.deepEqual(await deleteCalls(), [], "opening preview performs no deletion");
  await mkdir(".tmp/canvas-batch-delete", { recursive: true });
  for (const theme of ["dark", "light"]) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.screenshot({ path: `.tmp/canvas-batch-delete/${theme}.png`, animations: "disabled" });
  }
  await page.setViewportSize({ width: 900, height: 700 });
  const bounds = await dialog().locator(".app-modal").boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 900 && bounds.y >= 0 && bounds.y + bounds.height <= 700);
  await dialog().getByRole("button", { name: "取消", exact: true }).click();
  assert.deepEqual(await deleteCalls(), []);
  await page.setViewportSize({ width: 1800, height: 1100 });
  // Right-clicking outside the selection targets only that image.
  await openDelete("outside");
  assert.equal(await dialog().locator("[data-delete-asset-id]").count(), 1);
  assert.equal(await dialog().locator("[data-delete-asset-id]").getAttribute("data-delete-asset-id"), "b");
  await page.keyboard.press("Escape");

  await reset();
  await marquee();
  await openDelete();
  await page.evaluate(() => { window.failDeleteId = "a"; window.holdDelete = true; });
  await dialog().getByRole("button", { name: "物理删除", exact: true }).click();
  await page.waitForFunction(() => window.releaseDelete);
  await page.keyboard.press("Escape");
  assert.equal(await dialog().isVisible(), true, "cannot dismiss during deletion");
  assert.equal(await dialog().getByRole("button", { name: "取消", exact: true }).isDisabled(), true);
  await page.evaluate(() => { window.holdDelete = false; window.releaseDelete(); });
  await dialog().getByRole("alert").filter({ hasText: "1 项失败" }).waitFor();
  assert.equal(await dialog().locator("[data-delete-asset-id]").count(), 1);
  assert.equal(await dialog().locator("[data-delete-asset-id]").getAttribute("data-delete-asset-id"), "a");
  await node("old").waitFor({ state: "detached" });
  assert.equal(await node("a").count(), 1);
  assert.equal(await node("outside").count(), 1);
  await page.evaluate(() => { window.failDeleteId = null; });
  await dialog().getByRole("button", { name: "重试失败项" }).click();
  await dialog().waitFor({ state: "detached" });
  await node("a").waitFor({ state: "detached" });
  await node("duplicate-a").waitFor({ state: "detached" });
  assert.deepEqual((await deleteCalls()).map(call => [call.id, call.projectId, call.mode]), [["existing", "p", "delete"], ["a", "p", "delete"], ["a", "p", "delete"]]);
  await page.evaluate(() => window.save());
  await page.reload();
  await node("outside").waitFor();
  assert.equal(await node("a").count(), 0);

  // Preview errors block confirmation; external references clearly retain the original files.
  await reset();
  await page.evaluate(() => { window.failPreview = true; });
  await node("outside").click({ button: "right", position: { x: 30, y: 30 } });
  await page.getByRole("menuitem", { name: "删除", exact: true }).click();
  await page.getByRole("menuitem", { name: "物理删除", exact: true }).click();
  await dialog().getByRole("alert").waitFor();
  assert.equal(await dialog().getByRole("button", { name: "物理删除", exact: true }).isDisabled(), true);
  await page.evaluate(() => { window.failPreview = false; window.externalPreview = true; });
  await dialog().getByRole("button", { name: "重新读取" }).click();
  await dialog().getByRole("button", { name: "移除引用", exact: true }).waitFor();
  await dialog().getByText("仅移除引用 · 保留原文件").waitFor();
  assert.deepEqual(await deleteCalls(), []);

  // The library batch menu keeps its own scope through the same confirmation flow.
  await page.goto("http://127.0.0.1:1487/scripts/fixtures/asset-multi-menu/preview.html");
  await page.waitForFunction(() => window.openMenu);
  await page.evaluate(() => window.openMenu('multi'));
  await page.getByRole("menuitem", { name: "删除", exact: true }).click();
  await page.getByRole("menuitem", { name: "物理删除", exact: true }).click();
  await dialog().getByRole("button", { name: "物理删除", exact: true }).click();
  await dialog().waitFor({ state: 'detached' });
  assert.deepEqual(await page.evaluate(() => window.calls.filter(c => c.command === 'delete_asset_with_mode').map(c => c.args.id)), ['a1','a2']);
  assert.deepEqual(errors, []);
  console.log("PASS canvas batch delete: marquee, frozen previews, deduplication, library-selection isolation, cancel/outside selection, partial failure/retry, busy guard, reload, preview error, external reference, themes/narrow layout");
} catch (error) {
  await mkdir(".tmp/canvas-batch-delete", { recursive: true });
  await page.screenshot({ path: ".tmp/canvas-batch-delete/failure.png" });
  console.error(await page.locator("[data-canvas-node-id]").evaluateAll(items => items.map(item => ({ id: item.dataset.canvasNodeId, selected: item.classList.contains("is-selected"), rect: item.getBoundingClientRect().toJSON() }))));
  throw error;
} finally { await browser.close(); await server.close(); }
