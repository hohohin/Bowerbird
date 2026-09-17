import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1574, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const group = page.locator('[data-canvas-node-id="group"]');
const member = id => group.locator(`[data-canvas-folder-asset-id="${id}"]`);
const snapshot = () => page.evaluate(() => window.snapshot());
try {
  await page.goto("http://127.0.0.1:1574/scripts/fixtures/canvas-reference/preview.html");
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(() => {
    const snapshot = window.snapshot(), base = snapshot.nodes[0];
    snapshot.nodes = ["a", "b", "c", "d", "existing", "a", "b"].map((assetId, index) => ({ ...base,
      id: `member-${index}`, assetId, x: 850, y: 120, width: 190, height: 182,
      payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: `素材 ${index}`, width: 190, height: 150 } }),
    }));
    snapshot.groups = [{ id: "group", projectId: "p", name: "素材组", role: null, x: 80, y: 100,
      width: 240, height: 230, zIndex: 2, createdAt: 1, updatedAt: 1 }];
    snapshot.groupItems = snapshot.nodes.slice(0, 6).map((node, ordinal) => ({ groupId: "group", nodeId: node.id, ordinal }));
    snapshot.edges = [];
    snapshot.view = { ...snapshot.view, panX: 0, panY: 0, zoom: 0.9 };
    sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
  });
  await page.reload();
  await group.waitFor();
  await page.evaluate(() => {
    window.picks = []; window.peeks = [];
    window.addEventListener("bowerbird://board-asset-picked", event => window.picks.push(event.detail));
    window.addEventListener("bowerbird://board-asset-peek", event => window.peeks.push({ assetId: event.detail.assetId, instance: event.detail.anchor?.dataset.canvasFolderAssetId }));
  });
  const before = await snapshot();
  const collapsed = await group.boundingBox();
  await group.click();
  await member("member-5").waitFor();
  assert.equal(await group.getAttribute("aria-expanded"), "true");
  assert.equal(await group.locator(".canvas-folder-asset").count(), 6);
  assert.equal(await page.getByRole("dialog").count(), 0, "folder opens inline, not in a preview dialog");
  assert.deepEqual(await page.evaluate(() => window.picks), []);
  const expanded = await group.boundingBox();
  const last = await member("member-5").boundingBox();
  assert.ok(expanded.width > collapsed.width && last.y + last.height <= expanded.y + expanded.height);
  assert.deepEqual((await snapshot()).groups, before.groups, "expansion does not persist display dimensions");
  assert.deepEqual((await snapshot()).groupItems, before.groupItems);
  await member("member-5").click();
  await page.getByRole("dialog", { name: "媒体预览，1 / 1" }).waitFor();
  await page.keyboard.press("Escape");
  await group.getByRole("button", { name: "收起素材组" }).click();
  assert.equal(await group.getAttribute("aria-expanded"), "false");
  assert.deepEqual(await group.boundingBox(), collapsed);

  await page.evaluate(() => window.store.setState({ boardOpen: true }));
  await group.focus(); await page.keyboard.press("Enter");
  await member("member-5").waitFor();
  assert.deepEqual(await page.evaluate(() => window.picks), [], "creation mode folder click must not add every image");
  await member("member-1").click();
  assert.deepEqual(await page.evaluate(() => window.picks.map(item => item.assetId)), ["b"]);
  await page.evaluate(() => window.store.setState({ promptedAssets: [{ ...window.store.getState().assets.find(asset => asset.id === "a"), sections: [{ title: "色彩", body: "蓝色" }] }] }));
  await member("member-5").click();
  assert.deepEqual(await page.evaluate(() => window.picks.map(item => item.assetId)), ["b"]);
  assert.deepEqual(await page.evaluate(() => window.peeks), [{ assetId: "a", instance: "member-5" }]);

  // The expanded rectangle also participates in dropping, beyond the folded bounds.
  const incoming = await page.locator('[data-canvas-node-id="member-6"]').boundingBox();
  const drop = await group.boundingBox();
  await page.mouse.move(incoming.x + 50, incoming.y + 50); await page.mouse.down();
  await page.mouse.move(drop.x + drop.width - 20, drop.y + drop.height - 20);
  await page.mouse.up();
  await page.waitForFunction(() => window.snapshot().groupItems.length === 7);
  assert.equal(await group.locator(".canvas-folder-asset").count(), 7);
  const header = await group.locator(".canvas-folder-header strong").boundingBox();
  await page.mouse.move(header.x + 20, header.y + 8); await page.mouse.down();
  await page.mouse.move(header.x + 60, header.y + 48); await page.mouse.up();
  await page.waitForFunction(() => window.snapshot().groups[0].x !== 80);
  assert.equal(await group.getAttribute("aria-expanded"), "true");
  assert.equal((await snapshot()).groups[0].width, before.groups[0].width);
  assert.equal((await snapshot()).groups[0].height, before.groups[0].height);
  await page.evaluate(() => window.store.setState({ settings: { ...window.store.getState().settings, canvas_show_asset_names: true } }));
  assert.equal(await group.locator(".canvas-folder-asset-name").count(), 7);
  await mkdir(".tmp/canvas-group-expand", { recursive: true });
  await page.screenshot({ path: ".tmp/canvas-group-expand/expanded.png" });

  await page.evaluate(() => { window.picks = []; });
  await group.locator(".canvas-folder-header strong").click({ button: "right" });
  await page.getByRole("menuitem", { name: /添加所选 .* 张图片到对话框/ }).click();
  assert.deepEqual(await page.evaluate(() => window.picks.map(item => item.assetId).sort()), ["a", "b", "c", "d", "existing"]);

  await member("member-5").click({ button: "right" });
  await page.getByRole("menuitem", { name: "解散素材组", exact: true }).click();
  await page.waitForFunction(() => window.snapshot().groups.length === 0);
  assert.equal(await page.locator(".canvas-node.is-asset").count(), 7);
  assert.equal((await snapshot()).groupItems.length, 0);
  assert.deepEqual(errors, []);
  console.log("PASS inline folder expansion: all members, browse/creation/keyboard behavior, individual preview/pick/dimensions, collapse, drag/drop geometry and ungroup.");
} finally {
  await browser.close(); await server.close();
}
