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
  await grid.evaluate(async el => {
    const workspace = el.closest(".canvas-workspace");
    if (workspace) await Promise.all(workspace.getAnimations().map(animation => animation.finished.catch(() => {})));
  });
  await page.waitForTimeout(600);
  const result = await grid.evaluate(el => {
    const style = getComputedStyle(el);
    const available = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return { widths: [...el.querySelectorAll('[data-asset-id]')].map(card => card.getBoundingClientRect().width),
      columns: Number(el.dataset.columns), available, overflow: el.scrollWidth > el.clientWidth + 1 };
  });
  assert.ok(result.widths.length > 0 && result.widths.every(actual => Math.abs(actual - result.widths[0]) < 0.1), JSON.stringify(result));
  assert.ok(result.widths[0] >= Math.min(width, result.available) - 0.1, JSON.stringify(result));
  assert.ok(Math.abs(result.widths[0] * result.columns + (result.columns - 1) * 8 - result.available) < 1, "columns fill remaining space");
  assert.equal(result.overflow, false);
  return result.columns;
}
async function pinchWheel(target, deltaY, ctrlKey = true, deltaMode = 0, count = 1, metaKey = false) {
  return target.evaluate((el, args) => {
    let prevented = false;
    for (let i = 0; i < args.count; i++) {
      const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...args });
      el.dispatchEvent(event); prevented = event.defaultPrevented;
    }
    return prevented;
  }, { deltaY, ctrlKey, deltaMode, count, metaKey });
}
async function gesture(target, type, scale = 1) {
  return target.evaluate((el, { type, scale }) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "scale", { value: scale });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  }, { type, scale });
}
async function checkPinch(target, slider, scope) {
  const other = scope === "library" ? "canvasThumbnailWidth" : "libraryThumbnailWidth";
  const otherWidth = await page.evaluate(key => window.store.getState()[key], other);
  await slider.fill("160");
  assert.equal(await pinchWheel(target, -20, false), false, "ordinary scroll is not consumed");
  assert.equal(await slider.inputValue(), "160");
  assert.equal(await pinchWheel(target, -20), true, "pinch prevents page zoom");
  assert.ok(Number(await slider.inputValue()) > 160, "spread enlarges thumbnails");
  await pinchWheel(target, 20);
  assert.equal(await slider.inputValue(), "160", "pinch shrinks thumbnails");
  assert.equal(await pinchWheel(target, -20, false, 0, 1, true), true, "Cmd+wheel is consumed");
  assert.ok(Number(await slider.inputValue()) > 160, "Cmd+wheel enlarges thumbnails");
  await pinchWheel(target, 20, false, 0, 1, true);
  assert.equal(await slider.inputValue(), "160", "Cmd+wheel shrinks thumbnails");
  await pinchWheel(target, -0.1, true, 0, 40);
  assert.ok(Number(await slider.inputValue()) > 160, "small deltas accumulate across rounding steps");
  await slider.fill("160"); await pinchWheel(target, -120);
  assert.ok(Number(await slider.inputValue()) > 160 && Number(await slider.inputValue()) <= 184, "mouse notch changes size gradually");
  await slider.fill("320"); await pinchWheel(target, -100);
  assert.equal(await slider.inputValue(), "320");
  await pinchWheel(target, 8);
  assert.ok(Number(await slider.inputValue()) < 320, "reversing at upper limit responds immediately");
  await slider.fill("96"); await pinchWheel(target, 100);
  assert.equal(await slider.inputValue(), "96");
  await pinchWheel(target, -8);
  assert.ok(Number(await slider.inputValue()) > 96);
  await slider.fill("160"); await pinchWheel(target, -1, true, 1);
  assert.ok(Number(await slider.inputValue()) > 160, "line deltas are normalized");
  await slider.fill("160");
  assert.equal(await gesture(target, "gesturestart"), true);
  await gesture(target, "gesturechange", 1.25);
  assert.equal(await slider.inputValue(), "200");
  await gesture(target, "gesturechange", 1.5);
  assert.equal(await slider.inputValue(), "240", "WebKit scale is cumulative from gesture start");
  await pinchWheel(target, -20);
  assert.equal(await slider.inputValue(), "240", "duplicate wheel stream is ignored during WebKit gesture");
  await gesture(target, "gesturechange", 0.75);
  assert.equal(await slider.inputValue(), "120");
  await gesture(target, "gesturechange", 0);
  assert.equal(await slider.inputValue(), "120");
  assert.equal(await gesture(target, "gestureend", 0.75), true);
  assert.equal(await gesture(target, "gesturechange", 2), false, "ended gestures cannot change size");
  await gesture(target, "gesturestart"); await gesture(target, "gesturechange", 2);
  assert.equal(await slider.inputValue(), "240", "next gesture starts from current width");
  await gesture(target, "gestureend", 2);
  assert.equal(await page.evaluate(key => window.store.getState()[key], other), otherWidth, "preferences stay scoped");
  assert.equal(await page.evaluate(key => localStorage.getItem(`bowerbird.${key}ThumbnailWidth`), scope), "240");
}
try {
  await page.goto(root + "project-drop/preview.html?layout");
  await page.locator('[data-asset-id="one"]').waitFor();
  await page.evaluate(() => {
    const base = window.store.getState().assets[0];
    const assets = Array.from({ length: 36 }, (_, i) => ({ ...base, id: `layout-${i}`, height: 120 + i % 4 * 60 }));
    window.store.setState({ assets, total: assets.length, libraryMemberships: [] });
  });
  const floatingSlider = page.locator('.thumbnail-size-slider.is-floating');
  assert.equal(await page.locator('.app-topbar input[type="range"]').count(), 0);
  assert.equal(await floatingSlider.getAttribute("title"), "素材缩略图大小调整");
  async function checkFloatingSlider() {
    const area = await page.locator('.library-home').boundingBox();
    const slider = await floatingSlider.boundingBox();
    assert.ok(Math.abs(area.x + area.width - slider.x - slider.width - 16) < 1);
    assert.ok(Math.abs(area.y + area.height - slider.y - slider.height - 16) < 1);
    assert.ok(slider.y + slider.height <= page.viewportSize().height);
    const scroller = page.locator('.library-home .library-scroller').first();
    await scroller.evaluate(el => el.scrollTop = el.scrollHeight);
    assert.deepEqual(await floatingSlider.boundingBox(), slider, "slider stays anchored while content scrolls");
    await scroller.evaluate(el => el.scrollTop = 0);
  }
  const initialSlider = page.getByRole("slider", { name: "主页素材大小" });
  await checkPinch(page.locator('[data-asset-id]').first(), initialSlider, "library");
  assert.equal(await pinchWheel(page.locator('.app-topbar'), -20), false, "toolbar is outside the pinch region");
  assert.equal(await initialSlider.inputValue(), "240");
  await initialSlider.fill("200");
  const scrollArea = page.locator('.library-home .library-scroller').first();
  await scrollArea.hover(); await page.mouse.wheel(0, 300);
  await page.waitForFunction(() => document.querySelector('.library-home .library-scroller').scrollTop > 0);
  assert.equal(await initialSlider.inputValue(), "200", "real wheel scrolling leaves thumbnail size unchanged");
  await scrollArea.evaluate(el => el.scrollTop = 0);
  let previous = 0;
  for (const width of [700, 1100, 1600, 2200]) {
    await page.setViewportSize({ width, height: 900 });
    const columns = await geometry(page.locator('[data-tour="masonry"]'), 200);
    assert.ok(columns > previous); previous = columns;
    await checkFloatingSlider();
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
    await checkFloatingSlider();
    for (const grid of await page.locator('[data-tour="masonry"]').all()) await geometry(grid, 200);
  }
  const homeSlider = page.getByRole("slider", { name: "主页素材大小" });
  await checkPinch(page.locator('.library-project-frame [data-asset-id]').first(), homeSlider, "library");
  await homeSlider.click({ position: { x: 114, y: 14 } });
  assert.ok(Number(await homeSlider.inputValue()) >= 304, "custom track remains pointer-operable");
  const sliderBounds = await homeSlider.boundingBox();
  await page.mouse.move(sliderBounds.x + 114, sliderBounds.y + 14);
  await page.mouse.down(); await page.mouse.move(sliderBounds.x + 6, sliderBounds.y + 14, { steps: 8 }); await page.mouse.up();
  assert.ok(Number(await homeSlider.inputValue()) <= 112, "circular thumb can be dragged");
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
  await homeSlider.blur();
  await page.screenshot({ path: ".tmp/library-layout/home.png" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.waitForTimeout(250);
  await page.screenshot({ path: ".tmp/library-layout/home-dark.png" });
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto(root + "canvas-reference/preview.html?source-library");
  const panel = page.getByRole("complementary", { name: "画板素材库" });
  const resizer = page.getByRole("separator", { name: "调整素材面板宽度" });
  const resize = async (key, steps) => { await resizer.focus(); for (let i = 0; i < steps; i++) await page.keyboard.press(key); };
  await panel.locator('[data-asset-id="existing"]').waitFor();
  for (const scope of ["项目素材", "中央素材"]) {
    await panel.getByRole("tab", { name: scope }).click();
    const canvasTransform = await page.locator('.canvas-plane').getAttribute("style");
    await checkPinch(panel.locator('[data-asset-id]').first(), panel.getByRole("slider", { name: "项目素材大小" }), "canvas");
    assert.equal(await page.locator('.canvas-plane').getAttribute("style"), canvasTransform, "library pinch does not zoom canvas");
    await pinchWheel(page.locator('[data-canvas-stage]'), -20);
    assert.equal(await panel.getByRole("slider", { name: "项目素材大小" }).inputValue(), "240", "canvas pinch leaves thumbnail size unchanged");
    for (const width of [104, 160, 208, 320]) {
      await panel.getByRole("slider", { name: "项目素材大小" }).fill(String(width));
      await resize("ArrowLeft", 40);
      const narrow = await geometry(panel.locator('[data-tour="masonry"]'), width);
      await resize("ArrowRight", 30);
      const wide = await geometry(panel.locator('[data-tour="masonry"]'), width);
      assert.ok(wide > narrow, JSON.stringify({ scope, width, wide, narrow, panel: await panel.boundingBox(), slider: await panel.getByRole("slider").inputValue(), state: await page.evaluate(() => window.store.getState().canvasThumbnailWidth), grid: await panel.locator('[data-tour="masonry"]').evaluate(el => ({ width: el.clientWidth, columns: el.dataset.columns })) }));
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
  console.log("PASS: wheel/WebKit pinch, limits/reversal/slow deltas, scroll/canvas isolation; adjustable target widths/fluid columns, homepage/projects/both source scopes; tag catalogue/filter/clear/keyboard/outside/error/empty/scroll.");
} finally { await browser.close(); await server.close(); }
