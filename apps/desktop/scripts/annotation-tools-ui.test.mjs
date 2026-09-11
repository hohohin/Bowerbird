import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1559, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const dialog = page.getByRole("dialog");
const overlay = dialog.locator('svg.cursor-crosshair');
async function gesture(tool, points, shift = false) {
  await dialog.getByRole("button", { name: tool, exact: true }).click();
  const box = await overlay.boundingBox();
  if (shift) await page.keyboard.down("Shift");
  await page.mouse.move(box.x + points[0][0] * box.width, box.y + points[0][1] * box.height);
  await page.mouse.down();
  for (const [x, y] of points.slice(1)) await page.mouse.move(box.x + x * box.width, box.y + y * box.height, { steps: 8 });
  await page.mouse.up();
  if (shift) await page.keyboard.up("Shift");
}
async function capture(button) {
  const count = await page.evaluate(() => window.outputs.length);
  await dialog.getByRole("button", { name: button, exact: true }).click();
  await page.waitForFunction(count => window.outputs.length > count, count);
  await dialog.getByRole("button", { name: button, exact: true }).waitFor();
  return page.evaluate(() => window.outputs.at(-1));
}
async function compareTransform(original, output, kind) {
  const mismatch = await page.evaluate(async ({ original, output, kind }) => {
    const decode = async url => { const img = new Image(); img.src = url; await img.decode(); return img; };
    const [source, actual] = await Promise.all([decode(original), decode(output)]);
    const expectedCanvas = document.createElement("canvas"), actualCanvas = document.createElement("canvas");
    for (const canvas of [expectedCanvas, actualCanvas]) { canvas.width = actual.width; canvas.height = actual.height; }
    const expectedContext = expectedCanvas.getContext("2d"), actualContext = actualCanvas.getContext("2d");
    if (kind === "rotate") {
      expectedContext.translate(actual.width, 0); expectedContext.rotate(Math.PI / 2); expectedContext.drawImage(source, 0, 0);
    } else expectedContext.drawImage(source, 160, 120, 1280, 960, 0, 0, 1280, 960);
    actualContext.drawImage(actual, 0, 0);
    const a = expectedContext.getImageData(0, 0, actual.width, actual.height).data;
    const b = actualContext.getImageData(0, 0, actual.width, actual.height).data;
    let ink = 0, different = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (a[i] < 220 || b[i] < 220) { ink++; if (Math.abs(a[i] - b[i]) > 80) different++; }
    }
    return different / ink;
  }, { original: original.dataUrl, output: output.dataUrl, kind });
  assert.ok(mismatch < 0.15, `${kind} must transform annotation pixels with the base image (${mismatch})`);
}
try {
  await page.goto("http://127.0.0.1:1559/scripts/fixtures/canvas-reference/preview.html");
  await page.waitForFunction(() => window.store);
  await page.evaluate(() => {
    window.outputs = [];
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (["save_annotated_image", "save_annotation_temp"].includes(command)) {
        window.outputs.push({ dataUrl: args.dataUrl, meta: JSON.parse(args.annotationJson) });
        throw "测试截取输出，保留编辑器";
      }
      return original(command, args);
    };
  });
  for (const mode of ["draft", "asset"]) {
    await page.evaluate(mode => {
      if (mode === "draft") window.store.getState().openDraftAnnotator(async (dataUrl, meta) => {
        window.outputs.push({ dataUrl, meta }); throw "测试截取输出，保留编辑器";
      });
      else {
        const canvas = document.createElement("canvas"); canvas.width = 1600; canvas.height = 1200;
        const ctx = canvas.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(0, 0, 1600, 1200);
        window.store.setState({ assets: [{ id: "test-image", name: "素材标注测试", ext: "png", store_path: canvas.toDataURL() }] });
        window.store.getState().openAnnotator("test-image");
      }
    }, mode);
    await dialog.locator("img").waitFor();
    await dialog.getByRole("button", { name: "颜色 #111111", exact: true }).click();
    await gesture("画圆", [[0.12, 0.12], [0.36, 0.39]], true);
    const circle = await overlay.locator("ellipse").evaluate(el => ({ rx: +el.getAttribute("rx"), ry: +el.getAttribute("ry") }));
    assert.ok(Math.abs(circle.rx - circle.ry) < 0.01, "Shift produces a circle on a non-square image");
    await gesture("铅笔", [[0.55, 0.18], [0.75, 0.22], [0.72, 0.42], [0.55, 0.18]]);
    assert.equal(await overlay.locator("polyline").count(), 1, "closed pencil paths must not be discarded");
    await dialog.getByRole("button", { name: "文字", exact: true }).click();
    const input = dialog.getByRole("textbox", { name: "文字内容" });
    await input.fill("你好 Bowerbird\n第二行文字");
    await input.evaluate(el => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true })));
    assert.equal(await dialog.isVisible(), true, "IME Escape must not close the editor");
    await dialog.getByLabel("字体", { exact: true }).selectOption({ label: "宋体" });
    await dialog.getByLabel("字号", { exact: true }).fill("40");
    const bold = dialog.getByRole("button", { name: "粗体", exact: true });
    if (await bold.getAttribute("aria-pressed") !== "true") await bold.click();
    let box = await overlay.boundingBox();
    await page.mouse.click(box.x + box.width * 0.18, box.y + box.height * 0.58);
    assert.equal(await overlay.locator("text tspan").count(), 2);
    await input.focus();
    await input.press("Control+z");
    assert.equal(await overlay.locator("text").count(), 1, "typing undo does not remove placed annotations");
    await dialog.getByRole("button", { name: "撤销", exact: true }).click();
    assert.equal(await overlay.locator("text").count(), 0);
    await input.fill("你好 Bowerbird\n第二行文字");
    box = await overlay.boundingBox();
    await page.mouse.click(box.x + box.width * 0.18, box.y + box.height * 0.58);
    await mkdir(".tmp", { recursive: true });
    await page.screenshot({ path: `.tmp/annotation-tools-${mode}.png` });
    const saveButton = mode === "draft" ? "保存到画板" : "保存到素材库";
    const original = await capture(saveButton);
    assert.deepEqual(original.meta.shapes.map(s => s.type), ["ellipse", "pencil", "text"]);
    assert.ok(original.meta.shapes[1].points.length > 12);
    assert.equal(original.meta.shapes[2].fontWeight, 700);
    assert.match(original.meta.shapes[2].fontFamily, /SimSun/);
    assert.match(original.meta.shapes[2].token, /你好 Bowerbird/);
    const ink = await page.evaluate(async ({ dataUrl, meta }) => {
      const img = new Image(); img.src = dataUrl; await img.decode();
      const canvas = document.createElement("canvas"); canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext("2d"); ctx.drawImage(img, 0, 0);
      return meta.shapes.map(s => {
        const bounds = s.type === "pencil" ? { x1: 0.5, y1: 0.1, x2: 0.8, y2: 0.45 }
          : { x1: s.x1 / 1000, y1: s.y1 / 1000, x2: s.x2 / 1000, y2: s.y2 / 1000 };
        const pixels = ctx.getImageData(Math.floor(bounds.x1 * img.width), Math.floor(bounds.y1 * img.height),
          Math.ceil((bounds.x2 - bounds.x1) * img.width) + 5, Math.ceil((bounds.y2 - bounds.y1) * img.height) + 5).data;
        let dark = 0; for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 100) dark++;
        return dark;
      });
    }, original);
    assert.ok(ink.every(count => count > 100), "all three tools burn visible pixels into PNG output");
    await dialog.getByRole("button", { name: "右转 90°", exact: true }).click();
    const rotated = await capture(saveButton);
    await compareTransform(original, rotated, "rotate");
    assert.deepEqual(rotated.meta.image, { width: 1200, height: 1600 });
    assert.equal(rotated.meta.shapes[2].rotation, 90);
    assert.ok(Math.abs(rotated.meta.shapes[2].fontSize - original.meta.shapes[2].fontSize) < 0.001);
    const point = original.meta.shapes[1].points[3], rotatedPoint = rotated.meta.shapes[1].points[3];
    assert.ok(Math.abs(rotatedPoint.x - (1000 - point.y)) <= 1);
    assert.ok(Math.abs(rotatedPoint.y - point.x) <= 1);
    await dialog.getByRole("button", { name: "撤销", exact: true }).click();
    const undone = await capture(saveButton);
    assert.equal(undone.dataUrl, original.dataUrl, "undo restores the complete original image");
    await dialog.getByRole("button", { name: "裁剪", exact: true }).click();
    await dialog.getByRole("button", { name: "应用裁剪", exact: true }).click();
    const cropped = await capture(saveButton);
    await compareTransform(original, cropped, "crop");
    assert.deepEqual(cropped.meta.image, { width: 1280, height: 960 });
    assert.equal(cropped.meta.shapes[1].points.length, original.meta.shapes[1].points.length);
    assert.ok(Math.abs(cropped.meta.shapes[2].fontSize - original.meta.shapes[2].fontSize) < 0.001);
    if (mode === "asset") {
      const temp = await capture("插入创作板 · 不入库");
      assert.deepEqual(temp, cropped, "both material annotation outputs preserve every tool");
    }
    await dialog.getByRole("button", { name: "清空", exact: true }).click();
    assert.equal(await overlay.locator("text, ellipse, polyline").count(), 0);
    await dialog.getByRole("button", { name: "撤销", exact: true }).click();
    assert.equal(await overlay.locator("text, ellipse, polyline").count(), 3);
    await dialog.getByRole("button", { name: "关闭（Esc）", exact: true }).click();
  }
  assert.deepEqual(errors, []);
  console.log("PASS shared annotation tools: circle, closed pencil stroke, multilingual/multiline text, fonts, size, bold, IME/native undo, PNG pixels, rotate/crop/undo, clear/undo, library and temporary outputs");
} finally { await browser.close(); await server.close(); }
