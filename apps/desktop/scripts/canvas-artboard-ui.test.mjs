import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1586, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1900, height: 1100 } });
await page.emulateMedia({ reducedMotion: "reduce" });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const node = id => page.locator(`[data-canvas-node-id="${id}"]`);
try {
  await page.goto("http://127.0.0.1:1586/scripts/fixtures/canvas-reference/preview.html");
  await node("old").waitFor();
  await page.evaluate(() => {
    const raster = (transparent) => {
      const c = document.createElement("canvas"); c.width = c.height = 100;
      const ctx = c.getContext("2d");
      ctx.fillStyle = transparent ? "#00ff00" : "#a0aab4";
      ctx.fillRect(transparent ? 25 : 0, transparent ? 25 : 0, transparent ? 50 : 100, transparent ? 50 : 100);
      return c.toDataURL();
    };
    sessionStorage.setItem("reference-drafts", JSON.stringify([false, true].map((alpha, i) => ({
      id: alpha ? "earring" : "model", name: alpha ? "透明耳饰" : "模特", width: 100, height: 100, ext: "png", source: "annotation",
      store_path: raster(alpha), thumb_path: raster(alpha),
    }))));
    const snapshot = window.snapshot(), base = snapshot.nodes[0];
    snapshot.nodes = [
      { ...base, id: "model-node", assetId: "model", x: 900, y: 200, width: 200, height: 200 },
      { ...base, id: "earring-node", assetId: "earring", x: 360, y: 260, width: 100, height: 100 },
    ];
    snapshot.groups = []; snapshot.groupItems = []; snapshot.edges = [];
    snapshot.view = { ...snapshot.view, panX: 0, panY: 0, zoom: 1 };
    sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
    sessionStorage.setItem("canvas-settings", JSON.stringify({ canvas_show_asset_names: false, canvas_snap_enabled: false }));
  });
  await page.reload(); await node("model-node").waitFor();
  // Create by drawing, beside the existing section tool.
  await page.getByRole("button", { name: "画板工具", exact: true }).click();
  const stage = await page.locator(".canvas-stage").boundingBox();
  await page.mouse.move(stage.x + 300, stage.y + 180); await page.mouse.down();
  await page.mouse.move(stage.x + 700, stage.y + 580, { steps: 10 }); await page.mouse.up();
  await page.locator(".is-artboard").waitFor();
  await page.waitForFunction(() => window.snapshot().nodes.some(n => JSON.parse(n.payloadJson).artboard));
  const first = await page.evaluate(() => window.snapshot().nodes.find(n => JSON.parse(n.payloadJson).artboard));
  assert.deepEqual([first.x, first.y, first.width, first.height], [300, 180, 400, 400]);
  await node("model-node").click({ button: "right" });
  await page.getByRole("menuitem", { name: "以此图新建画板" }).click();
  await page.waitForFunction(() => window.snapshot().nodes.some(n => JSON.parse(n.payloadJson).artboard?.base_asset_id === "model"));
  assert.equal(await page.locator(".canvas-artboard-base").count(), 1);
  // Persist/reload, keeping only the model-based frame for the compositing checks.
  await page.evaluate(() => {
    const snapshot = window.snapshot();
    snapshot.nodes = snapshot.nodes.filter(n => !JSON.parse(n.payloadJson).artboard || JSON.parse(n.payloadJson).artboard.base_asset_id);
    const frame = snapshot.nodes.find(n => JSON.parse(n.payloadJson).artboard);
    Object.assign(frame, { x: 300, y: 180, width: 400, height: 400 });
    sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
  });
  await page.reload(); await page.locator(".canvas-artboard-base").waitFor();
  const frameId = await page.locator(".is-artboard").getAttribute("data-canvas-node-id");
  if (await page.getByRole("button", { name: "吸附对齐", exact: true }).getAttribute("aria-pressed") === "true") await page.getByRole("button", { name: "吸附对齐", exact: true }).click();
  // Moving a frame carries an image dropped into its geometry, and leaves the source alone.
  const heading = page.locator(".is-artboard .canvas-section-heading");
  const before = await node("earring-node").boundingBox(), h = await heading.boundingBox();
  await page.mouse.move(h.x + 8, h.y + 8); await page.mouse.down();
  await page.mouse.move(h.x + 58, h.y + 38, { steps: 6 }); await page.mouse.up();
  const after = await node("earring-node").boundingBox();
  assert.equal(Math.round(after.x - before.x), 50); assert.equal(Math.round(after.y - before.y), 30);
  assert.equal((await page.evaluate(() => window.snapshot())).nodes.find(n => n.id === "model-node").x, 900);
  // Use actual store submission with closed synthetic IPC, never a real model.
  await page.evaluate(() => {
    window.store.setState({ activeGenProvider: "bowerbird-cloud-image_hd" });
    const original = window.__TAURI_INTERNALS__.invoke;
    window.artboardCalls = []; window.failPrepare = true;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "save_annotation_temp") {
        if (window.failPrepare) throw "模拟临时参考图保存失败";
        window.artboardCalls.push({ command, args });
        return { id: args.fileName, name: args.fileName, width: 100, height: 100, store_path: args.dataUrl, ext: "png" };
      }
      if (command === "codex_create_image") { window.artboardCalls.push({ command, args }); return null; }
      return original(command, args);
    };
  });
  await page.getByRole("button", { name: "合成画板中的内容", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "合成画板中的内容" });
  await dialog.locator('img[alt="画板拼放预览"]').waitFor();
  // A transparent corner retains the base; the opaque center retains the overlay color.
  const pixels = await dialog.locator('img[alt="画板拼放预览"]').evaluate(async img => {
    await img.decode(); const canvas = document.createElement("canvas"); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d"); ctx.drawImage(img, 0, 0);
    return [[17, 22], [27, 32]].map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]);
  });
  assert.deepEqual(pixels[0], [160, 170, 180, 255]); assert.deepEqual(pixels[1], [0, 255, 0, 255]);
  await dialog.getByLabel("合成提示词").fill("给人物戴上耳饰");
  await dialog.getByRole("button", { name: "开始合成" }).click();
  await dialog.getByRole("alert").waitFor();
  assert.equal(await page.evaluate(() => window.artboardCalls.length), 0);
  await page.evaluate(() => { window.failPrepare = false; });
  await dialog.getByRole("button", { name: "开始合成" }).click();
  await dialog.waitFor({ state: "detached" });
  const calls = await page.evaluate(() => window.artboardCalls);
  assert.equal(calls.filter(call => call.command === "save_annotation_temp").length, 2);
  const sent = calls.find(call => call.command === "codex_create_image").args;
  assert.equal(sent.referenceImages.length, 4);
  assert.match(sent.prompt, /给人物戴上耳饰/); assert.match(sent.prompt, /红框 1.*参考图4/);
  assert.equal(sent.projectId, "p"); assert.ok(sent.threadId); assert.equal(sent.referenceNodeIds[3], "earring-node");
  assert.equal(calls.filter(call => call.command === "codex_create_image").length, 1);
  await mkdir(".tmp/canvas-artboard", { recursive: true });
  await page.screenshot({ path: ".tmp/canvas-artboard/canvas.png" });
  await page.getByRole("button", { name: "合成画板中的内容", exact: true }).click();
  await dialog.locator('img[alt="基底与编号红框"]').waitFor();
  await page.screenshot({ path: ".tmp/canvas-artboard/composition.png" });
  await page.evaluate(() => document.documentElement.dataset.theme = "dark");
  await page.setViewportSize({ width: 780, height: 850 });
  const modalBounds = await dialog.locator(".app-modal").boundingBox();
  assert.ok(modalBounds.x >= 0 && modalBounds.x + modalBounds.width <= 780);
  await page.screenshot({ path: ".tmp/canvas-artboard/composition-dark-narrow.png" });
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.setViewportSize({ width: 1900, height: 1100 });
  await page.evaluate(() => document.documentElement.dataset.theme = "light");
  // Frame resizing changes its extent but preserves image geometry, as sections do.
  await heading.locator("svg").click();
  const knob = node(frameId).locator('[data-corner="se"]'), bounds = await knob.boundingBox();
  const imageBefore = await node("earring-node").boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 80, bounds.y + bounds.height / 2 + 40, { steps: 6 }); await page.mouse.up();
  assert.deepEqual(await node("earring-node").boundingBox(), imageBefore);
  await page.evaluate(() => window.save()); await page.reload();
  await node(frameId).waitFor(); assert.equal(await page.locator(".canvas-artboard-base").count(), 1);
  assert.deepEqual(errors, []);
  console.log("PASS artboard drawing, image base, move/resize/reload, transparency, preview, preparation failure and exact generation request.");
} finally { await browser.close(); await server.close(); }
