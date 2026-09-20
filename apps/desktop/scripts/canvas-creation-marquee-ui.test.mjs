import assert from "node:assert/strict";
import { createServer } from "vite";

import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";
const server = await createServer({ server: { host: "127.0.0.1", port: 1457, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1200 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const node = id => page.locator(`[data-canvas-node-id="${id}"]`);
const selectionText = () => page.evaluate(() => String(window.getSelection()));
const selectionIsRange = () => page.evaluate(() => window.getSelection().type === "Range");

try {
  await page.goto("http://127.0.0.1:1457/scripts/fixtures/canvas-reference/preview.html");
  await node("old").waitFor();
  await page.evaluate(() => {
    const snapshot = window.snapshot();
    const base = snapshot.nodes[0];
    snapshot.nodes = [
      { ...base, x: 60, y: 80 },
      { ...base, id: "a", assetId: "a", x: 280, y: 80 },
      { ...base, id: "note", kind: "note", role: null, assetId: null, x: 60, y: 400, width: 240, height: 120,
        payloadJson: JSON.stringify({ schema_version: 1, text: "创作模式便签", note_type: "text",
          cells: [[{ text: "创作模式便签", bold: false, italic: false, align: "left" }]] }) },
    ];
    snapshot.groups = [];
    snapshot.groupItems = [];
    snapshot.view = { ...snapshot.view, panX: 0, panY: 0, zoom: 1 };
    sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
    localStorage.setItem("bowerbird.canvasSnapEnabled", "false");
  });
  await page.reload();
  await node("note").waitFor();
  await page.evaluate(() => window.store.getState().setBoardActive(true));
  await page.waitForSelector(".canvas-stage.is-creation-mode");

  // 创作模式下空白拖动即框选（原为浏览模式专属）。
  const stage = await page.locator(".canvas-stage").boundingBox();
  await page.mouse.move(stage.x + 20, stage.y + 60);
  await page.mouse.down();
  await page.mouse.move(stage.x + 400, stage.y + 290, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelectorAll("[data-canvas-node-id].is-selected").length === 2, null, { timeout: 5000 });
  assert.equal(await page.locator("[data-canvas-node-id].is-selected").count(), 2, "creation-mode marquee must select intersecting nodes");
  assert.equal(await selectionIsRange(), false, "marquee drag must not start native text selection");
  assert.equal(await selectionText(), "");

  // 创作模式下拖动图片卡：正常移动，不出现原生文字蓝底选区。
  const cardBox = await node("a").boundingBox();
  await page.mouse.move(cardBox.x + 95, cardBox.y + 90);
  await page.mouse.down();
  await page.mouse.move(cardBox.x + 215, cardBox.y + 170, { steps: 10 });
  await page.mouse.up();
  const movedTransform = await node("a").evaluate(el => el.style.transform);
  assert.equal(movedTransform, "translate3d(400px, 160px, 0px)", "dragging a card in creation mode must move it");
  assert.equal(await selectionIsRange(), false, "card drag must not start native text selection");

  // 创作模式下拖动文本便签（经卡片把手）：移动正常、无蓝底，卡片本体 user-select 关闭。
  const note = page.locator(".canvas-note.is-text");
  assert.equal(await note.evaluate(el => getComputedStyle(el).userSelect), "none");
  const handleBox = await note.locator(".canvas-text-handle").boundingBox();
  await page.mouse.move(handleBox.x + 20, handleBox.y + 15);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + 140, handleBox.y + 95, { steps: 10 });
  await page.mouse.up();
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-canvas-node-id="note"]');
    return el && el.style.transform === "translate3d(180px, 480px, 0px)";
  }, null, { timeout: 5000 });
  assert.equal(await selectionIsRange(), false, "text-note drag must not start native text selection");
  assert.equal(await selectionText(), "");

  // 便签单元格 textarea 的编辑选字不受影响。
  await note.locator("textarea").fill("改写后的便签");
  assert.equal(await note.locator("textarea").inputValue(), "改写后的便签");

  assert.deepEqual(errors, []);
  console.log("PASS: creation-mode marquee selects without native text selection; card and text-note drags stay clean");
} finally {
  await browser.close();
  await server.close();
}
