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

  const tools = page.getByRole("toolbar", { name: "画板工具" });
  const hand = tools.getByRole("button", { name: "抓手工具" });
  const toolsBeforeFocus = await tools.boundingBox();
  const handBox = await hand.boundingBox();
  const handX = handBox.x + handBox.width / 2, handY = handBox.y + handBox.height / 2;
  const distantCell = page.locator('[data-canvas-node-id="far"] textarea').first();
  assert.ok((await distantCell.boundingBox()).x > page.viewportSize().width);
  await distantCell.focus();
  assert.equal(await distantCell.evaluate(el => document.activeElement === el), true);
  assert.deepEqual(await tools.boundingBox(), toolsBeforeFocus, "focusing an offscreen cell must keep the left toolbar anchored");
  // Use the original screen point: a locator click could scroll a displaced button back into view.
  await page.mouse.click(handX, handY);
  assert.equal(await hand.getAttribute("aria-pressed"), "true");
  const planeTransform = () => page.locator(".canvas-plane").evaluate(el => el.style.transform);
  const beforePan = await planeTransform();
  await page.mouse.move(650, 380);
  await page.mouse.down();
  await page.mouse.move(770, 430, { steps: 5 });
  await page.mouse.up();
  assert.notEqual(await planeTransform(), beforePan);
  assert.deepEqual(await tools.boundingBox(), toolsBeforeFocus);
  const beforeZoom = await planeTransform();
  await page.getByRole("button", { name: "放大", exact: true }).click();
  await page.waitForFunction(previous => document.querySelector(".canvas-plane").style.transform !== previous, beforeZoom);
  assert.deepEqual(await tools.boundingBox(), toolsBeforeFocus);
  await page.addInitScript(() => { window.isTauri = true; });
  await page.goto("http://127.0.0.1:1554/scripts/fixtures/canvas-reference/preview.html?source-library&detail-route&canvas-library");
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  const snap = tools.getByRole("button", { name: "吸附对齐" });
  for (const height of [800, 720, 601, 600]) {
    await page.setViewportSize({ width: 900, height });
    const stageBox = await page.locator(".canvas-stage").boundingBox();
    const snapBox = await snap.boundingBox();
    assert.ok(snapBox.y + snapBox.height <= stageBox.y + stageBox.height, "the bottom tool must fit inside the available canvas height");
    assert.ok(await tools.locator("button").evaluateAll(buttons => buttons.every(el => el.getBoundingClientRect().height >= 24)), "compact drawing buttons keep a 24px hit target");
    const pressed = await snap.getAttribute("aria-pressed");
    await page.mouse.click(snapBox.x + snapBox.width / 2, snapBox.y + snapBox.height / 2);
    assert.notEqual(await snap.getAttribute("aria-pressed"), pressed, "the bottom tool is reachable without scrolling the canvas");
  }
  assert.deepEqual(errors, []);
  console.log("PASS: stable save capsules and anchored, clickable drawing tools after distant focus, pan and zoom.");
} finally { await browser.close(); await server.close(); }
