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
      { ...base, id: "prompt", kind: "prompt", role: null, assetId: null, x: 600, y: 80, width: 300, height: 180,
        payloadJson: JSON.stringify({ schema_version: 1, text: "拖动会话卡片正文，不应出现蓝色文字选区。第二行内容用于检查拖动中的原生选字。", status: "succeeded" }) },
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

  // ReadonlyPrompt explicitly enables text selection, overriding the card's rule.
  // Start on its actual text and check while held, not just after pointerup.
  const prompt = node("prompt");
  async function dragPrompt() {
    const promptText = await prompt.locator(".ProseMirror p").first().boundingBox();
    const promptBefore = await prompt.boundingBox();
    await page.mouse.move(promptText.x + 6, promptText.y + 7);
    await page.mouse.down();
    for (const offset of [2, 4, 20, 60, 100]) {
      await page.mouse.move(promptText.x + 6 + offset, promptText.y + 7 + offset / 2);
      assert.equal(await selectionIsRange(), false, `prompt drag must not select text at ${offset}px`);
    }
    await page.mouse.up();
    const promptAfter = await prompt.boundingBox();
    assert.ok(promptAfter.x - promptBefore.x > 90, "dragging readonly prompt text moves its card");
  }
  await dragPrompt();

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
  await note.locator("textarea").press("Home");
  await note.locator("textarea").press("Shift+End");
  assert.deepEqual(await note.locator("textarea").evaluate(el => [el.selectionStart, el.selectionEnd]), [0, 6]);

  // Browsing uses the same drag path, including clearing an earlier selection.
  await page.evaluate(() => window.store.getState().setBoardActive(false));
  await page.waitForSelector(".canvas-stage:not(.is-creation-mode)");
  await dragPrompt();

  // Editable rich text still selects normally; grabbing a workflow header clears it.
  await page.getByRole("button", { name: "新增生成卡片", exact: true }).click();
  await page.getByRole("button", { name: "适应内容", exact: true }).click();
  const generation = page.locator(".workflow-card.is-generation");
  const editor = generation.getByLabel("卡片指令", { exact: true });
  await editor.fill("可以选中文字");
  await editor.press("Home");
  await editor.press("Shift+End");
  assert.equal(await selectionText(), "可以选中文字");
  const header = await generation.locator("header strong").boundingBox();
  const generationBefore = await generation.boundingBox();
  await page.mouse.move(header.x + 10, header.y + header.height / 2);
  await page.mouse.down();
  await page.mouse.move(header.x + 70, header.y + header.height / 2 + 40, { steps: 8 });
  assert.equal(await selectionIsRange(), false, "workflow dragging clears the previous editor selection");
  await page.mouse.up();
  assert.ok((await generation.boundingBox()).x - generationBefore.x > 50);
  await editor.fill("拖动后仍可编辑");
  assert.equal(await editor.innerText(), "拖动后仍可编辑");

  assert.deepEqual(errors, []);
  console.log("PASS: marquee and card drags suppress native selection in both modes; textarea and rich-text editing remain selectable");
} finally {
  await browser.close();
  await server.close();
}
