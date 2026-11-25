import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({
  cacheDir: ".tmp/explorer-sidebar-vite",
  plugins: [{
    name: "explorer-test-legacy-sidebar",
    // Mount the auto-hide drawer so its native overlap behavior remains
    // testable while collections are gated.
    transform(code, id) {
      if (id.endsWith("/src/lib/featureFlags.ts")) {
        return code.replace("COLLECTIONS_FEATURE_ENABLED = false", "COLLECTIONS_FEATURE_ENABLED = true");
      }
    },
  }],
  server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
});
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const geometry = () => page.evaluate(() => {
  const rect = document.querySelector("[data-source-browser-viewport]").getBoundingClientRect();
  const native = window.calls.filter(call => call.command === "resize_source_browser").at(-1)?.args;
  return { viewport: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }, native };
});
async function aligned(label) {
  // No DOM writes or window resize here: they would mask a missed position update.
  await page.waitForTimeout(260);
  const value = await geometry();
  const { x, y, width, height } = value.native?.bounds ?? {};
  assert.deepEqual({ x, y, width, height }, value.viewport, label);
  assert.equal(value.native.visible, true, `${label}: webpage restored`);
}
async function hideSidebar() {
  await page.mouse.click(500, 90);
  await page.waitForFunction(() => document.querySelector(".app-sidebar-host.is-auto-hidden"));
  await page.waitForFunction(() => document.querySelector(".app-sidebar-host").getBoundingClientRect().width <= 4.1);
}
async function revealSidebar() {
  await page.getByRole("button", { name: "显示侧栏", exact: true }).hover();
  await page.waitForFunction(() => !document.querySelector(".app-sidebar-host.is-auto-hidden"));
}
try {
  await page.goto(new URL("scripts/fixtures/explorer/preview.html?sidebar", server.resolvedUrls.local[0]).href);
  await page.getByRole("button", { name: "探索", exact: true }).click();
  await page.waitForFunction(() => window.calls.some(call => call.command === "resize_source_browser"));
  await hideSidebar();
  await aligned("collapsed sidebar auto-hide keeps native webpage inside its right-hand viewport");
  for (const expanded of [false, true]) {
    await revealSidebar();
    if (expanded) await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
    await aligned("sidebar reveal settles at the correct position");
    const before = await geometry();
    await hideSidebar();
    await aligned("sidebar slide-out keeps the right-hand webpage aligned");
    const after = await geometry();
    assert.deepEqual(after.viewport, before.viewport, "the left drawer does not change the right-hand viewport");
  }
  // Reverse the real CSS transition before it finishes; no transitionend dependency.
  await revealSidebar();
  await page.evaluate(() => {
    const host = document.querySelector(".app-sidebar-host");
    const drawer = host.querySelector(".app-sidebar");
    host.classList.add("is-auto-hidden"); drawer.classList.add("is-auto-hidden");
  });
  await page.waitForTimeout(60);
  await page.evaluate(() => {
    document.querySelector(".app-sidebar-host").classList.remove("is-auto-hidden");
    document.querySelector(".app-sidebar").classList.remove("is-auto-hidden");
  });
  await aligned("interrupted transition restores correct native bounds");
  await page.evaluate(() => {
    const viewport = document.querySelector("[data-source-browser-viewport]").getBoundingClientRect();
    const drawer = document.querySelector(".app-sidebar.is-auto-hide");
    const host = drawer.parentElement.getBoundingClientRect();
    drawer.style.left = `${viewport.left - host.left - drawer.getBoundingClientRect().width + 12}px`;
  });
  await page.waitForFunction(() => window.calls.filter(call => call.command === "resize_source_browser").at(-1)?.args.visible === false);
  await page.evaluate(() => document.querySelector(".app-sidebar.is-auto-hide").style.removeProperty("left"));
  await aligned("a drawer that actually intersects the webpage is handed back after it moves away");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await hideSidebar();
  await aligned("reduced motion also updates native bounds");
  const calls = await page.evaluate(() => window.calls);
  assert.equal(calls.filter(call => call.command === "open_source_browser").length, 1);
  assert.equal(calls.filter(call => ["navigate_source_browser", "reload_source_browser"].includes(call.command)).length, 0);
  const count = calls.filter(call => call.command === "resize_source_browser").length;
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === "resize_source_browser").length), count, "stable layout does not keep sending resize calls");
  assert.deepEqual(errors, []);
  console.log("PASS right-hand explorer stays aligned across sidebar changes and hides only when the drawer intersects it.");
} finally {
  await browser.close();
  await server.close();
}
