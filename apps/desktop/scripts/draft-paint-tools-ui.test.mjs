import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 16002, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const pen = await page.context().newCDPSession(page);
const errors = []; page.on("pageerror", error => errors.push(error.message));
const dialog = page.getByRole("dialog", { name: "草稿编辑器", exact: true });
const button = name => dialog.getByRole("button", { name, exact: true });
const field = name => dialog.getByLabel(name, { exact: true });
const canvas = dialog.locator("[data-draft-canvas]");
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const png = async () => { await settle(); return canvas.evaluate(c => c.toDataURL()); };
const pixel = async (x, y) => { await settle(); return canvas.evaluate((c, [x, y]) => [...c.getContext("2d").getImageData(x, y, 1, 1).data], [x, y]); };
async function point(x, y) {
  const box = await canvas.boundingBox(), [width, height] = await canvas.evaluate(c => [c.width, c.height]);
  return { x: box.x + x * box.width / width, y: box.y + y * box.height / height };
}
async function size(value) { await field("画笔大小").fill(String(value)); await field("画笔大小").press("Enter"); }
async function stroke(tool, points) {
  await button(tool).click();
  const first = await point(...points[0]); await page.mouse.move(first.x, first.y); await page.mouse.down();
  for (const xy of points.slice(1)) { const next = await point(...xy); await page.mouse.move(next.x, next.y, { steps: 8 }); }
  await page.mouse.up(); await settle();
}
async function penDot(x, y, pressure) {
  const p = await point(x, y);
  await pen.send("Input.dispatchMouseEvent", { type: "mousePressed", ...p, button: "left", buttons: 1, clickCount: 1, pointerType: "pen", force: pressure });
  await pen.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...p, button: "left", buttons: 0, clickCount: 1, pointerType: "pen", force: 0 });
  await settle();
}
try {
  await page.goto("http://127.0.0.1:16002/scripts/fixtures/draft-editor/preview.html");
  await page.evaluate(() => window.openDraft()); await canvas.waitFor();
  await button("裁剪").click(); await field("裁剪宽度").fill("320"); await field("裁剪高度").fill("320"); await button("应用裁剪").click();
  await button("隐藏 背景").click(); await button("新建绘画层").click(); await button("画笔").click();

  await field("画笔大小").fill("2");
  const fineFirst = await point(200, 20); await page.mouse.move(fineFirst.x, fineFirst.y); await page.mouse.down(); await page.mouse.up();
  assert.ok((await pixel(200, 20))[3] > 0);
  assert.equal((await pixel(200, 26))[3], 0, "clicking the canvas after typing uses the new size on the very first stroke without Enter");
  await button("撤销").click();

  // Actual keystrokes, including the empty state that previously snapped back to 1.
  await field("画笔大小").focus(); await field("画笔大小").press("ControlOrMeta+a"); await field("画笔大小").press("Backspace");
  assert.equal(await field("画笔大小").inputValue(), "");
  await field("画笔大小").pressSequentially("0.5"); await field("画笔大小").press("Enter");
  assert.equal(await field("画笔大小").inputValue(), "0.5");
  await dialog.locator(".draft-preview").focus(); await page.keyboard.press("]"); await settle();
  assert.equal(await field("画笔大小").inputValue(), "1"); await page.keyboard.press("["); await settle();
  assert.equal(await field("画笔大小").inputValue(), "0.5");
  await field("画笔平滑").focus(); await page.keyboard.press("Home");
  await stroke("画笔", [[20.5, 20.5], [100.5, 20.5]]);
  assert.ok((await pixel(60, 20))[3] > 0, "half-pixel brush leaves real antialiased pixels");
  assert.equal((await pixel(60, 24))[3], 0, "fine tip is not clamped to 16 pixels");
  await button("撤销").click();

  // A concave region must clip against the actual path, including the inner notch.
  await size(20); await field("前景颜色").fill("#22aa44"); await stroke("画笔", [[180, 180], [180, 180]]);
  const outside = await pixel(180, 180);
  const outline = [[60, 60], [260, 60], [260, 120], [120, 120], [120, 260], [60, 260]];
  await stroke("自由选区", outline);
  assert.match(await dialog.locator("[data-draft-selection]").getAttribute("d"), /Z$/, "freehand selection closes on release");
  await field("前景颜色").fill("#e63322"); await button("填充选区").click();
  assert.deepEqual(await pixel(80, 180), [230, 51, 34, 255]);
  assert.deepEqual(await pixel(180, 180), outside, "concave notch is outside the filled selection");
  const filled = await png();
  await dialog.locator(".draft-preview").focus(); await page.keyboard.press("Delete");
  assert.equal((await pixel(80, 180))[3], 0); assert.deepEqual(await pixel(180, 180), outside);
  await button("撤销").click(); assert.equal(await png(), filled);
  // Undo clears selection; draw it again and verify all paint modes.
  await stroke("自由选区", outline); await field("前景颜色").fill("#2266cc");
  await stroke("画笔", [[80, 180], [240, 180]]);
  assert.deepEqual(await pixel(90, 180), [34, 102, 204, 255]); assert.deepEqual(await pixel(180, 180), outside);
  await stroke("橡皮", [[80, 180], [240, 180]]);
  assert.equal((await pixel(90, 180))[3], 0); assert.deepEqual(await pixel(180, 180), outside);
  await stroke("矩形", [[80, 80], [240, 240]]);
  assert.equal((await pixel(240, 180))[3], 0, "shape strokes do not paint the notch");
  assert.ok((await pixel(200, 80))[3] > 0);

  const selectedPath = await dialog.locator("[data-draft-selection]").getAttribute("d");
  await button("自由选区").click(); const a = await point(25, 25), b = await point(130, 50);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.keyboard.press("Escape"); await page.mouse.up();
  assert.equal(await dialog.locator("[data-draft-selection]").getAttribute("d"), selectedPath, "canceling freehand capture keeps the prior selection");
  await button("取消选区").click();
  await button("新建绘画层").click(); await button("画笔").click(); await size(40);
  await field("画笔平滑").focus(); await page.keyboard.press("Home"); await field("画笔惯性").focus(); await page.keyboard.press("Home"); await field("压感").check();
  await penDot(40, 40, .2); await penDot(100, 40, .9);
  assert.equal((await pixel(40, 54))[3], 0); assert.ok((await pixel(100, 54))[3] > 0, "pen force controls brush diameter through real pointer events");
  await field("压感").uncheck(); await penDot(160, 40, .1);
  assert.ok((await pixel(160, 54))[3] > 0, "disabled pressure uses the chosen diameter even with light pen force");

  await field("画笔惯性").focus(); await page.keyboard.press("End"); await size(10);
  const beforeInertia = await png(), start = await point(40, 290), end = await point(240, 290);
  await dialog.locator(".draft-preview").focus(); await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 16 });
  assert.equal((await pixel(230, 290))[3], 0, "inertia leaves an adjustable lag while dragging");
  await page.mouse.up(); assert.ok((await pixel(230, 290))[3] > 0, "release catches the stroke up to its endpoint");
  await button("撤销").click(); assert.equal(await png(), beforeInertia, "the entire inertial stroke is one history operation");
  await button("橡皮").click(); assert.equal(await field("压感").isChecked(), true); assert.equal(await field("橡皮惯性").inputValue(), "0");
  await button("画笔").click(); assert.equal(await field("压感").isChecked(), false); assert.equal(await field("画笔惯性").inputValue(), "100");

  await field("画笔惯性").focus(); await page.keyboard.press("Home"); await field("压感").check();
  await field("HEX 颜色").fill("#aa22cc"); await field("HEX 颜色").press("Enter");
  assert.equal(await field("前景颜色").inputValue(), "#aa22cc", "right panel and toolbar share the foreground color");
  await button("画笔").click(); await field("HEX 颜色").fill("#bb33dd");
  const newColor = await point(275, 290); await page.mouse.click(newColor.x, newColor.y);
  assert.deepEqual((await pixel(275, 290)).slice(0, 3), [187, 51, 221], "HEX blur is committed before the very first canvas stroke");
  await button("吸管").click(); const sample = await point(160, 40); await page.mouse.click(sample.x, sample.y); await settle();
  assert.equal(await field("HEX 颜色").inputValue(), await field("前景颜色").inputValue(), "eyedropper updates the color panel");
  await button("自由选区").click();
  await mkdir(".tmp/draft-editor", { recursive: true });
  await page.screenshot({ path: ".tmp/draft-editor/paint-tools-light.png" });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.screenshot({ path: ".tmp/draft-editor/paint-tools-dark.png" });
  await button("保存工程").click(); await dialog.waitFor({ state: "hidden" });
  await page.evaluate(() => window.openDraft("saved")); await canvas.waitFor(); await settle();
  assert.deepEqual((await pixel(275, 290)).slice(0, 3), [187, 51, 221]);
  assert.deepEqual(errors, []);
  console.log("PASS paint tools: editable half-pixel diameter, lasso fill/clear/brush/erase/shape/cancel, pen force toggle, inertia finish/undo, separate tool settings, palette/eyedropper and save/reopen.");
} finally { await browser.close(); await server.close(); }
