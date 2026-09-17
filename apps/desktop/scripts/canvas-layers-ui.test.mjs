import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1573, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const node = id => page.locator(`[data-canvas-node-id="${id}"]`);
const z = id => node(id).evaluate(element => Number(getComputedStyle(element).zIndex));
const saved = () => page.evaluate(() => window.snapshot());
async function begin(id) {
  await page.keyboard.press("Escape");
  // Open from the exposed edge of overlapping cards.
  await node(id).click({ button: "right", position: { x: 8, y: 12 } });
  const item = page.getByRole("menuitem", { name: "调整层级", exact: true });
  const rect = await item.boundingBox();
  const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  return point;
}
try {
  await page.goto("http://127.0.0.1:1573/scripts/fixtures/canvas-reference/preview.html");
  await node("old").waitFor();
  await page.evaluate(() => {
    const snapshot = window.snapshot();
    const base = snapshot.nodes[0];
    base.height = (base.width - 2) * 150 / 190 + 32;
    snapshot.nodes = [
      { ...base, id: "a", assetId: "a", x: 100, y: 140, zIndex: 1 },
      { ...base, id: "b", assetId: "b", x: 150, y: 180, zIndex: 1 },
      { ...base, id: "note", kind: "note", assetId: null, role: null, x: 500, y: 150, zIndex: 7,
        payloadJson: JSON.stringify({ schema_version: 1, text: "文本卡片", note_type: "text" }) },
      { ...base, id: "prompt", kind: "prompt", assetId: null, role: null, x: 750, y: 150, zIndex: 12,
        payloadJson: JSON.stringify({ schema_version: 1, text: "生成卡片", status: "succeeded" }) },
      { ...base, id: "hidden", assetId: "d", hiddenAt: 20, zIndex: 3 },
      { ...base, id: "member", assetId: "c", zIndex: 8 },
    ];
    snapshot.groups = [{ id: "folder", projectId: "p", name: "素材组", role: "reference", x: 1000, y: 150, width: 240, height: 200, zIndex: 19, createdAt: 1, updatedAt: 1 }];
    snapshot.groupItems = [{ groupId: "folder", nodeId: "member", ordinal: 0 }];
    snapshot.view = { ...snapshot.view, panX: 0, panY: 0, zoom: 1 };
    sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
  });
  await page.reload();
  await node("a").waitFor();
  assert.equal(await page.locator(".canvas-node-name").count(), 0, "old settings default to hidden names");
  const initial = await saved();
  const hiddenBox = await node("a").boundingBox();
  const imageBox = await node("a").locator(":scope > img").boundingBox();
  assert.ok(Math.abs(hiddenBox.height - imageBox.height - 2) < 0.1, "no empty caption strip");

  await page.evaluate(() => window.openSettings());
  await page.getByRole("button", { name: "个性化与记忆", exact: true }).click();
  const toggle = page.getByRole("switch", { name: "显示画板素材名称", exact: true });
  assert.equal(await toggle.getAttribute("aria-checked"), "false");
  await toggle.click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("canvas-settings")).canvas_show_asset_names);
  await page.keyboard.press("Escape");
  await node("a").locator(".canvas-node-name").waitFor();
  const shownBox = await node("a").boundingBox();
  assert.ok(Math.abs(shownBox.height - hiddenBox.height - 30) < 0.1);
  assert.equal(shownBox.width, hiddenBox.width);
  assert.deepEqual((await saved()).nodes, initial.nodes, "name toggle does not rewrite geometry");
  await page.reload();
  await node("a").locator(".canvas-node-name").waitFor();
  await page.evaluate(() => window.openSettings());
  await page.getByRole("button", { name: "个性化与记忆", exact: true }).click();
  await toggle.click();
  await page.keyboard.press("Escape");

  const clockStart = new Date("2026-09-15T00:00:00Z");
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(clockStart);
  const p = await begin("a");
  await page.mouse.move(p.x, p.y - 8);
  await page.clock.runFor(800);
  assert.equal(await z("a"), 1, "inside dead zone never steps");
  await page.mouse.move(p.x, p.y - 35);
  await page.clock.runFor(399);
  assert.equal(await z("a"), 1, "no step before 400 ms");
  await page.clock.runFor(1);
  assert.equal(await z("a"), 2);
  assert.equal(await z("b"), 1, "equal-index neighbor is crossed");
  const overlap = await node("b").boundingBox();
  assert.equal(await page.evaluate(({ x, y }) => document.elementsFromPoint(x, y).find(e => e.matches("[data-canvas-node-id]"))?.dataset.canvasNodeId,
    { x: overlap.x + 20, y: overlap.y + 50 }), "a", "actual visual stacking changes while selected");
  await page.clock.runFor(400);
  assert.equal(await z("a"), 3, "holding repeats once per interval");
  await page.mouse.move(p.x, p.y);
  await page.clock.runFor(1000);
  assert.equal(await z("a"), 3, "returning to origin pauses");
  await page.mouse.move(p.x, p.y + 35);
  await page.clock.runFor(399);
  assert.equal(await z("a"), 3, "reverse direction starts a fresh interval");
  await page.clock.runFor(1);
  assert.equal(await z("a"), 2);
  await page.mouse.up();
  await page.clock.runFor(900);
  assert.equal(await z("a"), 2, "release stops outside the menu");

  const q = await begin("note");
  await page.mouse.move(q.x, q.y + 35);
  await page.clock.runFor(400);
  assert.equal(await z("note"), 2, "selected text respects its saved layer");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.clock.runFor(800);
  assert.equal(await z("note"), 2, "blur stops the gesture");
  await page.mouse.up();
  const r = await begin("prompt");
  await page.mouse.move(r.x, r.y + 35);
  await page.clock.runFor(200);
  await page.keyboard.press("Escape");
  await page.clock.runFor(800);
  await page.mouse.up();
  assert.equal(await z("prompt"), 4, "Escape cancels the pending step");
  const f = await begin("folder");
  await page.mouse.move(f.x, f.y + 35);
  await page.clock.runFor(400);
  await page.mouse.up();
  assert.equal(await z("folder"), 4, "groups share card ordering");
  await page.keyboard.press("Escape");
  await page.clock.runFor(100);
  const final = await saved();
  assert.equal(final.groups[0].zIndex, 4);
  assert.equal(final.nodes.find(n => n.id === "hidden").zIndex, 3, "hidden nodes remain untouched");
  for (const before of initial.nodes) {
    const after = final.nodes.find(n => n.id === before.id);
    for (const key of ["x", "y", "width", "height", "payloadJson", "threadId", "assetId"]) assert.equal(after[key], before[key]);
  }
  await page.evaluate(() => window.save());
  await page.reload();
  await node("a").waitFor();
  assert.equal(await z("a"), 3);
  assert.equal(await z("note"), 2);
  assert.equal(await z("folder"), 4);
  assert.equal(await page.locator(".canvas-node-name").count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS layer timing, direction, pointer capture, stopping, cross-card ordering and settings/reload.");
} finally { await browser.close(); await server.close(); }
