import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1575, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1200 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const section = page.locator('[data-canvas-node-id="section"]');
const knob = corner => section.locator(`.canvas-resize-handle[data-corner="${corner}"]`);
const geometry = node => [node.x, node.y, node.width, node.height];
const snapshot = () => page.evaluate(() => window.snapshot());
async function reset(zoom = 1) {
  await page.evaluate(zoom => {
    const snapshot = window.snapshot(), base = snapshot.nodes[0];
    snapshot.nodes = [
      { ...base, id: "inside", kind: "asset", assetId: "a", x: 400, y: 300, width: 100, height: 110 },
      { ...base, id: "outside", kind: "asset", assetId: "b", x: 190, y: 120, width: 80, height: 95 },
      { ...base, id: "section", kind: "note", assetId: null, role: null, x: 300, y: 200, width: 500, height: 300,
        payloadJson: JSON.stringify({ schema_version: 1, text: "分区", note_type: "section", cells: [], member_ids: ["inside"] }) },
    ];
    snapshot.groups = []; snapshot.groupItems = []; snapshot.edges = [];
    snapshot.view = { ...snapshot.view, panX: 0, panY: 100, zoom };
    sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
  }, zoom);
  await page.reload();
  await section.locator(".canvas-section-heading svg").click();
  assert.equal(await section.locator(".canvas-resize-handle").count(), 4);
}
async function resize(corner, dx, dy, cancel) {
  const box = await knob(corner).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 6 });
  if (cancel === "Escape") await page.keyboard.press("Escape");
  else if (cancel) await knob(corner).dispatchEvent(cancel, { pointerId: 1, bubbles: true });
  await page.mouse.up();
}
async function written() {
  await page.waitForFunction(() => window.calls.some(call => call.command === "project_canvas_note_update"));
}
try {
  await page.goto("http://127.0.0.1:1575/scripts/fixtures/canvas-reference/preview.html");
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  for (const zoom of [1, 0.5]) for (const corner of ["nw", "ne", "sw", "se"]) {
    await reset(zoom);
    const before = await snapshot();
    const left = corner.endsWith("w"), top = corner.startsWith("n");
    const frame = await section.boundingBox(), handle = await knob(corner).boundingBox();
    assert.ok(Math.abs(handle.x + handle.width / 2 - (left ? frame.x : frame.x + frame.width)) <= 3, JSON.stringify({ corner, zoom, frame, handle }));
    assert.ok(Math.abs(handle.y + handle.height / 2 - (top ? frame.y : frame.y + frame.height)) <= 3);
    await resize(corner, (left ? -150 : 150) * zoom, (top ? -130 : 130) * zoom);
    await written();
    const after = await snapshot(), current = after.nodes.find(node => node.id === "section");
    assert.deepEqual(geometry(current), [left ? 150 : 300, top ? 70 : 200, 650, 430]);
    assert.deepEqual(JSON.parse(current.payloadJson).member_ids.sort(), corner === "nw" ? ["inside", "outside"] : ["inside"]);
    assert.deepEqual(after.nodes.slice(0, 2), before.nodes.slice(0, 2), "resizing does not move or resize member cards");
    // Shrink past the opposite corner: clamp dimensions while retaining that corner.
    await page.evaluate(() => { window.calls = []; });
    await resize(corner, (left ? 700 : -700) * zoom, (top ? 500 : -500) * zoom);
    await written();
    const minimum = (await snapshot()).nodes.find(node => node.id === "section");
    assert.deepEqual([minimum.width, minimum.height], [120, 80]);
    assert.equal(left ? minimum.x + minimum.width : minimum.x, left ? current.x + current.width : current.x);
    assert.equal(top ? minimum.y + minimum.height : minimum.y, top ? current.y + current.height : current.y);
  }
  for (const cancel of ["Escape", "pointercancel", "lostpointercapture"]) {
    await reset(0.5);
    const before = await snapshot(), bounds = await section.boundingBox();
    await resize("nw", -75, -65, cancel);
    assert.deepEqual(await section.boundingBox(), bounds, "cancel restores both origin and dimensions");
    assert.deepEqual((await snapshot()).nodes, before.nodes, "cancel does not persist geometry or membership");
  }
  await reset(0.5);
  await resize("nw", -75, -65);
  await written();
  const persisted = (await snapshot()).nodes.find(node => node.id === "section");
  await page.evaluate(() => window.save()); await page.reload();
  await section.waitFor();
  assert.deepEqual((await snapshot()).nodes.find(node => node.id === "section"), persisted);
  assert.deepEqual(errors, []);
  console.log("PASS all four section corners: anchored geometry at 100%/50%, minimum size, membership, unchanged cards, cancellation and reload.");
} finally { await browser.close(); await server.close(); }
