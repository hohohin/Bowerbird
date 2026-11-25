import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 16005, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: "no-preference" });
const errors = []; page.on("pageerror", error => errors.push(error.message));
const dialog = page.getByRole("dialog", { name: "草稿编辑器", exact: true });
const button = name => dialog.getByRole("button", { name, exact: true });
const field = name => dialog.getByLabel(name, { exact: true });
const canvas = dialog.locator("[data-draft-canvas]"), preview = dialog.locator(".draft-preview");
const ants = dialog.locator("[data-draft-selection]"), base = dialog.locator(".draft-selection-base");
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const png = async () => { await settle(); return canvas.evaluate(c => c.toDataURL()); };
const pixel = async (x, y) => { await settle(); return canvas.evaluate((c, [x, y]) => [...c.getContext("2d").getImageData(x, y, 1, 1).data], [x, y]); };
async function point(x, y) {
  const box = await canvas.boundingBox(), [width, height] = await canvas.evaluate(c => [c.width, c.height]);
  return { x: box.x + x * box.width / width, y: box.y + y * box.height / height };
}
async function shortcut(key) { await preview.focus(); await page.keyboard.press(key); await settle(); }
async function select(tool, points) {
  await button(tool).click(); const first = await point(...points[0]); await page.mouse.move(first.x, first.y); await page.mouse.down();
  for (const xy of points.slice(1)) { const next = await point(...xy); await page.mouse.move(next.x, next.y, { steps: 8 }); }
  await page.mouse.up(); await settle();
}
const rect = (left, top, right, bottom) => select("选区", [[left, top], [right, bottom]]);
async function freshLayer() {
  const name = await field("图层名称").inputValue(); await button(`隐藏 ${name}`).click();
  await button("新建绘画层").click(); await shortcut("ControlOrMeta+d");
  await button("选区").click(); await button("新选区").click();
}
async function fill(color) { await field("前景颜色").fill(color); await button("填充选区").click(); }
async function outlineStyle(locator) {
  return locator.evaluate(node => {
    const s = getComputedStyle(node);
    return { stroke: s.stroke, width: s.strokeWidth, fill: s.fill, dash: s.strokeDasharray, vector: s.vectorEffect, animation: s.animationName };
  });
}
async function screenInk() {
  const p = await point(80, 60), end = await point(240, 60), screenshot = await page.screenshot();
  return page.evaluate(async ({ data, x, y, width }) => {
    const image = new Image(); image.src = data; await image.decode();
    const c = document.createElement("canvas"); c.width = image.width; c.height = image.height;
    const ctx = c.getContext("2d"); ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(Math.floor(x), Math.floor(y) - 4, width, 10).data;
    const ink = Array.from({ length: width }, (_, column) => {
      let total = 0; for (let row = 0; row < 10; row++) total += (255 - pixels[(row * width + column) * 4]) / 255;
      return total;
    });
    const maximum = Math.max(...ink), runs = []; let current = 0;
    for (const value of ink) { if (value > maximum / 2) current++; else if (current) { runs.push(current); current = 0; } }
    const complete = runs.slice(1).sort((a, b) => a - b);
    return { thickness: maximum, dash: complete[Math.floor(complete.length / 2)] };
  }, { data: `data:image/png;base64,${screenshot.toString("base64")}`, ...p, width: Math.min(96, Math.floor(end.x - p.x)) });
}
try {
  await page.goto("http://127.0.0.1:16005/scripts/fixtures/draft-editor/preview.html");
  await page.evaluate(() => window.openDraft()); await canvas.waitFor();
  await button("裁剪").click(); await field("裁剪宽度").fill("320"); await field("裁剪高度").fill("320"); await button("应用裁剪").click();
  await button("隐藏 背景").click(); await button("新建绘画层").click(); await button("选区").click();
  assert.equal(await button("反选").isDisabled(), true);
  await shortcut("ControlOrMeta+Shift+i"); assert.equal(await ants.count(), 0, "inverse shortcut without a selection is a no-op");
  assert.equal(await button("选区").getAttribute("aria-pressed"), "true");

  await rect(60, 60, 160, 160); await button("增选").click();
  await button("反选").click(); await shortcut("ControlOrMeta+Shift+i");
  assert.equal(await button("增选").getAttribute("aria-pressed"), "true", "inverse does not change the selection mode");
  await fill("#2266cc"); assert.deepEqual(await pixel(100, 100), [34, 102, 204, 255]); assert.equal((await pixel(20, 20))[3], 0, "double inverse restores the selected pixels");
  await button("反选").click(); await fill("#e63322");
  assert.deepEqual(await pixel(20, 20), [230, 51, 34, 255]); assert.deepEqual(await pixel(100, 100), [34, 102, 204, 255]);
  const full = await png(), layers = await dialog.locator("[data-draft-layer]").count();
  await shortcut("Delete"); assert.equal((await pixel(20, 20))[3], 0); assert.deepEqual(await pixel(100, 100), [34, 102, 204, 255]);
  assert.equal(await dialog.locator("[data-draft-layer]").count(), layers); await button("撤销").click(); assert.equal(await png(), full);

  await freshLayer(); await select("自由选区", [[50, 50], [250, 50], [150, 250]]); await button("反选").click(); await fill("#2266cc");
  assert.equal((await pixel(150, 100))[3], 0); assert.deepEqual(await pixel(35, 100), [34, 102, 204, 255]); assert.deepEqual(await pixel(80, 220), [34, 102, 204, 255], "lasso inverse uses the actual contour");
  await freshLayer(); await rect(40, 40, 200, 200); await button("减选").click(); await rect(80, 80, 120, 120);
  await button("增选").click(); await rect(260, 260, 300, 300); await button("反选").click(); await fill("#22aa44");
  assert.deepEqual(await pixel(100, 100), [34, 170, 68, 255], "inverse selects the previous hole");
  assert.equal((await pixel(60, 60))[3], 0); assert.equal((await pixel(280, 280))[3], 0); assert.deepEqual(await pixel(220, 220), [34, 170, 68, 255]);

  const path = await ants.getAttribute("d"), beforeInput = await png();
  await field("图层名称").focus(); await page.keyboard.press("ControlOrMeta+Shift+i"); assert.equal(await ants.getAttribute("d"), path);
  await field("HEX 颜色").focus(); await page.keyboard.press("ControlOrMeta+Shift+i"); assert.equal(await ants.getAttribute("d"), path); assert.equal(await png(), beforeInput);
  await shortcut("ControlOrMeta+a"); await button("反选").click();
  const beforeEmpty = await png(), emptyLayers = await dialog.locator("[data-draft-layer]").count();
  await shortcut("Delete"); if (await button("填充选区").isEnabled()) await button("填充选区").click();
  assert.equal(await png(), beforeEmpty); assert.equal(await dialog.locator("[data-draft-layer]").count(), emptyLayers, "inverse of full selection cannot delete the layer");
  assert.equal(await button("反选").isEnabled(), true); await button("反选").click(); await fill("#ffffff");
  assert.deepEqual(await pixel(0, 0), [255, 255, 255, 255]); assert.deepEqual(await pixel(319, 319), [255, 255, 255, 255], "inverse of explicit empty selection selects the entire canvas");

  await button("新选区").click(); await rect(60, 60, 260, 260);
  const style = await outlineStyle(ants), baseStyle = await outlineStyle(base);
  assert.equal(style.stroke, "rgb(0, 0, 0)"); assert.equal(baseStyle.stroke, "rgb(255, 255, 255)");
  assert.equal(style.fill, "none"); assert.equal(baseStyle.fill, "none"); assert.equal(style.vector, "non-scaling-stroke"); assert.equal(baseStyle.vector, "non-scaling-stroke");
  const offset = await ants.evaluate(node => getComputedStyle(node).strokeDashoffset);
  await page.waitForFunction(previous => getComputedStyle(document.querySelector("[data-draft-selection]")).strokeDashoffset !== previous, offset, { polling: "raf", timeout: 3000 });
  assert.notEqual(style.animation, "none", "marching ants advance under normal motion preference");
  await page.emulateMedia({ reducedMotion: "reduce" }); await settle();
  assert.equal((await outlineStyle(ants)).animation, "none"); const reduced = await ants.evaluate(node => getComputedStyle(node).strokeDashoffset); await settle();
  assert.equal(await ants.evaluate(node => getComputedStyle(node).strokeDashoffset), reduced, "reduced motion keeps a static high-contrast outline");
  const normalInk = await screenInk();
  await button("放大视图").click(); await button("放大视图").click(); await button("放大视图").click(); await settle();
  const enlargedInk = await screenInk();
  console.log("Selection outline screen pixels:", JSON.stringify({ normalInk, enlargedInk }));
  assert.ok(Math.abs(normalInk.thickness - enlargedInk.thickness) < .3, "screen stroke thickness stays constant after zoom");
  assert.ok(Math.abs(normalInk.dash - enlargedInk.dash) <= 1, "screen dash length stays constant after zoom");
  await button("适应窗口").click(); await button("缩小视图").click(); await button("缩小视图").click(); await button("缩小视图").click(); await settle();
  const reducedInk = await screenInk();
  assert.ok(Math.abs(normalInk.thickness - reducedInk.thickness) < .3); assert.ok(Math.abs(normalInk.dash - reducedInk.dash) <= 1, "screen outline stays legible below 100% zoom");
  await button("适应窗口").click(); await page.setViewportSize({ width: 900, height: 420 }); await settle();
  assert.ok((await canvas.boundingBox()).width < 300, "compact viewport exercises the SVG viewBox fit transform");
  const fittedInk = await screenInk();
  assert.ok(Math.abs(normalInk.thickness - fittedInk.thickness) < .3); assert.ok(Math.abs(normalInk.dash - fittedInk.dash) <= 1, "fit and zoom both retain screen-pixel outline dimensions");
  console.log("Selection outline reduced/fitted pixels:", JSON.stringify({ reducedInk, fittedInk }));
  await page.setViewportSize({ width: 1440, height: 960 }); await settle();

  await button("适应窗口").click(); await shortcut("ControlOrMeta+a"); await fill("#ffffff");
  await rect(0, 0, 160, 320); await fill("#000000"); await select("自由选区", [[30, 60], [290, 60], [160, 270]]);
  await mkdir(".tmp/draft-editor", { recursive: true });
  await page.screenshot({ path: ".tmp/draft-editor/selection-invert-light.png" });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; }); await settle();
  await button("放大视图").click(); await button("放大视图").click();
  const pan = await point(160, 160); await preview.focus(); await page.keyboard.down("Space"); await page.mouse.move(pan.x, pan.y); await page.mouse.down(); await page.mouse.move(pan.x + 35, pan.y + 20); await page.mouse.up(); await page.keyboard.up("Space"); await settle();
  await page.screenshot({ path: ".tmp/draft-editor/selection-invert-dark-zoom.png" });
  const preserved = await ants.getAttribute("d");
  for (const tool of ["选区", "自由选区"]) {
    await button(tool).click(); const a = await point(40, 40), b = await point(100, 100);
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 6 }); await settle();
    assert.equal(await dialog.locator("[data-draft-selection-preview]").count(), 1);
    for (const state of await dialog.locator(".draft-selection-outline path").evaluateAll(nodes => nodes.map(node => ({ fill: getComputedStyle(node).fill, vector: getComputedStyle(node).vectorEffect })))) {
      assert.equal(state.fill, "none"); assert.equal(state.vector, "non-scaling-stroke");
    }
    await page.keyboard.press("Escape"); await page.mouse.up(); await settle(); assert.equal(await ants.getAttribute("d"), preserved);
  }
  await page.evaluate(() => { window.delaySave = true; }); await button("保存工程").click(); await page.waitForFunction(() => !!window.releaseSave);
  assert.equal(await button("反选").isDisabled(), true); const busyPath = await ants.getAttribute("d"), busyPixels = await png();
  await shortcut("ControlOrMeta+Shift+i"); assert.equal(await ants.getAttribute("d"), busyPath); assert.equal(await png(), busyPixels);
  await page.evaluate(() => window.releaseSave()); await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
  console.log("PASS inverse selection and marching ants: rectangle/lasso/composite pixels, double inverse, fill/Delete, full-empty safety, shortcuts/focus/busy, animated and reduced motion outlines, screen-size stroke/dashes, preview cancellation and high-contrast themes/zoom/pan.");
} finally { await browser.close(); await server.close(); }
