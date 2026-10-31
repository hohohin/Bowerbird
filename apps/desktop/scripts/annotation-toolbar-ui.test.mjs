import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1567, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const dialog = page.getByRole("dialog", { name: "图片标注", exact: true });
const overlay = dialog.locator("svg.cursor-crosshair");
async function output() {
  const count = await page.evaluate(() => window.outputs.length);
  await dialog.getByRole("button", { name: "保存到素材库", exact: true }).click();
  await page.waitForFunction(count => window.outputs.length > count, count);
  await page.waitForFunction(() => !document.querySelector('.image-annotator fieldset').disabled);
  return page.evaluate(() => window.outputs.at(-1));
}
try {
  await page.goto("http://127.0.0.1:1567/scripts/fixtures/canvas-reference/preview.html");
  await page.waitForFunction(() => window.store);
  await page.evaluate(() => {
    window.outputs = [];
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "save_annotated_image") {
        window.outputs.push({ dataUrl: args.dataUrl, meta: JSON.parse(args.annotationJson) });
        throw "测试捕获输出";
      }
      return invoke(command, args);
    };
    window.store.getState().openAnnotator("existing");
  });
  await dialog.locator("img").waitFor();
  assert.equal(await dialog.getByRole("slider").count(), 0, "thickness slider is removed");
  const insert = dialog.getByRole("button", { name: "插入创作板", exact: true });
  assert.match(await insert.getAttribute("title"), /不.*素材库|不入库/);
  for (const width of [1440, 1280, 1024, 800]) {
    await page.setViewportSize({ width, height: 900 });
    const toolbar = dialog.locator("fieldset").first();
    const geometry = await toolbar.evaluate(el => {
      const rect = el.getBoundingClientRect();
      return { height: rect.height, right: rect.right, visible: [...el.querySelectorAll("button")].every(button => { const r = button.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }), centers: [...el.querySelectorAll("button")].map(button => {
        const r = button.getBoundingClientRect(); return r.y + r.height / 2;
      }) };
    });
    assert.ok(geometry.height <= 60, `single toolbar row at ${width}px`);
    assert.ok(Math.max(...geometry.centers) - Math.min(...geometry.centers) < 3);
    assert.ok(geometry.right <= width);
    assert.ok(geometry.visible, `all controls fit at ${width}px`);
    const close = await dialog.getByRole("button", { name: "关闭（Esc）" }).boundingBox();
    assert.ok(close.x >= 0 && close.x + close.width <= width, "close action remains visible");
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const [tool, start, end, hit] of [
    ["画框", [0.1, 0.1], [0.3, 0.3], [0.2, 0.1]],
    ["箭头", [0.4, 0.1], [0.6, 0.3], [0.5, 0.2]],
    ["画圆", [0.1, 0.5], [0.3, 0.7], [0.2, 0.5]],
    ["铅笔", [0.4, 0.5], [0.6, 0.7], [0.5, 0.6]],
  ]) {
    await dialog.getByRole("button", { name: tool, exact: true }).click();
    const box = await overlay.boundingBox();
    const at = ([x, y]) => [box.x + x * box.width, box.y + y * box.height];
    await page.mouse.move(...at(start)); await page.mouse.down();
    await page.mouse.move(...at(end), { steps: 8 }); await page.mouse.up();
    const before = await output();
    await page.mouse.move(...at(hit));
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(80);
    const after = await output();
    assert.ok(after.meta.shapes.at(-1).width > before.meta.shapes.at(-1).width, `${tool}: wheel thickens hovered object`);
    assert.notEqual(after.dataUrl, before.dataUrl, "export burns adjusted stroke pixels");
    assert.deepEqual(after.meta.shapes.slice(0, -1), before.meta.shapes.slice(0, -1));
    await dialog.getByRole("button", { name: "撤销", exact: true }).click();
    assert.deepEqual(await output(), before, "undo restores pixels and metadata");
    await page.mouse.move(...at(hit)); await page.mouse.wheel(0, 120);
    await page.waitForTimeout(80);
    assert.ok((await output()).meta.shapes.at(-1).width < before.meta.shapes.at(-1).width);
    await dialog.getByRole("button", { name: "撤销", exact: true }).click();
    await page.mouse.move(...at([0.85, 0.85])); await page.mouse.wheel(0, -120);
    assert.deepEqual(await output(), before, "empty image area does not change strokes");
  }
  const burstBefore = await output();
  const box = await overlay.boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.6);
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(40);
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(40);
  assert.ok((await output()).meta.shapes.at(-1).width > burstBefore.meta.shapes.at(-1).width);
  await dialog.getByRole("button", { name: "撤销", exact: true }).click();
  assert.deepEqual(await output(), burstBefore, "one undo reverses a continuous wheel gesture");
  const consumed = await overlay.locator('polyline').last().evaluate(el => !el.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true })));
  assert.equal(consumed, true, "hovered wheel prevents page scroll");
  await dialog.getByRole("button", { name: "撤销", exact: true }).click();
  await mkdir(".tmp", { recursive: true });
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.screenshot({ path: `.tmp/annotation-toolbar-${theme}.png` });
  }
  assert.deepEqual(errors, []);
  console.log("PASS annotation toolbar: single row 800–1440, tooltip, hover wheel on all stroke tools, pixels/metadata/undo, empty area");
} finally { await browser.close(); await server.close(); }
