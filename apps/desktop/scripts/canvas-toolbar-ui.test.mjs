import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";
const server = await createServer({ server: { host: "127.0.0.1", port: 1554, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
const errors = []; page.on("pageerror", error => errors.push(error.message));
const bounds = () => page.locator(".canvas-board-toolbar > div").evaluateAll(elements => elements.map(element => {
  const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height };
}));
try {
  await page.goto("http://127.0.0.1:1554/scripts/fixtures/canvas-reference/preview.html");
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.waitForTimeout(400);
  const idle = await bounds();
  await page.evaluate(() => window.holdViewSave = true);
  await page.getByRole("button", { name: "放大", exact: true }).click();
  await page.waitForFunction(() => window.releaseViewSave);
  await page.locator(".canvas-save-state").waitFor({ state: "visible" });
  const saving = await bounds();
  assert.deepEqual(saving, idle, "automatic saving must not resize or move either capsule");
  await page.evaluate(() => { window.holdViewSave = false; window.releaseViewSave(); window.releaseViewSave = null; });
  await page.locator(".canvas-save-state").waitFor({ state: "hidden" });
  assert.deepEqual(await bounds(), idle);
  // Fast local saves must never flash the status, even for a single frame.
  await page.evaluate(() => {
    window.saveFrames = [];
    window.sampleUntil = performance.now() + 1200;
    const sample = () => {
      window.saveFrames.push(getComputedStyle(document.querySelector(".canvas-save-state")).visibility);
      if (performance.now() < window.sampleUntil) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const savesBefore = await page.evaluate(() => window.calls.filter(c => c.command === "project_canvas_view_upsert").length);
  await page.getByRole("button", { name: "缩小", exact: true }).click();
  await page.waitForFunction(() => performance.now() > window.sampleUntil);
  assert.ok(await page.evaluate(before => window.calls.filter(c => c.command === "project_canvas_view_upsert").length > before, savesBefore));
  assert.equal(await page.evaluate(() => window.saveFrames.includes("visible")), false);
  // A narrow canvas also keeps its capsules stable; saving failures remain visible.
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.waitForTimeout(400);
  const narrow = await bounds();
  await page.evaluate(() => window.holdViewSave = true);
  await page.getByRole("button", { name: "放大", exact: true }).click();
  await page.waitForFunction(() => window.releaseViewSave);
  await page.locator(".canvas-save-state").waitFor({ state: "visible" });
  assert.deepEqual(await bounds(), narrow);
  await page.evaluate(() => { window.failViewSave = true; window.holdViewSave = false; window.releaseViewSave(); });
  await page.locator(".canvas-save-error").waitFor({ state: "visible" });
  assert.deepEqual(errors, []);
  console.log("PASS: stable capsule geometry during slow saves, no fast-save flash, narrow canvas, visible save errors.");
} finally { await browser.close(); await server.close(); }
