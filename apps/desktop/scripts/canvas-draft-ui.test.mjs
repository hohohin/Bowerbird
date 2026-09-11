import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1558, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const dialog = page.getByRole("dialog", { name: "草稿", exact: true });
const saves = () => page.evaluate(() => window.calls.filter(call => call.command === "save_annotated_image"));
async function openDraft(selector = "[data-canvas-stage]") {
  const target = page.locator(selector);
  const box = await target.boundingBox();
  const x = box.x + (selector === "[data-canvas-stage]" ? 80 : box.width / 2);
  const y = box.y + (selector === "[data-canvas-stage]" ? 80 : box.height / 2);
  const point = await page.locator("[data-canvas-stage]").evaluate((element, { x, y }) => {
    const rect = element.getBoundingClientRect();
    const matrix = new DOMMatrix(getComputedStyle(document.querySelector(".canvas-plane")).transform);
    return { x: (x - rect.left - matrix.e) / matrix.a, y: (y - rect.top - matrix.f) / matrix.d };
  }, { x, y });
  await page.mouse.click(x, y, { button: "right" });
  await page.getByRole("menuitem", { name: "新建草稿", exact: true }).click();
  await dialog.getByAltText("白底草稿").waitFor();
  return point;
}
async function draw(tool = "画框") {
  await dialog.getByRole("button", { name: tool, exact: true }).click();
  const box = await dialog.getByAltText("白底草稿").boundingBox();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 10 });
  await page.mouse.up();
}
async function load(suffix = "") {
  await page.goto(`http://127.0.0.1:1558/scripts/fixtures/canvas-reference/preview.html${suffix}`);
  await page.waitForFunction(() => document.querySelector('.canvas-workspace[aria-busy="false"]'));
}
try {
  await load();
  await openDraft();
  assert.equal(await dialog.getByRole("button", { name: "保存到画板", exact: true }).isEnabled(), false);
  assert.equal(await dialog.getByRole("button", { name: /不入库/ }).count(), 0);
  const white = await dialog.getByAltText("白底草稿").evaluate(img => {
    const canvas = document.createElement("canvas"); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const context = canvas.getContext("2d"); context.drawImage(img, 0, 0);
    return { width: canvas.width, height: canvas.height, pixel: [...context.getImageData(800, 600, 1, 1).data] };
  });
  assert.deepEqual(white, { width: 1600, height: 1200, pixel: [255, 255, 255, 255] });
  await draw(); await page.keyboard.press("Control+z");
  assert.equal(await dialog.getByRole("button", { name: "保存到画板", exact: true }).isEnabled(), false);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal((await saves()).length, 0);

  await page.getByRole("button", { name: "放大", exact: true }).click();
  const point = await openDraft();
  await draw(); await draw("箭头");
  await mkdir(".tmp", { recursive: true });
  await page.screenshot({ path: ".tmp/canvas-draft-editor.png" });
  await page.evaluate(() => { window.failNodeSave = true; });
  await dialog.getByRole("button", { name: "保存到画板", exact: true }).click();
  await page.getByText("模拟草稿卡片保存失败", { exact: false }).first().waitFor();
  assert.equal(await dialog.isVisible(), true);
  await page.evaluate(() => { window.failNodeSave = false; });
  await dialog.getByRole("button", { name: "保存到画板", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal((await saves()).length, 1, "retry must reuse the saved asset");
  const saved = (await saves())[0].args;
  const meta = JSON.parse(saved.annotationJson);
  assert.equal(meta.source_asset_id, null);
  assert.deepEqual(meta.shapes.map(shape => shape.type), ["rect", "arrow"]);
  assert.equal(meta.shapes[0].color, "#111111");
  assert.match(meta.shapes[0].token, /^<bbox>/);
  assert.match(meta.shapes[1].token, /^<point>/);
  const pixels = await page.evaluate(async url => {
    const img = new Image(); img.src = url; await img.decode();
    const canvas = document.createElement("canvas"); canvas.width = img.width; canvas.height = img.height;
    const context = canvas.getContext("2d"); context.drawImage(img, 0, 0);
    return { background: [...context.getImageData(10, 10, 1, 1).data],
      line: [...context.getImageData(320, 400, 1, 1).data] };
  }, saved.dataUrl);
  assert.deepEqual(pixels.background, [255, 255, 255, 255]);
  assert.deepEqual(pixels.line, [17, 17, 17, 255], "export must burn the marks into the image");
  const node = await page.evaluate(() => window.snapshot().nodes.find(node => node.assetId?.startsWith("draft-")));
  assert.equal(node.projectId, "p"); assert.equal(node.threadId, null);
  assert.ok(Math.abs(node.x + node.width / 2 - point.x) < 0.01);
  assert.ok(Math.abs(node.y + node.height / 2 - point.y) < 0.01);
  await page.locator(`[data-canvas-node-id="${node.id}"]`).waitFor();
  await page.screenshot({ path: ".tmp/canvas-draft-saved.png" });
  await page.locator(`[data-canvas-node-id="${node.id}"]`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "图片标注", exact: true }).click();
  const regular = page.getByRole("dialog", { name: "图片标注", exact: true });
  await regular.locator("img").waitFor();
  assert.equal(await regular.getByRole("button", { name: "保存到素材库", exact: true }).count(), 1);
  assert.equal(await regular.getByRole("button", { name: /不入库/ }).count(), 1);
  await regular.getByRole("button", { name: "右转 90°", exact: true }).click();
  await regular.getByRole("button", { name: "保存到素材库", exact: true }).click();
  await regular.waitFor({ state: "hidden" });
  assert.equal(JSON.parse((await saves())[1].args.annotationJson).source_asset_id, node.assetId);

  await openDraft('[data-canvas-node-id="old"]');
  assert.equal(await dialog.getByRole("button", { name: "保存到画板", exact: true }).isEnabled(), false, "new drafts reset previous annotations");
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.launch());
  await page.locator('[data-canvas-node-id="gen-prompt:job:turn:0"]').waitFor();
  await openDraft('[data-canvas-node-id="gen-prompt:job:turn:0"]');
  await page.keyboard.press("Escape");

  await load("?provisional");
  await openDraft(); await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => window.calls.some(call => call.command === "project_canvas_materialize")), false);
  await openDraft(); await draw();
  await page.evaluate(() => { window.failDraftSave = true; });
  await dialog.getByRole("button", { name: "保存到画板", exact: true }).click();
  await page.getByText("模拟草稿保存失败", { exact: false }).first().waitFor();
  await page.evaluate(() => { window.failDraftSave = false; });
  await dialog.getByRole("button", { name: "保存到画板", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const calls = await page.evaluate(() => window.calls.map(call => call.command));
  assert.ok(calls.indexOf("project_canvas_materialize") < calls.indexOf("save_annotated_image"));
  assert.ok(calls.indexOf("save_annotated_image") < calls.indexOf("project_canvas_node_create"));
  assert.equal(await page.evaluate(() => window.snapshot().nodes.filter(node => node.assetId?.startsWith("draft-")).length), 1);
  await page.evaluate(() => window.save()); await page.reload();
  await page.waitForFunction(() => document.querySelector('[data-canvas-node-id^="asset-"]'));
  assert.deepEqual(errors, []);
  console.log("PASS canvas draft: blank/asset/prompt menus, white PNG, black marks, arrows, undo, cancel/reset, zoomed placement, failure/retry without duplicates, provisional persistence and reload");
} finally { await browser.close(); await server.close(); }
