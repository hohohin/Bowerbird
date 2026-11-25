import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 15998, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = []; page.on("pageerror", error => errors.push(error.message));
const dialog = page.getByRole("dialog", { name: "草稿编辑器", exact: true });
const button = name => dialog.getByRole("button", { name, exact: true });
const field = name => dialog.getByLabel(name, { exact: true });
const canvas = dialog.locator("[data-draft-canvas]");
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const png = async () => { await settle(); return canvas.evaluate(c => c.toDataURL()); };
const previewPixel = async (x, y) => {
  await settle();
  const width = Number(await field("裁剪宽度").inputValue()), height = Number(await field("裁剪高度").inputValue());
  return dialog.locator("[data-draft-crop-preview]").evaluate((c, [x, y, w, h]) => [...c.getContext("2d").getImageData(Math.floor(x * c.width / w), Math.floor(y * c.height / h), 1, 1).data], [x, y, width, height]);
};
const dims = () => canvas.evaluate(c => [c.width, c.height]);
const pixel = async (x, y) => { await settle(); return canvas.evaluate((c, [x, y]) => [...c.getContext("2d").getImageData(x, y, 1, 1).data], [x, y]); };
async function point(x, y) {
  const box = await canvas.boundingBox(), [width, height] = await dims();
  return { x: box.x + x * box.width / width, y: box.y + y * box.height / height };
}
async function dragHandle(handle, dx, dy) {
  const box = await button(handle).boundingBox(), stage = await canvas.boundingBox(), [width, height] = await dims();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx * stage.width / width, box.y + box.height / 2 + dy * stage.height / height, { steps: 8 });
  await page.mouse.up(); await settle();
}
async function paint(x, y) {
  await button("画笔").click(); const p = await point(x, y); await page.mouse.click(p.x, p.y); await settle();
}
try {
  await page.goto("http://127.0.0.1:15998/scripts/fixtures/draft-editor/preview.html");
  await page.evaluate(() => window.openDraft()); await canvas.waitFor();
  await button("裁剪").click();
  assert.equal(await dialog.locator("[data-draft-crop-handle]").count(), 8, "crop starts at the canvas perimeter with all eight handles");
  assert.equal(await dialog.locator(".draft-crop-grid line").count(), 4, "rule-of-thirds overlay has four grid lines");
  assert.equal(await field("裁剪宽度").inputValue(), "1600");
  assert.equal(await field("裁剪高度").inputValue(), "1200");
  await field("裁剪宽度").fill("320"); await field("裁剪高度").fill("240"); await button("应用裁剪").click();
  await field("前景颜色").fill("#e63322"); await paint(80, 80);
  const original = await png();

  await button("裁剪").click(); await field("裁剪宽度").fill("40"); await field("裁剪高度").fill("40"); await button("应用裁剪").click();
  await button("裁剪").click(); await field("裁剪宽度").fill("160"); await field("裁剪高度").fill("160");
  assert.deepEqual(await previewPixel(80, 80), [230, 51, 34, 255], "expansion preview includes retained off-canvas pixels before confirmation");
  await button("取消裁剪").click(); await button("撤销").click(); assert.equal(await png(), original);
  await dialog.locator(".draft-layer-select").filter({ hasText: "背景" }).click(); await button("解锁 背景").click();
  await button("橡皮").click(); const hole = await point(20, 20); await page.mouse.click(hole.x, hole.y);
  assert.equal((await pixel(20, 20))[3], 0);
  await button("裁剪").click(); await field("裁剪宽度").fill("400"); await field("裁剪高度").fill("300");
  assert.equal((await previewPixel(20, 20))[3], 0, "white-background extension preview preserves erased transparent holes");
  await button("取消裁剪").click(); await button("撤销").click(); await button("撤销").click();
  await dialog.locator(".draft-layer-select").filter({ hasText: "绘画图层" }).click(); assert.equal(await png(), original);

  await button("裁剪").click(); await dragHandle("裁剪左上", -64, -48);
  assert.equal(await field("裁剪宽度").inputValue(), "384"); assert.equal(await field("裁剪高度").inputValue(), "288");
  assert.equal(await png(), original, "crop preview does not mutate document pixels");
  await mkdir(".tmp/draft-editor", { recursive: true });
  await page.screenshot({ path: ".tmp/draft-editor/crop-expand.png" });
  await dialog.locator(".draft-preview").focus(); await page.keyboard.press("Enter");
  assert.deepEqual(await dims(), [384, 288]);
  assert.deepEqual(await pixel(144, 128), [230, 51, 34, 255], "left/top expansion moves existing pixels without scaling");
  assert.deepEqual(await pixel(10, 10), [255, 255, 255, 255]);
  const expanded = await png();
  await paint(20, 20); assert.deepEqual(await pixel(20, 20), [230, 51, 34, 255], "new left/top area accepts brush input");
  await button("撤销").click(); assert.equal(await png(), expanded);
  await button("撤销").click(); assert.equal(await png(), original, "extension is one reversible operation");
  await button("重做").click(); assert.equal(await png(), expanded);

  await button("裁剪").click(); await field("裁剪比例").selectOption("1:1");
  assert.equal(await field("裁剪宽度").inputValue(), await field("裁剪高度").inputValue());
  await dragHandle("裁剪右边", -40, 0);
  assert.equal(await field("裁剪宽度").inputValue(), await field("裁剪高度").inputValue(), "edge dragging respects the selected ratio");
  await button("裁剪右下").focus(); await page.keyboard.press("Shift+ArrowRight");
  assert.equal(await field("裁剪宽度").inputValue(), "258");
  await dialog.locator(".draft-preview").focus(); await page.keyboard.press("Escape");
  assert.equal(await dialog.locator("[data-draft-crop-handle]").count(), 0);
  assert.equal(await png(), expanded, "Escape discards the pending crop");

  await button("裁剪").click(); await field("裁剪比例").selectOption("free");
  await button("取消裁剪").click(); await button("裁剪").click();
  await dragHandle("裁剪左上", 32, 24);
  await button("应用裁剪").click(); assert.deepEqual(await dims(), [352, 264]);
  assert.deepEqual(await pixel(112, 104), [230, 51, 34, 255], "inward crop repositions artwork without resampling");
  await button("撤销").click(); assert.equal(await png(), expanded);

  await button("裁剪").click(); await button("放大视图").click();
  await dragHandle("裁剪右下", -20, -10);
  assert.equal(await field("裁剪宽度").inputValue(), "364"); assert.equal(await field("裁剪高度").inputValue(), "278", "handles use document coordinates after zoom");
  await button("取消裁剪").click(); assert.equal(await png(), expanded);

  await button("裁剪").click(); const nw = await button("裁剪左上").boundingBox();
  await page.mouse.move(nw.x + nw.width / 2, nw.y + nw.height / 2); await page.mouse.down(); await page.mouse.move(nw.x + 30, nw.y + 30);
  await page.keyboard.press("Escape"); await page.mouse.up();
  assert.equal(await field("裁剪宽度").inputValue(), "384", "canceling an active handle restores its initial box");
  await field("裁剪比例").selectOption("4:3");
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.screenshot({ path: ".tmp/draft-editor/crop-dark.png" });
  await page.setViewportSize({ width: 900, height: 700 }); await settle();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: ".tmp/draft-editor/crop-compact.png" });
  await field("裁剪宽度").fill("320");
  await button("保存工程").click(); await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(await page.evaluate(() => [window.saves[0].document.width, window.saves[0].document.height]), [320, 240], "save confirms pending crop before serializing");
  assert.deepEqual(errors, []);
  console.log("Draft crop UI passed: perimeter handles/grid, preview, left/top expansion and painting, crop/undo, ratio/keyboard, cancellation, zoom, save, themes and compact layout.");
} finally { await browser.close(); await server.close(); }
