import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1563, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const dialog = page.getByRole("dialog", { name: "图片标注", exact: true });
async function openAndDraw() {
  await page.evaluate(() => window.store.getState().openAnnotator("existing"));
  await dialog.getByAltText("合成参考 existing", { exact: true }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "添加到画板", exact: true }).isDisabled(), true);
  const box = await dialog.locator("svg.cursor-crosshair").boundingBox();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 5 });
  await page.mouse.up();
}
try {
  await page.goto("http://127.0.0.1:1563/scripts/fixtures/canvas-reference/preview.html?provisional&strict-canvas");
  await page.waitForFunction(() => window.store?.getState().prepareCanvasAnnotation);
  await openAndDraw();
  await dialog.getByRole("button", { name: "添加到画板", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const saved = await page.evaluate(() => ({ calls: window.calls, snapshot: window.snapshot() }));
  const ingest = saved.calls.find(call => call.command === "save_annotated_image");
  assert.equal(ingest.args.projectId, "p");
  assert.equal(ingest.args.fileName, "合成参考 existing-标注");
  const meta = JSON.parse(ingest.args.annotationJson);
  assert.equal(meta.source_asset_id, "existing");
  assert.equal(meta.shapes.length, 1);
  assert.match(meta.shapes[0].token, /<bbox>/);
  assert.ok(saved.calls.findIndex(call => call.command === "project_canvas_materialize") < saved.calls.indexOf(ingest));
  assert.equal(saved.calls.some(call => call.command === "save_annotation_temp"), false);
  const node = saved.snapshot.nodes.find(node => node.assetId?.startsWith("draft-"));
  assert.ok(node);
  assert.equal(node.projectId, "p");
  const card = page.locator(`[data-canvas-node-id="${node.id}"]`);
  await card.waitFor();
  const box = await card.boundingBox();
  assert.ok(box.x >= 0 && box.y >= 0 && box.x < 1800 && box.y < 1000);
  await page.evaluate(() => window.save());
  await page.reload();
  await card.waitFor();

  // Retry a failed node write without ingesting a second copy of the image.
  await page.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.failAnnotationNode = true;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "project_canvas_node_create" && window.failAnnotationNode) throw "模拟标注卡片保存失败";
      return invoke(command, args);
    };
  });
  await openAndDraw();
  await dialog.getByRole("button", { name: "添加到画板", exact: true }).click();
  await page.getByText("模拟标注卡片保存失败", { exact: false }).first().waitFor();
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await page.evaluate(() => window.snapshot().nodes.filter(node => node.assetId?.startsWith("draft-")).length), 1);
  await page.evaluate(() => { window.failAnnotationNode = false; });
  await dialog.getByRole("button", { name: "添加到画板", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === "save_annotated_image").length), 1);
  assert.equal(await page.evaluate(() => window.snapshot().nodes.filter(node => node.assetId?.startsWith("draft-")).length), 2);

  await page.evaluate(() => { window.store.setState({ prepareCanvasAnnotation: null }); window.store.getState().openAnnotator("existing"); });
  assert.equal(await dialog.getByRole("button", { name: "添加到画板", exact: true }).isDisabled(), true);
  assert.deepEqual(errors, []);
  console.log("PASS annotation canvas: provisional project, metadata, visible card, reload, failed write retry without duplicate ingestion, unavailable canvas");
} finally { await browser.close(); await server.close(); }
