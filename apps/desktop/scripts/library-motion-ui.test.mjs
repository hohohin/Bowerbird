import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";
const server = await createServer({ server: { host: "127.0.0.1", port: 1581, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = []; page.on("pageerror", error => errors.push(error.message));
await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
try {
  await page.goto("http://127.0.0.1:1581/scripts/fixtures/project-drop/preview.html?layout");
  await page.locator('[data-asset-id="one"]').waitFor();
  await page.evaluate(() => {
    const base = window.store.getState().assets[0];
    const assets = Array.from({ length: 32 }, (_, i) => ({ ...base, id: `motion-${i}`, height: 100 + i % 4 * 60,
      colors: i % 2 ? JSON.stringify(["#aabbcc"]) : null }));
    window.store.setState({ assets, total: assets.length, libraryMemberships: [], libraryThumbnailWidth: 160 });
  });
  await page.locator('[data-asset-id="motion-0"]').waitFor();
  assert.equal(await page.locator('.masonry-cell').evaluateAll(cells => cells.flatMap(cell => cell.getAnimations()).length), 0, "new images appear directly in their first position");
  await page.waitForTimeout(650);
  await page.locator('[data-asset-id="motion-0"]').focus();
  await page.evaluate(() => window.motionImages = [...document.querySelectorAll('[data-asset-id] img')]);
  const frames = await page.evaluate(async () => {
    const grid = document.querySelector('[data-tour="masonry"]');
    const samples = [];
    const start = performance.now();
    window.store.getState().setThumbnailWidth("library", 320);
    while (performance.now() - start < 650) {
      await new Promise(requestAnimationFrame);
      samples.push({ width: grid.firstElementChild.getBoundingClientRect().width, columns: Number(grid.dataset.columns) });
    }
    return samples;
  });
  assert.ok(new Set(frames.map(f => f.width.toFixed(1))).size > 5, "width must visibly interpolate through intermediate sizes");
  assert.ok(frames.at(-1).width > frames[0].width);
  assert.ok(frames.at(-1).columns < frames[0].columns);
  for (let i = 1; i < frames.length; i++) {
    assert.ok(frames[i].width + 0.1 >= frames[i - 1].width, "growth is monotonic");
    assert.ok(frames[i].columns <= frames[i - 1].columns, "columns change only in the resizing direction");
  }
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.assetId), "motion-0", "reflow preserves keyboard focus");
  assert.equal(await page.evaluate(() => window.motionImages.every((image, i) => image === document.querySelectorAll('[data-asset-id] img')[i])), true, "reflow preserves image elements");
  const reversal = await page.evaluate(async () => {
    const cell = document.querySelector('.masonry-cell');
    window.store.getState().setThumbnailWidth("library", 96);
    await new Promise(resolve => setTimeout(resolve, 80));
    const before = cell.getBoundingClientRect().width;
    window.store.getState().setThumbnailWidth("library", 320);
    await new Promise(requestAnimationFrame);
    return { before, after: cell.getBoundingClientRect().width };
  });
  assert.ok(Math.abs(reversal.after - reversal.before) < 40, "reversing an active transition starts from its visible size");
  await page.waitForTimeout(650);
  const overlap = await page.locator('.masonry-layout').evaluate(grid => {
    const boxes = [...grid.children].map(cell => cell.getBoundingClientRect());
    return boxes.some((a, i) => boxes.slice(i + 1).some(b => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1));
  });
  assert.equal(overlap, false, "mixed ratios and color strips must not overlap after settling");
  await mkdir('.tmp/library-layout', { recursive: true });
  await page.screenshot({ path: '.tmp/library-layout/motion-settled.png' });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => window.store.getState().setThumbnailWidth("library", 160));
  await page.waitForTimeout(80);
  assert.equal(await page.locator('.masonry-layout').evaluate(grid => grid.getAnimations({ subtree: true }).length), 0, "reduced motion disables layout transitions");
  assert.deepEqual(errors, []);
  console.log("PASS masonry motion: intermediate widths, threshold column changes, stable images/focus, mid-transition reversal, measured heights and reduced motion.");
} finally { await browser.close(); await server.close(); }
