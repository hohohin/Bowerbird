import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1573, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const node = id => page.locator(`[data-canvas-node-id="${id}"]`);
const snapshot = () => page.evaluate(() => window.snapshot());
async function reset() {
  await page.evaluate(() => {
    const snapshot = window.snapshot();
    const base = snapshot.nodes[0];
    snapshot.nodes = ["a", "b", "c"].map((id, index) => ({ ...base, id, assetId: id,
      x: 100 + index * 300, y: 180, width: 190, height: 182,
      payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: id, width: 190, height: 150 } }) }));
    snapshot.groups = []; snapshot.groupItems = []; snapshot.edges = [];
    snapshot.view = { ...snapshot.view, panX: 0, panY: 0, zoom: 0.9 };
    sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
  });
  await page.reload();
  await node("a").waitFor();
}
async function center(id) {
  const box = await node(id).boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
async function move(point) { await page.mouse.move(point.x, point.y); }
async function dragToTarget() {
  await move(await center("a"));
  await page.mouse.down();
  const target = await center("b");
  await move(target);
  await page.getByRole("tooltip", { name: "悬停以创建素材组", exact: true }).waitFor();
  return target;
}
async function ready() {
  await page.getByRole("tooltip", { name: "松开创建素材组", exact: true }).waitFor();
  assert.equal((await snapshot()).groups.length, 0, "hover alone must not persist a group");
  assert.equal(await page.locator(".canvas-node.is-folder").count(), 0, "hover alone must not create a visual group");
}
async function noGroup() {
  await page.waitForTimeout(1100);
  assert.equal((await snapshot()).groups.length, 0);
  assert.equal(await page.locator(".canvas-node.is-folder").count(), 0);
  assert.equal(await page.getByRole("tooltip").count(), 0);
}
async function external(type, point) {
  await page.evaluate(async ({ type, point }) => {
    const { setDragAssets } = await import("/src/lib/dragPayload.ts");
    setDragAssets(["existing"]);
    document.querySelector(".canvas-stage").dispatchEvent(new DragEvent(type, {
      bubbles: true, cancelable: true, clientX: point.x, clientY: point.y, dataTransfer: new DataTransfer(),
    }));
  }, { type, point });
}
try {
  await page.goto("http://127.0.0.1:1573/scripts/fixtures/canvas-reference/preview.html");
  await node("old").waitFor();

  await reset();
  await dragToTarget();
  await page.mouse.up();
  await noGroup();

  await reset();
  await dragToTarget();
  await ready();
  await page.mouse.up();
  await page.waitForFunction(() => window.snapshot().groups.length === 1);
  assert.deepEqual((await snapshot()).groupItems.map(item => item.nodeId).sort(), ["a", "b"]);
  // Dropping into an existing group still works immediately.
  const folder = await page.locator(".canvas-node.is-folder").boundingBox();
  await move(await center("c")); await page.mouse.down();
  await move({ x: folder.x + folder.width / 2, y: folder.y + folder.height / 2 });
  await page.mouse.up();
  await page.waitForFunction(() => window.snapshot().groupItems.length === 3);
  assert.equal((await snapshot()).groups.length, 1);
  await page.evaluate(() => window.save());
  await page.reload();
  await page.locator(".canvas-node.is-folder").waitFor();
  assert.equal(await page.locator(".canvas-node.is-asset").count(), 0);
  for (const surface of [".canvas-folder-name", ".canvas-folder-grid img"]) {
    const group = page.locator(".canvas-node.is-folder");
    await group.hover();
    assert.equal(await group.getByRole("button", { name: "解散素材组" }).count(), 0);
    await group.locator(surface).first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "解散素材组", exact: true }).click();
    await page.waitForFunction(() => window.snapshot().groups.length === 0);
    assert.equal(await page.getByRole("menu").count(), 0);
    assert.equal(await page.locator(".canvas-node.is-folder").count(), 0);
    assert.equal(await page.locator(".canvas-node.is-asset").count(), 3);
    const ungrouped = await snapshot();
    assert.equal(ungrouped.groupItems.length, 0);
    assert.ok(ungrouped.nodes.every(node => node.hiddenAt == null && node.assetId));
    if (surface.includes("img")) await page.evaluate(() => window.save());
    await page.reload();
    await page.waitForFunction(() => document.querySelector(".canvas-node"));
  }
  assert.equal(await page.locator(".canvas-node.is-asset").count(), 3);
  await node("a").click({ button: "right" });
  assert.equal(await page.getByRole("menuitem", { name: "解散素材组", exact: true }).count(), 0);
  await page.keyboard.press("Escape");

  await reset();
  const target = await dragToTarget();
  await ready();
  await move({ x: target.x, y: target.y + 250 });
  await page.mouse.up();
  await noGroup();

  await reset();
  const reentry = await dragToTarget();
  await ready();
  await move({ x: reentry.x, y: reentry.y + 250 });
  await move(reentry);
  await page.mouse.up();
  await noGroup();

  await reset();
  await dragToTarget();
  await ready();
  await move(await center("c"));
  await page.mouse.up();
  await noGroup();

  for (const cancel of ["Escape", "pointercancel", "lostpointercapture"]) {
    await reset();
    const before = await node("a").boundingBox();
    await dragToTarget();
    await ready();
    if (cancel === "Escape") await page.keyboard.press("Escape");
    else await node("a").dispatchEvent(cancel, { pointerId: 1, bubbles: true });
    await page.mouse.up();
    await noGroup();
    assert.deepEqual(await node("a").boundingBox(), before);
  }

  // Release coordinates are rechecked even without a final move event.
  await reset();
  const release = await dragToTarget();
  await ready();
  await node("a").dispatchEvent("pointerup", { pointerId: 1, clientX: release.x, clientY: release.y + 250, bubbles: true });
  await page.mouse.up();
  await noGroup();

  for (const outcome of ["early", "outside", "inside"]) {
    await reset();
    const point = await center("b");
    await external("dragover", point);
    if (outcome !== "early") await ready();
    await external("drop", outcome === "outside" ? { x: point.x, y: point.y + 250 } : point);
    if (outcome === "inside") {
      await page.waitForFunction(() => window.snapshot().groups.length === 1);
      assert.equal((await snapshot()).groupItems.length, 2);
    } else await noGroup();
  }
  assert.deepEqual(errors, []);
  console.log("PASS hover + release grouping and context-menu ungrouping from title/preview, preserved assets/reload, no corner icon; early/outside/reentry/target-change/cancellation, existing groups and library drops.");
} finally {
  await browser.close();
  await server.close();
}
