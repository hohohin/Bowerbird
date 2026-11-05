import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1573, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const dialog = page.getByRole("dialog", { name: "图片标注", exact: true });
const overlay = dialog.locator("svg.cursor-crosshair");
async function at(x, y) { const b = await overlay.boundingBox(); return [b.x + x * b.width, b.y + y * b.height]; }
async function drag(from, to, button = "left") {
  await page.mouse.move(...from); await page.mouse.down({ button });
  await page.mouse.move(...to, { steps: 8 }); await page.mouse.up({ button });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
}
async function pan(dx, dy, button = "left") { const from = await at(.3, .2); await drag(from, [from[0] + dx, from[1] + dy], button); }
async function output() {
  const count = await page.evaluate(() => window.outputs.length);
  await dialog.getByRole("button", { name: "保存到素材库", exact: true }).click();
  await page.waitForFunction(count => window.outputs.length > count, count);
  await page.waitForFunction(() => !document.querySelector('.image-annotator fieldset').disabled);
  return page.evaluate(() => window.outputs.at(-1));
}
function moved(before, after, dx, dy) {
  assert.ok(Math.abs(after.x - before.x - dx) < 1 && Math.abs(after.y - before.y - dy) < 1,
    `image moves by ${dx},${dy}; actual ${after.x - before.x},${after.y - before.y}`);
  assert.equal(after.width, before.width); assert.equal(after.height, before.height);
}
try {
  await page.goto("http://127.0.0.1:1573/scripts/fixtures/canvas-reference/preview.html");
  await page.waitForFunction(() => window.store);
  await page.evaluate(() => {
    const c = document.createElement("canvas"); c.width = 800; c.height = 600;
    const ctx = c.getContext("2d"); ctx.fillStyle = "#ddd"; ctx.fillRect(0, 0, 800, 600);
    ctx.fillStyle = "#224466"; ctx.fillRect(20, 30, 100, 140);
    window.store.setState({ assets: [{ id: "pan", name: "平移测试", ext: "png", store_path: c.toDataURL() }] });
    window.outputs = [];
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "save_annotated_image") { window.outputs.push({ dataUrl: args.dataUrl, meta: JSON.parse(args.annotationJson) }); throw "测试捕获输出"; }
      return invoke(command, args);
    };
    window.store.getState().openAnnotator("pan");
  });
  await dialog.locator("img").waitFor();
  const centered = await overlay.boundingBox();
  assert.equal(await dialog.getByRole("button", { name: "移动图片", exact: true }).count(), 1, "image annotation offers a pan tool");
  await dialog.getByRole("button", { name: "移动图片", exact: true }).click();
  await pan(80, -60);
  moved(centered, await overlay.boundingBox(), 80, -60);
  await page.keyboard.press("ArrowRight");
  moved(centered, await overlay.boundingBox(), 90, -60);
  await page.keyboard.press("ArrowLeft");
  assert.equal(await dialog.getByRole("button", { name: "保存到素材库", exact: true }).isDisabled(), true, "panning is a view change, not an image edit");
  await dialog.getByRole("button", { name: "图片居中", exact: true }).click();
  moved(centered, await overlay.boundingBox(), 0, 0);
  await dialog.getByRole("button", { name: "画框", exact: true }).click();
  await drag(await at(.2, .2), await at(.4, .4));
  const original = await output();
  await dialog.getByRole("button", { name: "移动图片", exact: true }).click();
  await pan(80, -60);
  assert.deepEqual(await output(), original, "panning carries annotations without changing exported pixels or coordinates");
  await dialog.getByRole("button", { name: "画框", exact: true }).click();
  await page.keyboard.down("Space"); await pan(-40, 60); await page.keyboard.up("Space");
  moved(centered, await overlay.boundingBox(), 40, 0);
  assert.equal(await dialog.getByRole("button", { name: "画框", exact: true }).getAttribute("aria-pressed"), "true");
  await pan(-30, -20, "middle");
  moved(centered, await overlay.boundingBox(), 10, -20);
  assert.deepEqual(await output(), original);
  await drag(await at(.6, .5), await at(.8, .65));
  const drawn = await output();
  assert.deepEqual([drawn.meta.shapes[1].x1, drawn.meta.shapes[1].y1, drawn.meta.shapes[1].x2, drawn.meta.shapes[1].y2], [600, 500, 800, 650]);
  await page.mouse.move(...await at(.7, .5)); await page.mouse.wheel(0, -120);
  const thick = await output(); assert.ok(thick.meta.shapes[1].width > drawn.meta.shapes[1].width, "wheel hits the translated stroke");
  await dialog.getByRole("button", { name: "撤销", exact: true }).click();
  assert.deepEqual(await output(), drawn, "pan does not enter the edit undo stack");
  await dialog.getByRole("button", { name: "文字", exact: true }).click();
  const position = await at(.1, .7); await page.mouse.click(...position);
  const input = dialog.getByRole("textbox", { name: "文字内容", exact: true });
  const inputBox = await input.boundingBox();
  assert.ok(Math.abs(inputBox.x - position[0]) < 2 && Math.abs(inputBox.y - position[1]) < 2);
  await input.fill("A"); await input.press("Space"); await input.press("B");
  assert.equal(await input.inputValue(), "A B", "space in text remains text input");
  const beforeTextPan = await overlay.boundingBox();
  await pan(30, 20, "middle");
  moved(beforeTextPan, await overlay.boundingBox(), 30, 20);
  assert.equal(await input.inputValue(), "A B", "temporary pan preserves in-place text editing");
  await input.press("Control+Enter");
  const withText = await output();
  assert.equal(withText.meta.shapes[2].text, "A B");
  await dialog.getByRole("button", { name: "裁剪", exact: true }).click();
  const beforeCropPan = await overlay.boundingBox();
  await page.keyboard.down("Space");
  await drag(await at(.1, .1), await at(.1 + 20 / 800, .1 + 20 / 600));
  await page.keyboard.up("Space");
  moved(beforeCropPan, await overlay.boundingBox(), 20, 20);
  await dialog.getByRole("button", { name: "应用裁剪", exact: true }).click();
  assert.deepEqual((await output()).meta.image, { width: 640, height: 480 }, "panning on a crop handle does not resize the crop");
  await dialog.getByRole("button", { name: "撤销", exact: true }).click();
  assert.deepEqual(await output(), withText);
  // Capture continues after leaving the image, and blur releases the temporary hand mode.
  await dialog.getByRole("button", { name: "移动图片", exact: true }).click();
  const beforeOutside = await overlay.boundingBox();
  const from = await at(.9, .5); await drag(from, [from[0] + 500, from[1]]);
  moved(beforeOutside, await overlay.boundingBox(), 500, 0);
  await dialog.getByRole("button", { name: "图片居中", exact: true }).click();
  moved(centered, await overlay.boundingBox(), 0, 0);
  await page.mouse.move(...await at(.5, .5)); await page.mouse.down();
  await page.evaluate(() => document.querySelector('.annotation-stage').dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true })));
  await page.mouse.move(...await at(.6, .6)); await page.mouse.up();
  moved(centered, await overlay.boundingBox(), 0, 0);
  await dialog.getByRole("button", { name: "画框", exact: true }).click();
  await page.keyboard.down("Space");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.keyboard.up("Space");
  await drag(await at(.6, .75), await at(.8, .85));
  assert.equal((await output()).meta.shapes.length, 4, "drawing resumes after focus loss");
  await pan(40, 40, "middle");
  await dialog.getByRole("button", { name: "关闭（Esc）" }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.evaluate(() => window.store.getState().openAnnotator("pan"));
  await page.waitForFunction(expected => {
    const rect = document.querySelector('.image-annotator svg.cursor-crosshair')?.getBoundingClientRect();
    return rect && Math.abs(rect.x - expected.x) < 1 && Math.abs(rect.y - expected.y) < 1;
  }, centered);
  assert.deepEqual(errors, []);
  console.log("PASS annotation pan: hand/Space/middle, view-only export, translated drawing/text/wheel/crop, undo, off-image capture, blur and reopen reset");
} finally { await browser.close(); await server.close(); }
