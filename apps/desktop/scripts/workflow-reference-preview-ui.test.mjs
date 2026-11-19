import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const entry = "scripts/fixtures/canvas-reference/preview.html";
const server = await createServer({ cacheDir: ".tmp/workflow-reference-preview-vite", optimizeDeps: { entries: [entry] },
  server: { host: "127.0.0.1", port: 17991, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + entry);
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const { newWorkflowNode, emptyWorkflow } = await import("/src/lib/canvasWorkflow.ts");
    const canvas = window.snapshot();
    canvas.nodes = [{ ...canvas.nodes[0], assetId: "warm", x: 60, y: 100 }];
    canvas.view = { ...canvas.view, panX: 0, panY: 0, zoom: 1 };
    sessionStorage.setItem("reference-fixture", JSON.stringify(canvas));
    const img = document.createElement("canvas");
    img.width = 2; img.height = 1;
    const ctx = img.getContext("2d");
    ctx.fillStyle = "red"; ctx.fillRect(1, 0, 1, 1);
    const warm = img.toDataURL("image/png"), jpeg = img.toDataURL("image/jpeg");
    ctx.fillStyle = "blue"; ctx.fillRect(1, 0, 1, 1);
    const cold = img.toDataURL("image/png");
    sessionStorage.setItem("reference-preview-colours", JSON.stringify({ warm, cold }));
    sessionStorage.setItem("reference-drafts", JSON.stringify([
      ["warm", "warm", jpeg], ["cold", "cold", cold], ["revised", "warm", jpeg + "#2"],
      ["offscreen", "offscreen", cold], ["missing", "missing", "/fixture/missing-thumb.png"],
    ].map(([id, file, thumb_path]) => ({ id, name: id, ext: "png", width: 4000, height: 2000,
      source: "annotation", store_path: "/fixture/" + file + ".png", thumb_path }))));
    const draw = { ...newWorkflowNode("generation", 400, 70, "codex"), id: "draw" };
    const far = { ...draw, id: "far", x: 20000, inputs: { image: [{ assetId: "offscreen" }] } };
    sessionStorage.setItem("workflow-p", JSON.stringify({ revision: 1, document: { ...emptyWorkflow(), nodes: [draw, far] } }));
  });
  await page.addInitScript(() => {
    const { warm, cold } = JSON.parse(sessionStorage.getItem("reference-preview-colours"));
    window.previewLog = [];
    let internals;
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true, get: () => internals, set(value) {
        const invoke = value.invoke;
        internals = { ...value, invoke: async (cmd, args) => {
          if (cmd !== "canvas_image_preview") return invoke(cmd, args);
          window.previewLog.push(args.path);
          if (window.holdPreviews) return new Promise(resolve => { window.finishPreview = resolve; });
          return args.path === "/fixture/warm.png" ? warm : cold;
        } };
      },
    });
  });
  const missingRequested = page.waitForRequest("**/fixture/missing-thumb.png");
  await page.route("**/fixture/missing-thumb.png", route => route.fulfill({ status: 404, body: "" }));
  await page.reload();
  await page.waitForFunction(() => {
    const img = document.querySelector('[data-canvas-node-id="old"] img');
    return img?.src === JSON.parse(sessionStorage.getItem("reference-preview-colours")).warm && img.complete && img.naturalWidth;
  });
  await page.evaluate(async () => {
    window.holdPreviews = true;
    const { canvasWorkflowController } = await import("/src/lib/canvasWorkflowRuntime.ts");
    const controller = canvasWorkflowController("p");
    window.setReferences = (ids, drawX = 400) => controller.edit(controller.document.nodes.map(node =>
      node.id === "draw" ? { ...node, x: drawX, inputs: { image: ids.map(assetId => ({ assetId })) } } : node));
    await window.setReferences(["warm", "cold", "revised", "missing"]);
  });
  const image = id => page.locator('[data-workflow-reference-asset="' + id + '"] img');
  const expectColour = async (id, colour) => page.waitForFunction(([id, colour]) => {
    const img = document.querySelector('[data-workflow-reference-asset="' + id + '"] img');
    return img?.src === JSON.parse(sessionStorage.getItem("reference-preview-colours"))[colour] && img.complete && img.naturalWidth;
  }, [id, colour], { timeout: 5000 });
  await expectColour("warm", "warm");
  await expectColour("cold", "cold");
  assert.deepEqual(await image("warm").evaluate(img => {
    const canvas = document.createElement("canvas");
    canvas.width = 2; canvas.height = 1;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    return [...ctx.getImageData(0, 0, 2, 1).data];
  }), [0, 0, 0, 0, 255, 0, 0, 255], "a borrowed preview retains transparent pixels");
  await image("missing").scrollIntoViewIfNeeded();
  await missingRequested;
  for (const id of ["revised", "missing", "offscreen"]) {
    await page.waitForFunction(el => el.getAttribute("data-canvas-media-loaded") === "false", await image(id).elementHandle());
    assert.match(await image(id).getAttribute("src"), /^data:image\/svg\+xml,/);
  }
  // The held request belongs to warm. Remove it, then verify that its late reply cannot replace cold.
  await page.evaluate(() => window.setReferences(["cold"]));
  await expectColour("cold", "cold");
  await page.evaluate(() => {
    window.holdPreviews = false;
    window.finishPreview(JSON.parse(sessionStorage.getItem("reference-preview-colours")).warm);
  });
  await page.waitForFunction(() => window.previewLog.includes("/fixture/cold.png"));
  await expectColour("cold", "cold");
  assert.equal(await image("warm").count(), 0);
  assert.deepEqual(await page.evaluate(() => window.previewLog),
    ["/fixture/warm.png", "/fixture/warm.png", "/fixture/cold.png"], "unmounted and offscreen requests never start");
  assert.deepEqual(errors, []);
  console.log("PASS visible same-version preview reuse, transparency, cold thumbnail, missing thumbnail, late result and offscreen queue");
} finally {
  await browser.close();
  await server.close();
}
