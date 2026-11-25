import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 16004, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: "reduce" });
const errors = []; page.on("pageerror", error => errors.push(error.message));
const dialog = page.getByRole("dialog", { name: "草稿编辑器", exact: true });
const button = name => dialog.getByRole("button", { name, exact: true });
const field = name => dialog.getByLabel(name, { exact: true });
const canvas = dialog.locator("[data-draft-canvas]"), preview = dialog.locator(".draft-preview");
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const png = async () => { await settle(); return canvas.evaluate(c => c.toDataURL()); };
const pixel = async (x, y) => { await settle(); return canvas.evaluate((c, [x, y]) => [...c.getContext("2d").getImageData(x, y, 1, 1).data], [x, y]); };
async function point(x, y) {
  const box = await canvas.boundingBox(), [width, height] = await canvas.evaluate(c => [c.width, c.height]);
  return { x: box.x + x * box.width / width, y: box.y + y * box.height / height };
}
async function gesture(tool, points) {
  await button(tool).click();
  const first = await point(...points[0]); await page.mouse.move(first.x, first.y); await page.mouse.down();
  for (const xy of points.slice(1)) { const next = await point(...xy); await page.mouse.move(next.x, next.y, { steps: 8 }); }
  await page.mouse.up(); await settle();
}
const rect = (left, top, right, bottom) => gesture("选区", [[left, top], [right, bottom]]);
async function mode(name) {
  await button(name).click();
  for (const value of ["新选区", "增选", "减选"]) assert.equal(await button(value).getAttribute("aria-pressed"), String(value === name));
}
async function erase(key = "Delete") { await preview.focus(); await page.keyboard.press(key); await settle(); }
const red = [230, 51, 34, 255], blue = [34, 102, 204, 255];
try {
  await page.goto("http://127.0.0.1:16004/scripts/fixtures/draft-editor/preview.html");
  await page.evaluate(() => window.openDraft()); await canvas.waitFor();
  await button("裁剪").click(); await field("裁剪宽度").fill("320"); await field("裁剪高度").fill("320"); await button("应用裁剪").click();
  await button("隐藏 背景").click(); await button("新建绘画层").click();
  assert.equal(await button("清除选区").count(), 0, "pixel clearing is a keyboard action, not a duplicate button");
  assert.equal(await button("填充选区").isDisabled(), true, "fill requires a selection");

  await button("选区").click(); assert.equal(await button("新选区").getAttribute("aria-pressed"), "true");
  await rect(20, 20, 120, 120); await mode("增选"); await rect(80, 80, 180, 180); await rect(230, 20, 290, 80);
  await field("前景颜色").fill("#e63322"); await button("填充选区").click();
  assert.deepEqual(await pixel(40, 40), red); assert.deepEqual(await pixel(100, 100), red, "overlap is union, not even-odd cancellation");
  assert.deepEqual(await pixel(160, 160), red); assert.deepEqual(await pixel(260, 50), red, "disconnected additions stay selected");
  assert.equal((await pixel(210, 50))[3], 0); assert.equal((await pixel(40, 160))[3], 0);

  await mode("减选"); await rect(50, 50, 110, 110);
  await field("前景颜色").fill("#2266cc"); await button("填充选区").click();
  assert.deepEqual(await pixel(40, 40), blue); assert.deepEqual(await pixel(90, 90), red, "subtraction leaves a hole without erasing its existing pixels");
  const filled = await png(), layers = await dialog.locator("[data-draft-layer]").count();
  await erase(); assert.equal((await pixel(40, 40))[3], 0); assert.equal((await pixel(160, 160))[3], 0); assert.equal((await pixel(260, 50))[3], 0);
  assert.deepEqual(await pixel(90, 90), red); assert.equal(await dialog.locator("[data-draft-layer]").count(), layers, "Delete with a selection keeps the layer");
  const cleared = await png(); await button("撤销").click(); assert.equal(await png(), filled); await button("重做").click(); assert.equal(await png(), cleared);
  await button("撤销").click();

  // Rectangles and freehand outlines share the same selection mode and result.
  await button("选区").click(); await mode("新选区"); await rect(20, 20, 180, 180);
  await mode("减选"); await gesture("自由选区", [[50, 50], [140, 50], [95, 145]]);
  assert.equal(await button("减选").getAttribute("aria-pressed"), "true", "switching selection tools preserves the combination mode");
  await mode("增选"); await gesture("自由选区", [[220, 210], [290, 210], [260, 290]]);
  await field("前景颜色").fill("#22aa44"); await button("填充选区").click();
  assert.deepEqual(await pixel(30, 30), [34, 170, 68, 255]); assert.deepEqual(await pixel(95, 90), red, "freehand hole preserves its prior color");
  assert.deepEqual(await pixel(260, 230), [34, 170, 68, 255]); assert.equal((await pixel(225, 280))[3], 0, "freehand addition uses its contour rather than the bounding box");
  const path = await dialog.locator("[data-draft-selection]").getAttribute("d");
  await mode("减选");
  const a = await point(10, 200), b = await point(160, 280); await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.keyboard.press("Escape"); await page.mouse.up(); await settle();
  assert.equal(await dialog.locator("[data-draft-selection]").getAttribute("d"), path, "canceling an incremental gesture preserves the combined selection");

  const fillBox = await button("填充选区").boundingBox(), paletteBox = await dialog.locator(".draft-color-panel").boundingBox();
  assert.ok(fillBox.x + fillBox.width <= paletteBox.x + 1, "fill sits to the left of the color panel");
  assert.equal(await dialog.locator(".draft-color-tools").getByRole("button", { name: "填充选区", exact: true }).count(), 1);
  const beforeInput = await png(); await field("图层名称").fill("键盘编辑"); await field("图层名称").press("Backspace");
  assert.equal(await field("图层名称").inputValue(), "键盘编"); assert.equal(await png(), beforeInput); assert.equal(await dialog.locator("[data-draft-layer]").count(), layers);
  await field("HEX 颜色").focus(); await field("HEX 颜色").press("ControlOrMeta+a"); await field("HEX 颜色").press("Delete");
  assert.equal(await field("HEX 颜色").inputValue(), ""); assert.equal(await png(), beforeInput, "Delete in color input does not clear the selection");
  await field("HEX 颜色").press("Escape");
  await mkdir(".tmp/draft-editor", { recursive: true });
  await page.screenshot({ path: ".tmp/draft-editor/selection-actions-light.png", animations: "disabled" });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; }); await settle();
  await page.screenshot({ path: ".tmp/draft-editor/selection-actions-dark.png", animations: "disabled" });
  await page.setViewportSize({ width: 900, height: 700 }); await settle();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const compactFill = await button("填充选区").boundingBox(), compactPalette = await dialog.locator(".draft-color-panel").boundingBox();
  assert.ok(compactFill.x + compactFill.width <= compactPalette.x + 1);
  await page.screenshot({ path: ".tmp/draft-editor/selection-actions-compact.png", animations: "disabled" });

  // Empty selection is distinct from deselection: neither fill nor Delete may affect the layer.
  await button("选区").click(); await mode("新选区"); await rect(30, 30, 70, 70); await mode("减选"); await rect(10, 10, 90, 90);
  const beforeEmpty = await png(); await erase(); await erase("Backspace");
  if (await button("填充选区").isEnabled()) await button("填充选区").click();
  assert.equal(await png(), beforeEmpty); assert.equal(await dialog.locator("[data-draft-layer]").count(), layers, "fully subtracted selection cannot turn Delete into layer deletion");
  await gesture("画笔", [[230, 300], [290, 300]]); assert.equal(await png(), beforeEmpty, "empty selection also clips brush strokes");
  await button("选区").click(); await mode("增选"); await rect(230, 280, 290, 310);
  await field("前景颜色").fill("#2266cc"); await button("填充选区").click(); assert.deepEqual(await pixel(260, 300), blue, "an empty selection can be extended again");
  const beforeBackspace = await png(); await erase("Backspace"); assert.equal((await pixel(260, 300))[3], 0); await button("撤销").click(); assert.equal(await png(), beforeBackspace);
  await button("选区").click(); await mode("新选区"); await rect(20, 20, 40, 40); await button("取消选区").click();
  assert.equal(await button("填充选区").isDisabled(), true); await erase();
  assert.equal(await dialog.locator("[data-draft-layer]").count(), layers - 1, "deselection retains the existing Delete-layer behavior");
  assert.deepEqual(errors, []);
  console.log("PASS selection actions: rectangle/freehand union and difference, holes/disconnected regions, mode state, Delete and undo/redo, empty selection safety, input focus, cancellation, fill placement and themes/compact layout.");
} finally { await browser.close(); await server.close(); }
