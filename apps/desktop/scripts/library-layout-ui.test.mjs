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
      columns: Number(el.dataset.columns), available, overflow: el.scrollWidth > el.clientWidth + 1,
      scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
  });
  assert.ok(result.widths.length > 0 && result.widths.every(actual => Math.abs(actual - result.widths[0]) < 0.1), JSON.stringify(result));
  assert.ok(result.widths[0] >= Math.min(width, result.available) - 0.1, JSON.stringify(result));
  assert.ok(Math.abs(result.widths[0] * result.columns + (result.columns - 1) * 8 - result.available) < 1, "columns fill remaining space");
  assert.equal(result.overflow, false, JSON.stringify(result));
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
// Geometry/gesture cases operate on stored pixel widths. Control interaction
// cases below separately exercise the public 0–100 mapping.
async function fillWidth(slider, value) {
  await slider.evaluate((el, width) => window.store.getState().setThumbnailWidth(
    el.getAttribute("aria-label") === "主页素材大小" ? "library" : "canvas", Number(width)), value);
}
async function readWidth(slider) {
  return slider.evaluate(el => String(window.store.getState()[
    el.getAttribute("aria-label") === "主页素材大小" ? "libraryThumbnailWidth" : "canvasThumbnailWidth"]));
}
async function checkPinch(target, slider, scope) {
  const minimum = scope === "canvas" ? 48 : 96;
  const other = scope === "library" ? "canvasThumbnailWidth" : "libraryThumbnailWidth";
  const otherWidth = await page.evaluate(key => window.store.getState()[key], other);
  await fillWidth(slider, "160");
  assert.equal(await pinchWheel(target, -20, false), false, "ordinary scroll is not consumed");
  assert.equal(await readWidth(slider), "160");
  assert.equal(await pinchWheel(target, -20), true, "pinch prevents page zoom");
  assert.ok(Number(await readWidth(slider)) > 160, "spread enlarges thumbnails");
  await pinchWheel(target, 20);
  assert.equal(await readWidth(slider), "160", "pinch shrinks thumbnails");
  assert.equal(await pinchWheel(target, -20, false, 0, 1, true), true, "Cmd+wheel is consumed");
  assert.ok(Number(await readWidth(slider)) > 160, "Cmd+wheel enlarges thumbnails");
  await pinchWheel(target, 20, false, 0, 1, true);
  assert.equal(await readWidth(slider), "160", "Cmd+wheel shrinks thumbnails");
  await pinchWheel(target, -0.1, true, 0, 40);
  assert.ok(Number(await readWidth(slider)) > 160, "small deltas accumulate across rounding steps");
  await fillWidth(slider, "160"); await pinchWheel(target, -120);
  assert.ok(Number(await readWidth(slider)) > 160 && Number(await readWidth(slider)) <= 184, "mouse notch changes size gradually");
  await fillWidth(slider, "320"); await pinchWheel(target, -100);
  assert.equal(await readWidth(slider), "320");
  await pinchWheel(target, 8);
  assert.ok(Number(await readWidth(slider)) < 320, "reversing at upper limit responds immediately");
  await fillWidth(slider, minimum); await pinchWheel(target, 100);
  assert.equal(await readWidth(slider), String(minimum));
  await pinchWheel(target, -8);
  assert.ok(Number(await readWidth(slider)) > minimum);
  await fillWidth(slider, "160"); await pinchWheel(target, -1, true, 1);
  assert.ok(Number(await readWidth(slider)) > 160, "line deltas are normalized");
  await fillWidth(slider, "160");
  assert.equal(await gesture(target, "gesturestart"), true);
  await gesture(target, "gesturechange", 1.25);
  assert.equal(await readWidth(slider), "200");
  await gesture(target, "gesturechange", 1.5);
  assert.equal(await readWidth(slider), "240", "WebKit scale is cumulative from gesture start");
  await pinchWheel(target, -20);
  assert.equal(await readWidth(slider), "240", "duplicate wheel stream is ignored during WebKit gesture");
  await gesture(target, "gesturechange", 0.75);
  assert.equal(await readWidth(slider), "120");
  await gesture(target, "gesturechange", 0);
  assert.equal(await readWidth(slider), "120");
  assert.equal(await gesture(target, "gestureend", 0.75), true);
  assert.equal(await gesture(target, "gesturechange", 2), false, "ended gestures cannot change size");
  await gesture(target, "gesturestart"); await gesture(target, "gesturechange", 2);
  assert.equal(await readWidth(slider), "240", "next gesture starts from current width");
  await gesture(target, "gestureend", 2);
  assert.equal(await page.evaluate(key => window.store.getState()[key], other), otherWidth, "preferences stay scoped");
  assert.equal(await page.evaluate(key => localStorage.getItem(`bowerbird.${key}ThumbnailWidth`), scope), "240");
}
async function checkNumericSize(scope) {
  const label = scope === "library" ? "主页素材大小" : "项目素材大小";
  const slider = page.getByRole("slider", { name: label, exact: true });
  const number = page.getByRole("spinbutton", { name: `${label}数值`, exact: true });
  const bar = slider.locator("xpath=ancestor::*[contains(@class, 'thumbnail-size-slider')]");
  const bounds = await bar.boundingBox();
  assert.equal(bounds.width, 150, "new controls fit inside the original bar width");
  assert.ok(Math.abs(bounds.height - 19.6) < 0.1, "bar height remains unchanged");
  const minimum = scope === "canvas" ? 48 : 96;
  await number.fill("50"); await number.press("Enter");
  assert.equal(await readWidth(slider), scope === "canvas" ? "184" : "208", "50 maps to the middle of each width range");
  assert.equal(await number.inputValue(), "50");
  assert.equal(await slider.inputValue(), "50");
  await number.fill("999"); await number.blur();
  assert.equal(await readWidth(slider), "320", "manual input clamps to maximum");
  assert.equal(await number.inputValue(), "100");
  await number.fill("-12"); await number.press("Enter");
  assert.equal(await readWidth(slider), String(minimum), "manual input clamps to the scoped minimum");
  await number.fill(""); await number.blur();
  assert.equal(await number.inputValue(), "0", "empty input restores the last size");
  await number.fill("23"); await number.press("Escape"); await number.blur();
  assert.equal(await readWidth(slider), String(minimum), "Escape cancels manual edits");
  await slider.fill("75");
  assert.equal(await number.inputValue(), "75", "range changes update the numeric value");
  await number.fill("20"); await number.press("ArrowUp"); await number.press("Enter");
  assert.equal(await slider.inputValue(), "21", "numeric keyboard advances one mapped unit");
  await slider.fill("0");
  assert.equal(await readWidth(slider), String(minimum));
  await slider.focus(); await slider.press("ArrowRight");
  assert.equal(await number.inputValue(), "1", "all integer mapping values are reachable without snapping back");
  await slider.fill("100");
  assert.equal(await readWidth(slider), "320");
  await fillWidth(slider, "200");
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
  await checkNumericSize("library");
  await checkPinch(page.locator('[data-asset-id]').first(), initialSlider, "library");
  assert.equal(await pinchWheel(page.locator('.app-topbar'), -20), false, "toolbar is outside the pinch region");
  assert.equal(await readWidth(initialSlider), "240");
  await fillWidth(initialSlider, "200");
  const scrollArea = page.locator('.library-home .library-scroller').first();
  await scrollArea.hover(); await page.mouse.wheel(0, 300);
  await page.waitForFunction(() => document.querySelector('.library-home .library-scroller').scrollTop > 0);
  assert.equal(await readWidth(initialSlider), "200", "real wheel scrolling leaves thumbnail size unchanged");
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
  await checkPinch(page.locator('.library-home [data-asset-id]').first(), homeSlider, "library");
  const sliderBounds = await homeSlider.boundingBox();
  await homeSlider.click({ position: { x: sliderBounds.width - 5, y: sliderBounds.height / 2 } });
  assert.ok(Number(await readWidth(homeSlider)) >= 304, "custom track remains pointer-operable");
  await page.mouse.move(sliderBounds.x + sliderBounds.width - 5, sliderBounds.y + sliderBounds.height / 2);
  await page.mouse.down(); await page.mouse.move(sliderBounds.x + 4, sliderBounds.y + sliderBounds.height / 2, { steps: 8 }); await page.mouse.up();
  assert.ok(Number(await readWidth(homeSlider)) <= 112, "circular thumb can be dragged");
  await fillWidth(homeSlider, "120");
  const dense = await geometry(page.locator('[data-tour="masonry"]').first(), 120);
  await fillWidth(homeSlider, "280");
  const sparse = await geometry(page.locator('[data-tour="masonry"]').first(), 280);
  assert.ok(sparse < dense);
  await homeSlider.focus(); await page.keyboard.press("ArrowLeft");
  const keyboardWidth = await readWidth(homeSlider);
  assert.ok(Number(keyboardWidth) < 280 && Number(keyboardWidth) > 272);
  await page.reload(); await page.locator('[data-asset-id="one"]').waitFor();
  assert.equal(await readWidth(homeSlider), keyboardWidth, "homepage size survives reload");
  await fillWidth(homeSlider, "200");
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
  await page.getByRole('button', { name: '展开画板素材库' }).click();
  await panel.locator('[data-asset-id="existing"]').waitFor();
  for (const scope of ['项目素材', '全局素材']) {
    await panel.getByRole('tab', { name: scope }).click();
    await checkNumericSize('canvas');
    const canvasTransform = await page.locator('.canvas-plane').getAttribute('style');
    await checkPinch(panel.locator('[data-asset-id]').first(), panel.getByRole('slider', { name: '项目素材大小' }), 'canvas');
    assert.equal(await page.locator('.canvas-plane').getAttribute('style'), canvasTransform, 'library pinch leaves canvas unchanged');
    for (const width of [48, 64, 104, 160, 208, 320]) {
      await fillWidth(panel.getByRole('slider', { name: '项目素材大小' }), String(width));
      await page.setViewportSize({ width: 900, height: 760 });
      const narrow = await geometry(panel.locator('[data-tour="masonry"]'), width);
      await page.setViewportSize({ width: 1500, height: 900 });
      const wide = await geometry(panel.locator('[data-tour="masonry"]'), width);
      assert.ok(wide > narrow);
    }
  }
  await fillWidth(panel.getByRole('slider', { name: '项目素材大小' }), '240');
  await page.reload();
  await page.getByRole('button', { name: '展开画板素材库' }).click();
  await panel.locator('[data-asset-id="existing"]').waitFor();
  assert.equal(await readWidth(panel.getByRole('slider', { name: '项目素材大小' })), '240');
  assert.equal(await page.evaluate(() => window.store.getState().libraryThumbnailWidth), 200);
  await panel.getByRole('tab', { name: '全局素材' }).click();
  const menu = panel.getByRole('navigation', { name: '分类标签' });
  async function revealTags() {
    const edge = await panel.locator('.library-tag-bar').boundingBox();
    await page.mouse.move(edge.x + edge.width - 2, edge.y + 10);
    await menu.waitFor({ state: 'visible' });
  }
  await revealTags();
  await menu.getByRole('button', { name: '插画', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.canvas-source-panel [data-asset-id]').length === 1);
  assert.equal(await menu.getByRole('button', { name: '插画', exact: true }).getAttribute('aria-pressed'), 'true');
  await menu.getByRole('button', { name: '插画', exact: true }).click();
  await panel.getByRole('button', { name: '测试文件夹', exact: true }).click();
  await revealTags();
  await menu.getByRole('button', { name: '插画', exact: true }).click();
  assert.equal(await panel.getByRole('button', { name: '测试文件夹', exact: true }).getAttribute('aria-pressed'), 'false');
  await panel.getByRole('button', { name: '测试文件夹', exact: true }).click();
  assert.equal(await page.evaluate(() => window.store.getState().smartFilter), null);
  await panel.getByRole('group', { name: '全局素材文件夹' }).getByRole('button', { name: '测试文件夹', exact: true }).click();
  await page.evaluate(() => window.failTags = true);
  await panel.getByRole('tab', { name: '项目素材' }).click();
  await revealTags();
  await menu.getByRole('button', { name: '标签加载失败 · 重试', exact: true }).waitFor();
  await page.evaluate(() => { window.failTags = false; window.testTags = []; });
  await menu.getByRole('button', { name: '标签加载失败 · 重试', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.library-tag-menu button').length === 0);
  await page.evaluate(() => window.testTags = Array.from({ length: 70 }, (_, i) => ({ id: `tag-${i}`, name: i === 0 ? '很长的分类标签也需要完整展示并且能够正常点击' : `分类 ${i}`, count: 0 })));
  await panel.getByRole('tab', { name: '全局素材' }).click();
  await revealTags();
  await menu.getByRole('button', { name: '分类 69', exact: true }).waitFor();
  await page.setViewportSize({ width: 900, height: 760 });
  await revealTags();
  assert.equal(await menu.evaluate(el => el.scrollHeight > el.clientHeight), true);
  assert.equal(await panel.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await page.screenshot({ path: '.tmp/library-layout/tags-light.png' });
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await page.screenshot({ path: '.tmp/library-layout/tags-dark.png' });
  await menu.getByRole('button', { name: '分类 69', exact: true }).click();
  assert.equal(await page.evaluate(() => window.store.getState().smartFilter), 'tag:分类 69');
  assert.deepEqual(errors, []);
  console.log('PASS: mapped sizing, pinch/scroll isolation, fluid full-width columns, scoped persistence, fixed tag menu/filter/clear/error/empty/overflow.');
} finally { await browser.close(); await server.close(); }
