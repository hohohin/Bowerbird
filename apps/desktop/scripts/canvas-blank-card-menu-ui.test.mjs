import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ cacheDir: ".tmp/canvas-blank-card-menu-vite", server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const stage = page.locator("[data-canvas-stage]");
const menu = page.getByRole("menu", { name: "新建卡片", exact: true });
const workflow = () => page.evaluate(() => JSON.parse(sessionStorage.getItem("workflow-p") || '{"document":{"nodes":[]}}').document);

try {
  await page.goto(server.resolvedUrls.local[0] + "scripts/fixtures/canvas-reference/preview.html");
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(() => {
    const snapshot = window.snapshot(), base = snapshot.nodes[0];
    snapshot.nodes.push({ ...base, id: "section", kind: "note", role: null, assetId: null, x: 650, y: 600, width: 240, height: 160,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: "section", text: "分区", member_ids: [] }) });
    snapshot.edges.push({ id: "visible-wire", projectId: "p", threadId: "t", fromNodeId: "old", toNodeId: "section", kind: "input", ordinal: 0, createdAt: 2 });
    sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
  });
  await page.reload();
  const section = page.locator('[data-canvas-node-id="section"]');
  await section.waitFor();
  const rect = await stage.boundingBox();
  const x = rect.x + rect.width - 90, y = rect.y + rect.height - 100;
  await page.mouse.click(x, y);
  assert.equal(await menu.count(), 0);
  await page.mouse.dblclick(x, y);
  await menu.waitFor();
  assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), ["图片生成", "视频生成", "图片反推", "复用提示词", "分层拆分", "Agent", "视觉规范", "角色声音"]);
  const bounds = await menu.boundingBox();
  assert.ok(bounds.x + bounds.width <= 1500 && bounds.y + bounds.height <= 1000);
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  assert.equal((await workflow()).nodes.length, 0);

  for (const target of [section, page.locator(".canvas-graph-edges path")]) {
    const point = await target.evaluate(element => {
      if (element instanceof SVGPathElement) {
        const p = element.getPointAtLength(element.getTotalLength() / 2).matrixTransform(element.getScreenCTM());
        return { x: p.x, y: p.y };
      }
      const r = element.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.dblclick(point.x, point.y);
    assert.equal(await menu.count(), 0);
  }
  await page.getByRole("button", { name: "选择工具", exact: true }).dblclick();
  assert.equal(await menu.count(), 0);
  await page.keyboard.down("Space");
  await page.mouse.dblclick(x, y);
  await page.keyboard.up("Space");
  assert.equal(await menu.count(), 0);
  await page.mouse.move(x - 70, y - 50); await page.mouse.down();
  await page.mouse.move(x, y, { steps: 8 }); await page.mouse.up();
  assert.equal(await menu.count(), 0);

  const expected = await stage.evaluate((stage, { x, y }) => {
    const bounds = stage.getBoundingClientRect(), transform = new DOMMatrix(getComputedStyle(stage.querySelector(".canvas-plane")).transform);
    return new DOMPoint(x - bounds.left, y - bounds.top).matrixTransform(transform.inverse()).toJSON();
  }, { x, y });
  await page.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "canvas_workflow_save" && !window.finishCardWrite) {
        await new Promise(resolve => { window.finishCardWrite = resolve; });
      }
      return invoke(command, args);
    };
  });
  await page.mouse.dblclick(x, y);
  await menu.getByRole("menuitem", { name: "视频生成", exact: true }).click();
  await menu.waitFor({ state: "detached" });
  await page.locator("[data-workflow-card].is-selected").waitFor();
  await page.waitForFunction(() => !!window.finishCardWrite);
  await page.mouse.click(x - 20, rect.y + 85);
  assert.equal(await page.locator("[data-workflow-card].is-selected").count(), 0);
  await page.evaluate(() => window.finishCardWrite());
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("workflow-p"))?.document.nodes.length === 1);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator("[data-workflow-card].is-selected").count(), 0);
  const { nodes: [video], run } = await workflow();
  assert.equal(video.kind, "generation");
  assert.equal(video.generation.media, "video");
  assert.deepEqual(video.inputs, {});
  assert.equal(run, null);
  assert.ok(Math.abs(expected.x - video.x) <= 1 && Math.abs(expected.y - video.y) <= 1);
  const card = page.locator(`[data-workflow-card="${video.id}"]`);
  const box = await card.boundingBox();
  await page.mouse.dblclick(box.x + 25, box.y + 15);
  assert.equal(await menu.count(), 0);
  const second = { x: x - 20, y: rect.y + 85 };
  await page.mouse.dblclick(second.x, second.y);
  await menu.getByRole("menuitem", { name: "图片反推", exact: true }).dblclick();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("workflow-p"))?.document.nodes.length === 2);
  assert.deepEqual((await workflow()).nodes.map(({ kind, action }) => [kind, action]), [["generation", "describe"], ["instruction", "describe"]]);
  assert.equal(await menu.count(), 0);
  const draft = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  draft.on("pageerror", error => errors.push(error.message));
  await draft.goto(server.resolvedUrls.local[0] + "scripts/fixtures/canvas-reference/preview.html?provisional&strict-canvas");
  await draft.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await draft.mouse.dblclick(x, y);
  await draft.getByRole("menu", { name: "新建卡片" }).getByRole("menuitem", { name: "图片生成" }).click();
  await draft.waitForFunction(() => JSON.parse(sessionStorage.getItem("workflow-p"))?.document.nodes.length === 1);
  const writes = await draft.evaluate(() => window.calls.map(({ command }) => command));
  assert.ok(writes.includes("project_canvas_materialize") && writes.indexOf("project_canvas_materialize") < writes.indexOf("canvas_workflow_save"));
  await draft.close();
  assert.deepEqual(errors, []);
  console.log("PASS blank double-click opens the creation menu, uses the transformed canvas position, and respects existing gestures and wire, section, card and toolbar hits");
} finally {
  await browser.close();
  await server.close();
}
