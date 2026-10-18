import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1587, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
async function geometry() {
  return page.locator(".masonry-layout").first().evaluate(grid => ({
    width: grid.clientWidth, columns: Number(grid.dataset.columns),
    cards: [...grid.children].map(cell => {
      const card = cell.querySelector("[data-asset-id]");
      const img = card.querySelector("img");
      return { width: card.getBoundingClientRect().width, height: card.getBoundingClientRect().height,
        imageWidth: img.getBoundingClientRect().width, position: cell.style.transform };
    }),
  }));
}
try {
  await page.goto("http://127.0.0.1:1587/scripts/fixtures/project-drop/preview.html?layout");
  await page.locator('[data-asset-id="one"]').waitFor();
  // A fixed near-threshold content width, with mixed aspect ratios to expose
  // shortest-column redistribution when selection changes a card's height.
  await page.evaluate(() => {
    const base = window.store.getState().assets[0];
    const assets = Array.from({ length: 15 }, (_, i) => ({ ...base, id: `selection-${i}`, height: 120 + i % 4 * 60 }));
    window.store.setState({ assets, total: assets.length, libraryMemberships: [], libraryThumbnailWidth: 200 });
    document.querySelector("main").style.cssText += ";flex:none;width:1064px";
  });
  await page.waitForTimeout(650);
  const before = await geometry();
  await page.evaluate(() => window.store.getState().enterManage());
  await page.locator('[data-asset-id="selection-0"]').click();
  await page.locator('[data-asset-id="selection-3"]').click({ modifiers: ["Shift"] });
  await page.waitForTimeout(650);
  assert.deepEqual((await geometry()).cards, before.cards, "multi-selection must not resize images or redistribute cards");
  await page.evaluate(() => window.store.getState().clearSelect());
  await page.waitForTimeout(350);
  assert.deepEqual((await geometry()).cards, before.cards, "clearing selection preserves geometry");

  // Move the viewport across the vertical-overflow threshold without changing
  // its outer width, as mounting/unmounting the batch bar does in the app.
  const scroller = page.locator(".library-home .library-scroller").first();
  await scroller.evaluate(el => { el.style.flex = "none"; el.style.height = `${el.scrollHeight + 20}px`; });
  await page.waitForTimeout(650);
  const withoutOverflow = await geometry();
  assert.equal(await scroller.evaluate(el => el.scrollHeight > el.clientHeight), false);
  await scroller.evaluate(el => { el.style.height = "240px"; });
  await page.waitForTimeout(650);
  const withOverflow = await geometry();
  assert.equal(await scroller.evaluate(el => el.scrollHeight > el.clientHeight), true);
  assert.equal(await scroller.evaluate(el => el.offsetWidth - el.clientWidth), 0, "overlay reserves no horizontal gutter");
  assert.equal(withOverflow.width, withoutOverflow.width, "scrollbar appearance never consumes content width");
  assert.equal(withOverflow.columns, withoutOverflow.columns, "vertical overflow never changes column count");
  assert.deepEqual(withOverflow.cards, withoutOverflow.cards, "vertical overflow never moves cards");
  const rail = page.getByRole("scrollbar", { name: "素材滚动条", exact: true });
  await rail.focus();
  await page.keyboard.press("End");
  await page.waitForTimeout(100);
  assert.ok(await scroller.evaluate(el => el.scrollTop > 0), "overlay supports keyboard scrolling");
  await page.keyboard.press("Home");
  const thumb = rail.locator(".collection-scroll-thumb");
  const box = await thumb.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 70, { steps: 8 });
  await page.mouse.up();
  assert.ok(await scroller.evaluate(el => el.scrollTop > 0), "overlay thumb supports dragging");
  await page.mouse.move(500, 500);
  await rail.blur();
  await page.waitForTimeout(1050);
  assert.equal(await rail.evaluate(el => getComputedStyle(el).opacity), "0", "idle overlay fades out");
  await rail.hover();
  await page.waitForTimeout(200);
  assert.equal(await rail.evaluate(el => getComputedStyle(el).opacity), "1", "right-edge hover reveals the overlay");
  const afterHover = await geometry();
  assert.deepEqual(afterHover, withOverflow, "overlay visibility never changes grid geometry");
  await scroller.evaluate(el => { el.style.removeProperty("flex"); el.style.removeProperty("height"); el.scrollTop = 0; });
  await page.locator('[data-asset-id="selection-0"]').click();
  await page.locator('[data-asset-id="selection-3"]').click({ modifiers: ["Shift"] });
  await page.waitForTimeout(350);
  await mkdir(".tmp/library-selection", { recursive: true });
  await page.screenshot({ path: ".tmp/library-selection/light.png" });
  await page.evaluate(() => document.documentElement.dataset.theme = "dark");
  await page.screenshot({ path: ".tmp/library-selection/dark.png" });
  assert.deepEqual(errors, []);
  console.log("PASS library selection geometry, overflow width/columns and overlay keyboard/drag scrolling");
} finally { await browser.close(); await server.close(); }
