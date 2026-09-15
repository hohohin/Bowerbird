import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1570, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1200 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const bubble = page.locator(".canvas-note.is-bubble");
const tail = bubble.getByRole("button", { name: "调整气泡突出部分" });
async function saved() { await page.waitForFunction(() => !document.querySelector('.canvas-save-state.is-visible')); }
try {
  await page.goto("http://127.0.0.1:1570/scripts/fixtures/canvas-reference/preview.html");
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(() => {
    const snapshot = window.snapshot();
    snapshot.view = { ...snapshot.view, zoom: 1, panX: 0, panY: 0 };
    sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
  });
  await page.reload();
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.getByRole("button", { name: "气泡便签工具", exact: true }).click();
  await page.locator(".canvas-stage").click({ position: { x: 600, y: 350 } });
  await bubble.waitFor();
  const id = await bubble.getAttribute("data-canvas-node-id");
  const payload = async () => JSON.parse((await page.evaluate(() => window.snapshot())).nodes.find(node => node.id === id).payloadJson);
  assert.equal(await bubble.evaluate(e => getComputedStyle(e).backgroundColor), "rgb(255, 241, 166)");
  assert.equal(await bubble.getByRole("textbox").count(), 1);
  assert.equal(await bubble.locator(".canvas-text-insert, .canvas-text-remove").count(), 0);
  const content = bubble.getByRole("textbox", { name: "气泡便签内容" });
  await content.fill("这里保留原来的光影\n只替换产品");
  await bubble.getByRole("button", { name: "加粗", exact: true }).click();
  await bubble.getByRole("button", { name: "增大行距", exact: true }).click();
  await saved();
  const original = await bubble.boundingBox();
  async function moveTail(side, position, cancel = false) {
    const box = await bubble.boundingBox();
    const target = side === "top" ? [box.x + box.width * position, box.y - 12]
      : side === "bottom" ? [box.x + box.width * position, box.y + box.height + 12]
      : side === "left" ? [box.x - 12, box.y + box.height * position]
      : [box.x + box.width + 12, box.y + box.height * position];
    const handle = await tail.boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(...target, { steps: 12 });
    assert.equal(await tail.evaluate((e, side) => e.classList.contains(`is-${side}`), side), true);
    if (cancel) await page.keyboard.press("Escape");
    await page.mouse.up();
    await saved();
  }
  for (const side of ["right", "top", "left", "bottom"]) {
    await moveTail(side, 0.65);
    assert.equal((await payload()).bubble_tail.side, side);
    assert.ok(Math.abs((await payload()).bubble_tail.position - 65) <= 1);
    assert.deepEqual(await bubble.boundingBox(), original, "tail movement does not move the note");
  }
  const beforeCancel = (await payload()).bubble_tail;
  await moveTail("right", 0.5, true);
  assert.deepEqual((await payload()).bubble_tail, beforeCancel);
  assert.equal(await tail.evaluate(e => e.classList.contains("is-bottom")), true);
  const resize = await bubble.getByRole("button", { name: "调整文本卡片大小" }).boundingBox();
  await page.mouse.move(resize.x + resize.width / 2, resize.y + resize.height / 2);
  await page.mouse.down();
  await page.mouse.move(resize.x + resize.width / 2 + 120, resize.y + resize.height / 2 + 70, { steps: 8 });
  await page.mouse.up();
  await saved();
  const enlarged = await bubble.boundingBox();
  assert.ok(Math.abs(enlarged.width - original.width - 120) < 1);
  assert.ok(Math.abs(enlarged.height - original.height - 70) < 1);
  assert.deepEqual((await payload()).bubble_tail, beforeCancel);
  await page.getByRole("button", { name: "缩小", exact: true }).click();
  await page.getByRole("button", { name: "缩小", exact: true }).click();
  await page.waitForFunction(() => Math.abs(window.snapshot().view.zoom - 0.7) < 0.001);
  await moveTail("right", 0.4);
  assert.equal((await payload()).bubble_tail.side, "right");
  assert.ok(Math.abs((await payload()).bubble_tail.position - 40) <= 1);
  await page.evaluate(() => window.save());
  await page.reload();
  await bubble.waitFor();
  assert.equal(await content.inputValue(), "这里保留原来的光影\n只替换产品");
  assert.equal(await content.evaluate(e => getComputedStyle(e).fontWeight), "700");
  assert.equal((await payload()).note_type, "bubble");
  assert.equal((await payload()).bubble_tail.side, "right");
  assert.equal((await payload()).line_height_percent, 175);
  const reloaded = (await page.evaluate(() => window.snapshot())).nodes.find(node => node.id === id);
  assert.ok(Math.abs(reloaded.width - enlarged.width) < 1 && Math.abs(reloaded.height - enlarged.height) < 1);
  assert.equal(await bubble.locator(".canvas-text-insert, .canvas-text-remove").count(), 0);
  await mkdir(".tmp/canvas-notes", { recursive: true });
  await page.screenshot({ path: ".tmp/canvas-notes/bubble-preview.png" });
  assert.deepEqual(errors, []);
  console.log("PASS yellow single-text bubble, rounded tail on all four edges, cancel, resize, zoom, styles and reload.");
} finally { await browser.close(); await server.close(); }
