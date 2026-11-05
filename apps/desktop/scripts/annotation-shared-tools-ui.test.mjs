import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1572, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const dialog = page.getByRole("dialog", { name: "图片标注", exact: true });
const overlay = dialog.locator("svg.cursor-crosshair");
async function capture() {
  const count = await page.evaluate(() => window.outputs.length);
  await dialog.getByRole("button", { name: "保存到素材库", exact: true }).click();
  await page.waitForFunction(count => window.outputs.length > count, count);
  await page.waitForFunction(() => !document.querySelector('.image-annotator fieldset').disabled);
  return page.evaluate(() => window.outputs.at(-1));
}
async function point(x, y) {
  const box = await overlay.boundingBox();
  return [box.x + x * box.width, box.y + y * box.height];
}
async function draw(tool, from, to, shift = false) {
  await dialog.getByRole("button", { name: tool, exact: true }).click();
  if (shift) await page.keyboard.down("Shift");
  await page.mouse.move(...await point(...from)); await page.mouse.down();
  await page.mouse.move(...await point(...to), { steps: 8 }); await page.mouse.up();
  if (shift) await page.keyboard.up("Shift");
}
async function previewMatches(output) {
  assert.equal(await dialog.locator("canvas[data-annotation-canvas]").evaluate(canvas => canvas.toDataURL()), output.dataUrl,
    "committed preview and PNG export share the same pixels");
}
try {
  await page.goto("http://127.0.0.1:1572/scripts/fixtures/canvas-reference/preview.html");
  await page.waitForFunction(() => window.store);
  await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 1000; canvas.height = 700;
    const ctx = canvas.getContext("2d");
    // Fine detail makes mosaic/blur observable; transparent corner checks eraser alpha.
    for (let x = 0; x < 1000; x += 4) { ctx.fillStyle = x % 8 ? "#ffffff" : "#224466"; ctx.fillRect(x, 0, 4, 700); }
    ctx.clearRect(0, 0, 150, 150);
    ctx.fillStyle = "rgba(255,255,255,0.5)"; ctx.clearRect(160, 20, 50, 50); ctx.fillRect(160, 20, 50, 50);
    window.source = canvas.toDataURL(); window.outputs = [];
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "save_annotated_image") {
        window.outputs.push({ dataUrl: args.dataUrl, meta: JSON.parse(args.annotationJson) }); throw "测试捕获输出";
      }
      return invoke(command, args);
    };
    window.store.setState({ assets: [{ id: "shared-tools", name: "共用工具测试", ext: "png", store_path: window.source }] });
    window.store.getState().openAnnotator("shared-tools");
  });
  await dialog.locator("img").waitFor();
  const preview = dialog.locator("canvas[data-annotation-canvas]");
  await preview.evaluate(canvas => canvas.parentElement.style.background = "#123456");
  const screenshot = (await preview.screenshot()).toString("base64");
  const alphaPixel = await page.evaluate(async png => {
    const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
    const c = document.createElement("canvas"); c.width = image.width; c.height = image.height;
    const ctx = c.getContext("2d"); ctx.drawImage(image, 0, 0);
    return [...ctx.getImageData(Math.round(image.width * .18), Math.round(image.height * .05), 1, 1).data];
  }, screenshot);
  assert.ok(alphaPixel.every((v, i) => Math.abs(v - [137, 154, 171, 255][i]) < 2), `transparent source is composed once: ${alphaPixel}`);
  for (const tool of ["直线／折线", "荧光笔", "马赛克", "高斯模糊", "橡皮擦"]) {
    assert.equal(await dialog.getByRole("button", { name: tool, exact: true }).count(), 1, `image editor exposes screenshot tool: ${tool}`);
  }
  await draw("直线／折线", [.2, .2], [.4, .22], true);
  let output = await capture();
  assert.equal(output.meta.shapes[0].y1, output.meta.shapes[0].y2, "Shift snaps a line horizontally");
  await previewMatches(output);
  for (const [x, y] of [[.2, .35], [.4, .35], [.4, .5]]) await page.mouse.click(...await point(x, y));
  await overlay.click({ button: "right" });
  output = await capture();
  assert.equal(output.meta.shapes.at(-1).type, "line");
  assert.equal(output.meta.shapes.at(-1).points.length, 3, "click sequence commits one polyline");
  for (const [tool, type, from, to] of [
    ["荧光笔", "marker", [.2, .6], [.4, .6]],
    ["马赛克", "mosaic", [.5, .2], [.7, .4]],
    ["高斯模糊", "blur", [.5, .5], [.7, .7]],
  ]) {
    const before = output;
    await draw(tool, from, to);
    output = await capture();
    assert.equal(output.meta.shapes.at(-1).type, type);
    assert.notEqual(output.dataUrl, before.dataUrl, `${type} changes rendered pixels`);
    await previewMatches(output);
    await dialog.getByRole("button", { name: "撤销", exact: true }).click();
    assert.deepEqual(await capture(), before);
    await dialog.getByRole("button", { name: "重做", exact: true }).click();
    assert.deepEqual(await capture(), output);
  }
  // Erase both an opaque annotated region and ink drawn over original transparency.
  await draw("铅笔", [.03, .08], [.12, .08]);
  await dialog.getByRole("button", { name: "橡皮擦", exact: true }).click();
  await page.mouse.move(...await point(.03, .08)); await page.mouse.down();
  await page.mouse.move(...await point(.12, .08), { steps: 8 });
  await page.waitForFunction(() => {
    const draft = document.querySelector('[data-annotation-canvas]').nextElementSibling;
    return draft.width === 1000 && draft.getContext('2d').getImageData(80, 56, 1, 1).data[3] === 0;
  });
  assert.equal(await preview.evaluate(canvas => getComputedStyle(canvas).visibility), 'hidden', 'eraser draft replaces the committed layer');
  await page.mouse.up();
  await draw("橡皮擦", [.55, .3], [.65, .3]);
  output = await capture();
  await previewMatches(output);
  assert.deepEqual(await page.evaluate(async output => {
    const pixels = async url => {
      const img = new Image(); img.src = url; await img.decode();
      const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
      const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
      return [[80, 56], [600, 210]].map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]);
    };
    return [await pixels(output), await pixels(window.source)];
  }, output.dataUrl).then(([actual, expected]) => ({ actual, expected })),
  { actual: [[0, 0, 0, 0], [34, 68, 102, 255]], expected: [[0, 0, 0, 0], [34, 68, 102, 255]] });
  await dialog.getByRole("button", { name: "水平镜像", exact: true }).click();
  await previewMatches(await capture());
  await dialog.getByRole("button", { name: "撤销", exact: true }).click();
  assert.deepEqual(await capture(), output);
  await draw("高斯模糊", [.95, .95], [.99, .99]);
  for (let i = 0; i < 2; i++) {
    await dialog.getByRole("button", { name: "裁剪", exact: true }).click();
    await dialog.getByRole("button", { name: "应用裁剪", exact: true }).click();
    await previewMatches(await capture());
  }
  await dialog.getByRole("button", { name: "直线／折线", exact: true }).click();
  for (const [x, y] of [[.2, .25], [.3, .25], [.3, .4]]) await page.mouse.click(...await point(x, y));
  const pending = await capture();
  await dialog.getByRole("button", { name: "水平镜像", exact: true }).focus();
  await page.keyboard.press("Enter");
  assert.equal((await capture()).meta.shapes.length, pending.meta.shapes.length, "transform settles the unfinished polyline");
  await dialog.getByRole("button", { name: "撤销", exact: true }).click();
  const restored = await capture();
  assert.deepEqual(restored.meta, pending.meta, "undo transform restores the confirmed polyline");
  assert.ok(restored.dataUrl === pending.dataUrl, "pending and confirmed polyline pixels match");
  assert.deepEqual(errors, []);
  console.log("PASS screenshot tools in image annotation: line/polyline, marker, mosaic, blur, alpha eraser, shared preview/export, undo/redo, mirror");
} finally { await browser.close(); await server.close(); }
