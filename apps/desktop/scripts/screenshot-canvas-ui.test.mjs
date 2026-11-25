import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 15183, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const fixture = "http://127.0.0.1:15183/scripts/fixtures/canvas-reference/preview.html?detail-route";

async function deliver(requestId, receiptCount) {
  await page.evaluate(async requestId => {
    const { emit } = await import("/@id/@tauri-apps/api/event");
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 150;
    await emit("screenshot://canvas", {
      requestId, dataUrl: canvas.toDataURL(), fileName: "截图",
      meta: {
        schema_version: 1, source_kind: "screenshot", source_asset_id: null, source_store_path: "",
        image: { width: 200, height: 150 },
        shapes: [{ type: "rect", x1: 100, y1: 200, x2: 400, y2: 500, token: "<bbox>100 200 400 500</bbox>" }],
      },
    });
  }, requestId);
  await page.waitForFunction(({ requestId, receiptCount }) => window.calls.filter(call =>
    call.command === "screenshot_canvas_result" && call.args.requestId === requestId).length >= receiptCount, { requestId, receiptCount });
  return page.evaluate(requestId => window.calls.findLast(call =>
    call.command === "screenshot_canvas_result" && call.args.requestId === requestId).args, requestId);
}

const saves = () => page.evaluate(() => window.calls.filter(call => call.command === "save_annotated_image").map(call => call.args));

try {
  await page.goto(fixture + "&provisional");
  await page.waitForFunction(async () => !!(await import('/src/lib/projectCanvasCallbacks.ts')).projectCanvasCallbacks.prepareAnnotation?.());
  const center = await page.locator("[data-canvas-stage]").evaluate(stage => {
    const { width, height } = stage.getBoundingClientRect();
    const view = new DOMMatrix(getComputedStyle(document.querySelector(".canvas-plane")).transform);
    return { x: (width / 2 - view.e) / view.a, y: (height / 2 - view.f) / view.d };
  });
  await page.evaluate(() => { window.failNodeSave = true; });
  assert.match((await deliver("active-capture", 1)).error, /模拟草稿卡片保存失败/);
  await page.evaluate(() => { window.failNodeSave = false; });
  assert.deepEqual(await deliver("active-capture", 2), { requestId: "active-capture", error: null, savedToLibrary: false });
  assert.deepEqual(await deliver("active-capture", 3), { requestId: "active-capture", error: null, savedToLibrary: false });

  const [saved, ...duplicates] = await saves();
  assert.equal(duplicates.length, 0, "delivery retries reuse the same asset");
  assert.equal(saved.projectId, "p");
  assert.match(JSON.parse(saved.annotationJson).shapes[0].token, /^<bbox>/);
  const nodes = await page.evaluate(() => window.snapshot().nodes.filter(node => node.assetId?.startsWith("draft-")));
  assert.equal(nodes.length, 1, "delivery retries create a single node");
  assert.ok(Math.abs(nodes[0].x + nodes[0].width / 2 - center.x) < 0.1);
  assert.ok(Math.abs(nodes[0].y + nodes[0].height / 2 - center.y) < 0.1);
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === "project_canvas_materialize").length), 1);
  await page.locator("[data-canvas-stage]").focus();
  await page.keyboard.press("Control+z");
  await page.waitForFunction(id => window.snapshot().nodes.find(node => node.id === id)?.hiddenAt != null, nodes[0].id);

  await page.goto(fixture + "&media-home");
  await page.waitForFunction(() => window.calls?.some(call => call.args?.event === "screenshot://canvas"));
  assert.deepEqual(await deliver("library-capture", 1), { requestId: "library-capture", error: null, savedToLibrary: true });
  await page.getByText("当前未打开画板，截图已保存到素材库", { exact: true }).waitFor();
  const fallback = await saves();
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].projectId, null);
  assert.equal(await page.evaluate(() => window.calls.some(call => call.command === "project_canvas_node_create")), false);
  console.log("PASS screenshot canvas delivery: materialization, viewport-center placement, retry, undo, and library fallback");
} finally {
  await browser.close();
  await server.close();
}
