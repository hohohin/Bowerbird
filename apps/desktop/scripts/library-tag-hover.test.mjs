import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1592, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.setDefaultTimeout(5000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
try {
  await page.goto("http://127.0.0.1:1592/scripts/fixtures/project-drop/preview.html?layout");
  const home = page.locator(".library-home");
  await home.locator('[data-asset-id="owned"]').waitFor();
  await page.evaluate(() => {
    const template = window.store.getState().assets[0];
    window.testTags = ["海报", "字体排版", "场景产品图"].map((name, i) => ({ id: `tag-${i}`, name, count: 0 }));
    window.store.setState({ autoTags: [], assets: Array.from({ length: 80 }, (_, i) => ({ ...template, id: `hover-${i}` })), total: 80 });
  });
  const bar = home.locator(".library-tag-bar");
  const content = bar.locator(".library-tag-content");
  const rail = home.locator(".library-scroll-area .collection-scroll-rail");
  await rail.waitFor({ state: "attached" });
  const edge = await bar.boundingBox();
  const point = { x: edge.x + edge.width - 8, y: edge.y + 10 };
  assert.equal(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest(".collection-scroll-rail"), point), true,
    "reproduce a real pointer hit inside the transparent scrollbar, not the strip beside it");
  await page.mouse.move(point.x, point.y);
  await content.waitFor({ state: "visible" });
  await bar.getByRole("button", { name: "海报", exact: true }).waitFor();

  // Hovering the rail reveals labels; actually pressing/dragging it still scrolls.
  const view = home.locator(".library-scroller");
  const before = await view.evaluate(el => el.scrollTop);
  await page.mouse.down();
  await page.mouse.move(point.x, point.y + 45, { steps: 5 });
  await content.waitFor({ state: "hidden" });
  assert.ok(await view.evaluate(el => el.scrollTop) > before, "scrollbar drag remains operable");
  await page.mouse.up();
  await page.mouse.move(point.x, point.y);
  await content.waitFor({ state: "visible" });
  await page.mouse.move(edge.x - 30, point.y);
  await content.waitFor({ state: "hidden" });

  // Check the entire promised activation strip, including the exact outer edge.
  for (const inset of [20, 14, 8, 2]) {
    await page.mouse.move(edge.x - 30, point.y);
    await content.waitFor({ state: "hidden" });
    await page.mouse.move(edge.x + edge.width - inset, point.y);
    await content.waitFor({ state: "visible" });
  }
  await content.evaluate(async el => {
    await Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {})));
  });
  assert.equal(await content.evaluate(el => getComputedStyle(el).opacity), "1", "revealed labels finish fully visible");
  await mkdir(".tmp/library-pages", { recursive: true });
  await page.screenshot({ path: ".tmp/library-pages/tag-hover-scrollbar.png" });
  assert.deepEqual(errors, []);
  console.log("PASS tag hover: overflowing library, transparent scrollbar, full activation strip, drag scrolling and leave/re-enter");
} finally {
  await browser.close();
  await server.close();
}
