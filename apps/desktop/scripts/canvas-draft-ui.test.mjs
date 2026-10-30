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
const dialog = page.getByRole("dialog", { name: "草稿编辑器", exact: true });
const saves = () => page.evaluate(() => window.calls.filter(call => call.command === "draft_workspace_save"));
async function openDraft() {
  // Camera updates are painted on animation frames; read the visible transform after settling.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const target = page.locator("[data-canvas-stage]");
  const { x, y } = await target.evaluate(element => {
    const rect = element.getBoundingClientRect();
    for (let dy = 80; dy < rect.height - 120; dy += 100) {
      for (let dx = 80; dx < rect.width - 80; dx += 100) {
        const x = rect.left + dx, y = rect.top + dy;
        const hit = document.elementFromPoint(x, y);
        if (hit === element || hit?.classList.contains("canvas-plane")) return { x, y };
      }
    }
    throw new Error("没有找到可右键的画布空白位置");
  });
  const point = await target.evaluate((element, { x, y }) => {
    const rect = element.getBoundingClientRect();
    const matrix = new DOMMatrix(getComputedStyle(document.querySelector(".canvas-plane")).transform);
    return { x: (x - rect.left - matrix.e) / matrix.a, y: (y - rect.top - matrix.f) / matrix.d };
  }, { x, y });
  await page.mouse.click(x, y, { button: "right" });
  await page.getByRole("menuitem", { name: "新建草稿", exact: true }).click();
  await dialog.locator("[data-draft-canvas]").waitFor();
  assert.equal(await dialog.getByRole("button", { name: "创建画布", exact: true }).count(), 0);
  return point;
}
async function expectNoDraft(selector) {
  await page.locator(selector).click({ button: "right" });
  await page.getByRole("menu").waitFor();
  assert.equal(await page.getByRole("menuitem", { name: "新建草稿", exact: true }).count(), 0);
  await page.keyboard.press("Escape");
}
async function draw(tool = "画笔", from = [0.2, 0.3], to = [0.7, 0.6]) {
  await dialog.getByRole("button", { name: tool, exact: true }).click();
  const box = await dialog.locator("[data-draft-canvas]").boundingBox();
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 15 });
  await page.mouse.up();
}
async function load(suffix = "") {
  await page.goto(`http://127.0.0.1:1558/scripts/fixtures/canvas-reference/preview.html${suffix}`);
  await page.waitForFunction(() => document.querySelector('.canvas-workspace[aria-busy="false"]'));
}
async function reopen(nodeId) {
  await page.locator(`[data-canvas-node-id="${nodeId}"]`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "编辑草稿", exact: true }).click();
  await dialog.locator("[data-draft-canvas]").waitFor();
}
try {
  await load();
  await openDraft();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal((await saves()).length, 0, "closing an unchanged draft must not create an asset");

  await page.getByRole("button", { name: "放大", exact: true }).click();
  const point = await openDraft();
  await page.waitForFunction(() => document.querySelector("[data-draft-canvas]")?.getContext("2d").getImageData(10, 10, 1, 1).data[3] === 255);
  const white = await dialog.locator("[data-draft-canvas]").evaluate(canvas => ({
    width: canvas.width, height: canvas.height, pixel: [...canvas.getContext("2d").getImageData(10, 10, 1, 1).data],
  }));
  assert.deepEqual(white, { width: 1600, height: 1200, pixel: [255, 255, 255, 255] });
  const outerBefore = await page.locator(".canvas-plane").evaluate(element => getComputedStyle(element).transform);
  await draw();
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+Shift+z");
  await draw("矩形", [0.1, 0.1], [0.4, 0.5]);
  await draw("箭头", [0.5, 0.15], [0.8, 0.4]);
  assert.equal(await page.locator(".canvas-plane").evaluate(element => getComputedStyle(element).transform), outerBefore, "editor history must not modify the project viewport");
  await mkdir(".tmp", { recursive: true });
  await page.screenshot({ path: ".tmp/canvas-draft-editor.png" });
  await page.evaluate(() => { window.failNodeSave = true; });
  await dialog.getByRole("button", { name: "保存到画板", exact: true }).click();
  await page.getByText("模拟草稿卡片保存失败", { exact: false }).first().waitFor();
  assert.equal(await dialog.isVisible(), true);
  await page.evaluate(() => { window.failNodeSave = false; });
  await dialog.getByRole("button", { name: "保存到画板", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal((await saves()).length, 1, "node retry must reuse the saved asset");
  const saved = (await saves())[0].args;
  assert.equal(saved.projectId, "p");
  assert.equal(saved.document.schemaVersion, 1);
  assert.equal(saved.document.layers.length, 2);
  assert.equal(saved.document.layers[0].locked, true);
  assert.equal(saved.document.layers[1].kind, "raster");
  assert.ok(saved.saveId);
  const pixels = await page.evaluate(async ({ composite, layer }) => {
    const inspect = async url => {
      const img = new Image(); img.src = url; await img.decode();
      const canvas = document.createElement("canvas"); canvas.width = img.width; canvas.height = img.height;
      const context = canvas.getContext("2d"); context.drawImage(img, 0, 0);
      const all = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0;
      for (let i = 0; i < all.length; i += 4) if (all[i + 3] > 0 && all[i] < 80 && all[i + 1] < 80 && all[i + 2] < 80) ink++;
      return { width: canvas.width, height: canvas.height, corner: [...context.getImageData(10, 10, 1, 1).data], ink };
    };
    return { composite: await inspect(composite), layer: await inspect(layer) };
  }, { composite: saved.dataUrl, layer: saved.document.layers[1].dataUrl });
  assert.deepEqual(pixels.composite.corner, [255, 255, 255, 255]);
  assert.deepEqual(pixels.layer.corner, [0, 0, 0, 0], "paint stays on its transparent editable layer");
  assert.ok(pixels.composite.ink > 500 && pixels.layer.ink > 500, "paint and shapes must be present in the raster output");
  const node = await page.evaluate(() => window.snapshot().nodes.find(node => node.assetId?.startsWith("draft-")));
  assert.equal(node.projectId, "p"); assert.equal(node.threadId, null);
  assert.ok(Math.abs(node.x + node.width / 2 - point.x) < 0.01, JSON.stringify({node, point}));
  assert.ok(Math.abs(node.y + node.height / 2 - point.y) < 0.01);
  await page.locator(`[data-canvas-node-id="${node.id}"]`).waitFor();
  await page.screenshot({ path: ".tmp/canvas-draft-saved.png" });

  await page.evaluate(id => {
    window.launch(false, false); window.save();
    const snapshot = JSON.parse(sessionStorage.getItem("reference-fixture"));
    const node = snapshot.nodes.find(node => node.id === id);
    Object.assign(node, { x: node.x + 25, y: node.y + 30, zIndex: 19, positionLocked: true });
    snapshot.edges.push({ id: "draft-reference", projectId: "p", threadId: "t", fromNodeId: id,
      toNodeId: "gen-prompt:job:turn:0", kind: "input", ordinal: 1, createdAt: 10 });
    sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
  }, node.id);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.canvas-workspace[aria-busy="false"]'));
  const placed = await page.evaluate(id => window.snapshot().nodes.find(node => node.id === id), node.id);
  const linked = await page.evaluate(() => window.snapshot().edges);
  const geometry = node => ({ id: node.id, x: node.x, y: node.y, width: node.width, height: node.height, zIndex: node.zIndex, positionLocked: node.positionLocked });
  await reopen(node.id);
  assert.equal(await dialog.getByRole("button", { name: "创建画布", exact: true }).count(), 0);
  await draw("画笔", [0.2, 0.8], [0.8, 0.8]);
  await page.evaluate(() => { window.loseNodeSaveReply = true; });
  await dialog.getByRole("button", { name: "保存到画板", exact: true }).click();
  await page.getByText("模拟草稿卡片确认失败", { exact: false }).first().waitFor();
  await page.evaluate(() => { window.loseNodeSaveReply = false; });
  await dialog.getByRole("button", { name: "保存到画板", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const snapshots = await page.evaluate(() => window.snapshot().nodes.filter(node => node.assetId?.startsWith("draft-")));
  assert.equal(snapshots.length, 1, "editing updates the existing draft card");
  assert.notEqual(snapshots[0].assetId, node.assetId, "immutable pixel versions stay separate");
  assert.deepEqual(geometry(snapshots[0]), geometry(placed), "reopened saves preserve node identity and layout");
  assert.deepEqual(await page.evaluate(() => window.snapshot().edges), linked, "reference edges stay connected to the same node");
  assert.equal((await saves()).length, 1, "lost-reply retry reuses its saved asset");

  await page.evaluate(assetId => window.store.getState().openDraftEditor({ assetId, projectId: "p" }), node.assetId);
  await dialog.locator("[data-draft-canvas]").waitFor();
  await draw("画笔", [0.2, 0.7], [0.7, 0.7]);
  await dialog.getByRole("button", { name: "保存到画板", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const latest = await page.evaluate(() => window.snapshot().nodes.filter(node => node.assetId?.startsWith("draft-")));
  assert.equal(latest.length, 1, "opening an older library version finds the persistent document card");
  assert.deepEqual(geometry(latest[0]), geometry(placed));
  assert.deepEqual(await page.evaluate(() => window.snapshot().edges), linked);

  await page.evaluate(async () => {
    const [original] = await window.__TAURI_INTERNALS__.invoke("get_assets_by_ids", { assetIds: ["existing"] });
    original.ext = "png";
  });
  await reopen("old"); await draw();
  await dialog.getByRole("button", { name: "保存到画板", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => window.snapshot().nodes.find(node => node.id === "old").assetId), "existing", "turning an ordinary image into a draft preserves its original card");
  assert.equal(await page.evaluate(() => window.snapshot().nodes.filter(node => node.assetId?.startsWith("draft-")).length), 2, "an unrelated new document gets its own card");

  await page.locator(`[data-canvas-node-id="${node.id}"]`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "图片标注", exact: true }).click();
  const regular = page.getByRole("dialog", { name: "图片标注", exact: true });
  await regular.locator("img").waitFor();
  assert.equal(await regular.getByRole("button", { name: "保存到素材库", exact: true }).count(), 1);
  assert.equal(await regular.getByRole("button", { name: /不入库/ }).count(), 1);
  await regular.getByRole("button", { name: "右转 90°", exact: true }).click();
  await regular.getByRole("button", { name: "保存到素材库", exact: true }).click();
  await regular.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => JSON.parse(window.calls.find(call => call.command === "save_annotated_image").args.annotationJson).source_asset_id), latest[0].assetId);
  await expectNoDraft('[data-canvas-node-id="old"]');
  await page.locator('[data-canvas-node-id="gen-prompt:job:turn:0"]').waitFor();
  await expectNoDraft('[data-canvas-node-id="gen-prompt:job:turn:0"]');

  await page.evaluate(() => sessionStorage.clear());
  await load("?provisional");
  await openDraft(); await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => window.calls.some(call => call.command === "project_canvas_materialize")), false);
  await openDraft(); await draw();
  await page.evaluate(() => { window.failDraftSave = true; });
  await dialog.getByRole("button", { name: "保存到画板", exact: true }).click();
  await page.getByText("模拟草稿保存失败", { exact: false }).first().waitFor();
  await page.evaluate(() => { window.failDraftSave = false; });
  await dialog.getByRole("button", { name: "保存到画板", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const calls = await page.evaluate(() => window.calls.map(call => call.command));
  assert.ok(calls.indexOf("project_canvas_materialize") < calls.indexOf("draft_workspace_save"));
  assert.ok(calls.indexOf("draft_workspace_save") < calls.indexOf("draft_workspace_canvas_upsert"));
  assert.equal(await page.evaluate(() => window.snapshot().nodes.filter(node => node.assetId?.startsWith("draft-")).length), 1);
  const savedNode = await page.evaluate(() => window.snapshot().nodes.find(node => node.assetId?.startsWith("draft-")));
  await page.evaluate(() => window.save()); await page.reload();
  await page.waitForFunction(() => document.querySelector('.canvas-workspace[aria-busy="false"]'));
  await reopen(savedNode.id);
  assert.equal(await page.evaluate(id => window.calls.some(call => call.command === "draft_workspace_load" && call.args.assetId === id), savedNode.assetId), true);
  await draw();
  await dialog.getByRole("button", { name: "保存到画板", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const reloaded = await page.evaluate(() => window.snapshot().nodes.filter(node => node.assetId?.startsWith("draft-")));
  assert.equal(reloaded.length, 1);
  assert.deepEqual(geometry(reloaded[0]), geometry(savedNode), "save after reload updates the persisted card");

  await reopen(savedNode.id); await draw();
  await page.evaluate(nodeId => window.__TAURI_INTERNALS__.invoke("project_canvas_node_remove", { nodeId }), savedNode.id);
  await dialog.getByRole("button", { name: "保存到画板", exact: true }).click();
  await page.getByText("草稿原卡片已不可用", { exact: false }).first().waitFor();
  assert.equal(await page.evaluate(() => window.snapshot().nodes.filter(node => node.assetId?.startsWith("draft-") && node.hiddenAt == null).length), 0, "a removed source card is not recreated");

  await page.evaluate(() => sessionStorage.clear());
  await load("?explorer");
  await openDraft(); await draw();
  await page.evaluate(() => window.store.setState({ activeProjectId: "q" }));
  await page.waitForFunction(() => document.querySelector('.canvas-workspace[aria-busy="false"]'));
  await dialog.getByRole("button", { name: "保存到画板", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const frozenSave = (await saves())[0];
  assert.equal(frozenSave.args.projectId, "p", "route changes do not move the draft to another project");
  const frozenNode = await page.evaluate(() => window.calls.filter(call => call.command === "draft_workspace_canvas_upsert").at(-1).args.newNode);
  assert.equal(frozenNode.projectId, "p");
  assert.equal(await page.locator(`[data-canvas-node-id="${frozenNode.id}"]`).count(), 0, "the saved node does not appear in the newly selected project");
  assert.deepEqual(errors, []);
  console.log("PASS canvas draft: immediate white canvas, layered PNG, persistent same-card updates, layout/edges preserved, library reopening, old annotation compatibility, retries, reload, deleted source protection and frozen project");
} finally { await browser.close(); await server.close(); }
