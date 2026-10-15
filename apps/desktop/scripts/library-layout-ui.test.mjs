import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";
const server = await createServer({ server: { host: "127.0.0.1", port: 1579, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.setDefaultTimeout(10000);
await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
const errors = []; page.on("pageerror", error => errors.push(error.message));
const root = "http://127.0.0.1:1579/scripts/fixtures/";
async function geometry(grid, width) {
  await page.waitForTimeout(300);
  const result = await grid.evaluate(el => {
    const style = getComputedStyle(el);
    const available = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return { widths: [...el.querySelectorAll('[data-asset-id]')].map(card => card.getBoundingClientRect().width),
      columns: el.children.length, available, overflow: el.scrollWidth > el.clientWidth + 1 };
  });
  assert.ok(result.widths.length > 0 && result.widths.every(actual => Math.abs(actual - result.widths[0]) < 0.1), JSON.stringify(result));
  assert.ok(result.widths[0] >= Math.min(width, result.available) - 0.1, JSON.stringify(result));
  assert.ok(Math.abs(result.widths[0] * result.columns + (result.columns - 1) * 8 - result.available) < 1, "columns fill remaining space");
  assert.equal(result.overflow, false);
  return result.columns;
}
try {
  await page.goto(root + "project-drop/preview.html?layout");
  await page.locator('[data-asset-id="one"]').waitFor();
  await page.evaluate(() => {
    const base = window.store.getState().assets[0];
    const assets = Array.from({ length: 36 }, (_, i) => ({ ...base, id: `layout-${i}`, height: 120 + i % 4 * 60 }));
    window.store.setState({ assets, total: assets.length, libraryMemberships: [] });
  });
  let previous = 0;
  for (const width of [700, 1100, 1600, 2200]) {
    await page.setViewportSize({ width, height: 900 });
    const columns = await geometry(page.locator('[data-tour="masonry"]'), 200);
    assert.ok(columns > previous); previous = columns;
    // 700px exercises the grid below the native window's 900px minimum.
    if (width >= 900) {
      const topbar = await page.locator('.app-topbar').evaluate(el => {
        const search = el.querySelector('.app-search').getBoundingClientRect();
        const actions = el.querySelector('.app-topbar-actions').getBoundingClientRect();
        return { overflow: el.scrollWidth > el.clientWidth, overlap: search.left < actions.right && search.right > actions.left && search.top < actions.bottom && search.bottom > actions.top };
      });
      assert.deepEqual(topbar, { overflow: false, overlap: false });
    }
  }
  await page.evaluate(() => window.store.setState({ projectAssetsCollapsed: false,
    libraryMemberships: window.store.getState().assets.slice(0, 12).map(a => ({ assetId: a.id, projectId: "p" })) }));
  for (const width of [900, 1500, 1000]) {
    await page.setViewportSize({ width, height: 900 });
    for (const grid of await page.locator('[data-tour="masonry"]').all()) await geometry(grid, 200);
  }
  const homeSlider = page.getByRole("slider", { name: "主页素材大小" });
  await homeSlider.fill("120");
  const dense = await geometry(page.locator('[data-tour="masonry"]').first(), 120);
  await homeSlider.fill("280");
  const sparse = await geometry(page.locator('[data-tour="masonry"]').first(), 280);
  assert.ok(sparse < dense);
  await homeSlider.focus(); await page.keyboard.press("ArrowLeft");
  assert.equal(await homeSlider.inputValue(), "272");
  await page.reload(); await page.locator('[data-asset-id="one"]').waitFor();
  assert.equal(await homeSlider.inputValue(), "272", "homepage size survives reload");
  await homeSlider.fill("200");
  await mkdir(".tmp/library-layout", { recursive: true });
  await geometry(page.locator('[data-tour="masonry"]').first(), 200);
  await page.waitForFunction(() => [...document.querySelectorAll('[data-asset-id] img')].filter(img => img.getBoundingClientRect().top < innerHeight).every(img => img.complete && img.naturalWidth > 0));
  await page.screenshot({ path: ".tmp/library-layout/home.png" });
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto(root + "canvas-reference/preview.html?source-library");
  const panel = page.getByRole("complementary", { name: "画板素材库" });
  const resizer = page.getByRole("separator", { name: "调整素材面板宽度" });
  const resize = async (key, steps) => { await resizer.focus(); for (let i = 0; i < steps; i++) await page.keyboard.press(key); };
  await panel.locator('[data-asset-id="existing"]').waitFor();
  for (const scope of ["项目素材", "中央素材"]) {
    await panel.getByRole("tab", { name: scope }).click();
    for (const width of [104, 160, 208, 320]) {
      await panel.getByRole("slider", { name: "项目素材大小" }).fill(String(width));
      await resize("ArrowLeft", 40);
      const narrow = await geometry(panel.locator('[data-tour="masonry"]'), width);
      await resize("ArrowRight", 30);
      const wide = await geometry(panel.locator('[data-tour="masonry"]'), width);
      assert.ok(wide > narrow);
      await page.setViewportSize({ width: 1250, height: 760 });
      await geometry(panel.locator('[data-tour="masonry"]'), width);
      await page.setViewportSize({ width: 1500, height: 900 });
    }
  }
  // Two columns stretch before the third fits; adding a column returns cards toward the target width.
  await panel.getByRole("slider", { name: "项目素材大小" }).fill("160");
  const grid = panel.locator('[data-tour="masonry"]');
  const setPanelWidth = async width => {
    await page.locator('.canvas-workspace').evaluate((el, width) => el.style.gridTemplateColumns = `${width}px 7px minmax(0, 1fr)`, width);
    return geometry(grid, 160);
  };
  assert.equal(await setPanelWidth(400), 2);
  const firstWidth = (await panel.locator('[data-asset-id]').first().boundingBox()).width;
  assert.equal(await setPanelWidth(480), 2);
  const stretched = (await panel.locator('[data-asset-id]').first().boundingBox()).width;
  assert.ok(stretched > firstWidth);
  assert.equal(await setPanelWidth(540), 3);
  assert.ok((await panel.locator('[data-asset-id]').first().boundingBox()).width < stretched);
  await panel.getByRole("slider", { name: "项目素材大小" }).fill("240");
  await page.reload(); await panel.locator('[data-asset-id="existing"]').waitFor();
  assert.equal(await panel.getByRole("slider", { name: "项目素材大小" }).inputValue(), "240");
  assert.equal(await page.evaluate(() => window.store.getState().libraryThumbnailWidth), 200, "scopes remember independent sizes");
  await panel.getByRole("tab", { name: "中央素材" }).click();
  const trigger = panel.getByRole("button", { name: "分类标签", exact: true });
  const popup = page.getByRole("dialog", { name: "分类标签", exact: true });
  await trigger.click();
  await popup.getByRole("button", { name: "建筑", exact: true }).waitFor();
  assert.equal(await popup.locator('.canvas-source-tag-grid').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 2);
  await popup.getByRole("button", { name: "插画", exact: true }).click();
  assert.equal(await page.evaluate(() => window.store.getState().smartFilter), "tag:插画");
  await page.waitForFunction(() => window.calls.some(c => c.command === "list_assets_smart" && c.args.query === "tag:插画" && c.args.projectId === null));
  await page.waitForFunction(() => document.querySelectorAll('.canvas-source-panel [data-asset-id]').length === 1);
  await trigger.click();
  assert.equal(await popup.getByRole("button", { name: "插画", exact: true }).getAttribute("aria-pressed"), "true");
  await popup.getByRole("button", { name: "清除筛选 · 插画", exact: true }).click();
  assert.equal(await page.evaluate(() => window.store.getState().smartFilter), null);
  await panel.getByRole("button", { name: "测试文件夹", exact: true }).click();
  await trigger.click();
  await popup.getByRole("button", { name: "插画", exact: true }).click();
  assert.equal(await panel.getByRole("button", { name: "测试文件夹", exact: true }).getAttribute("aria-pressed"), "false");
  await panel.getByRole("button", { name: "测试文件夹", exact: true }).click();
  assert.equal(await page.evaluate(() => window.store.getState().smartFilter), null);
  await panel.getByRole("button", { name: "全部", exact: true }).click();
  await panel.getByRole("tab", { name: "项目素材" }).click();
  await page.evaluate(() => window.store.getState().setSearchQuery("旧搜索"));
  await trigger.click();
  await popup.getByRole("button", { name: "建筑", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => [window.store.getState().smartFilter, window.store.getState().searchQuery]), ["tag:建筑", ""]);
  await trigger.focus(); await page.keyboard.press("Enter"); await popup.waitFor();
  await page.keyboard.press("Escape"); await popup.waitFor({ state: "hidden" });
  assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
  await trigger.click(); await panel.getByRole("tab", { name: "中央素材" }).click(); await popup.waitFor({ state: "hidden" });
  await page.evaluate(() => window.failTags = true); await trigger.click(); await popup.getByRole("alert").waitFor();
  await page.evaluate(() => { window.failTags = false; window.testTags = []; });
  await popup.getByRole("button", { name: "重试", exact: true }).click(); await popup.getByText("暂无分类标签").waitFor();
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.testTags = Array.from({ length: 70 }, (_, i) => ({ id: `tag-${i}`, name: i === 0 ? "很长的分类标签也需要完整展示并且能够正常点击" : `分类 ${i}`, count: 0 })));
  await resize("ArrowLeft", 40); await trigger.click(); await popup.getByRole("button", { name: "分类 69", exact: true }).waitFor();
  const bounds = await popup.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 1500 && bounds.y + bounds.height <= 900);
  assert.equal(await popup.locator('.canvas-source-tag-grid').evaluate(el => el.scrollHeight > el.clientHeight && el.scrollWidth <= el.clientWidth), true);
  await page.screenshot({ path: ".tmp/library-layout/tags-light.png" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.screenshot({ path: ".tmp/library-layout/tags-dark.png" });
  await popup.getByRole("button", { name: "分类 69", exact: true }).click();
  assert.equal(await page.evaluate(() => window.store.getState().smartFilter), "tag:分类 69");
  await page.evaluate(() => { localStorage.removeItem("bowerbird.canvasThumbnailWidth"); localStorage.setItem("bowerbird.canvasSourceThumbnailScale", "3"); });
  await page.reload(); await panel.locator('[data-asset-id="existing"]').waitFor();
  assert.equal(await panel.getByRole("slider", { name: "项目素材大小" }).inputValue(), "208", "legacy size choice is preserved");
  assert.deepEqual(errors, []);
  console.log("PASS: adjustable target widths/fluid columns, homepage/projects/both source scopes; tag catalogue/filter/clear/keyboard/outside/error/empty/scroll.");
} finally { await browser.close(); await server.close(); }
