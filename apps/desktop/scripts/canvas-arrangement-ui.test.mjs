import assert from "node:assert/strict";
import { createServer } from "vite";
const { chromium } = await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE || "playwright");
const server = await createServer({ server: { host: "127.0.0.1", port: 1448, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1600 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const node = id => page.locator(`[data-canvas-node-id="${id}"]`);
async function arrange(id) {
  await node(id).click({ button: "right", position: { x: 35, y: 35 } });
  await page.getByRole("menuitem", { name: "整理", exact: true }).click();
}
try {
  await page.goto("http://127.0.0.1:1448/scripts/fixtures/canvas-reference/preview.html");
  await node("old").waitFor();
  await page.evaluate(() => {
    const snapshot = window.snapshot();
    const base = snapshot.nodes[0];
    const card = (id, kind, x, y, payload = {}) => ({ ...base, id, kind, x, y,
      assetId: kind === "asset" ? "a" : null, role: kind === "asset" ? "output" : null,
      payloadJson: JSON.stringify({ schema_version: 1, text: "整理回归", status: "succeeded",
        ...(kind === "asset" ? { snapshot: { name: id, width: 190, height: 150 } } : {}), ...payload }) });
    snapshot.nodes = [
      { ...base, x: 80, y: 100 }, card("prompt", "prompt", 320, 100),
      card("output", "asset", 560, 100), card("agent-prompt", "prompt", 800, 100),
      card("agent", "agent_group", 800, 100, { run_id: "test-run" }),
      card("agent-output", "asset", 560, 100), card("obstacle", "asset", 80, 350),
    ];
    snapshot.edges = [["old", "prompt"], ["prompt", "output"], ["old", "agent-prompt"],
      ["agent-prompt", "agent"], ["agent", "agent-output"]].map(([fromNodeId, toNodeId], i) => ({
      id: `e${i}`, projectId: "p", threadId: "t", fromNodeId, toNodeId, kind: "input", ordinal: i, createdAt: 1,
    }));
    snapshot.view = { ...snapshot.view, panX: 0, panY: 0, zoom: 1 };
    sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
  });
  await page.reload();
  await node("prompt").waitFor();
  const before = await page.evaluate(() => window.snapshot());
  await arrange("old");
  const selected = await page.locator("[data-canvas-node-id].is-selected").evaluateAll(elements => elements.map(e => e.dataset.canvasNodeId).sort());
  assert.deepEqual(selected, ["old", "prompt", "output", "agent", "agent-output"].sort());
  await page.waitForFunction(() => window.calls.filter(c => c.command === "project_canvas_node_update").length >= 5);
  const after = await page.evaluate(() => window.snapshot());
  assert.deepEqual(after.nodes.find(n => n.id === "obstacle"), before.nodes.find(n => n.id === "obstacle"));
  assert.deepEqual(after.nodes.find(n => n.id === "agent-prompt"), before.nodes.find(n => n.id === "agent-prompt"));
  const rects = await page.locator("[data-canvas-node-id]").evaluateAll(elements => elements.map(e => {
    const r = e.getBoundingClientRect(); return { id: e.dataset.canvasNodeId, x: r.x, y: r.y, right: r.right, bottom: r.bottom };
  }));
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const a = rects[i], b = rects[j];
    assert.ok(a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y, `${a.id} overlaps ${b.id}`);
  }
  await arrange("prompt");
  await page.waitForFunction(() => window.calls.filter(c => c.command === "project_canvas_node_update").length >= 10);
  assert.deepEqual((await page.evaluate(() => window.snapshot())).nodes, after.nodes);
  await page.evaluate(() => window.save());
  await page.reload();
  await node("old").waitFor();
  assert.deepEqual((await page.evaluate(() => window.snapshot())).nodes, after.nodes);
  // With no multi-selection, arranging a result cannot pull in its upstream nodes.
  await arrange("agent-output");
  assert.deepEqual(await page.locator("[data-canvas-node-id].is-selected").evaluateAll(elements => elements.map(e => e.dataset.canvasNodeId)), ["agent-output"]);
  await page.evaluate(() => {
    const snapshot = window.snapshot();
    const old = snapshot.nodes.find(n => n.id === "old");
    snapshot.groups = [{ id: "folder", projectId: "p", name: "素材组", role: null,
      x: old.x, y: old.y, width: 204, height: 178, zIndex: 1, createdAt: 1, updatedAt: 1 }];
    snapshot.groupItems = [{ projectId: "p", groupId: "folder", nodeId: "old", ordinal: 0 }];
    sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
  });
  await page.reload();
  await node("folder").waitFor();
  // The folder label uses the general node menu, not a member image's asset menu.
  await node("folder").locator(".canvas-folder-name").click({ button: "right" });
  await page.getByRole("menu", { name: "画板节点菜单" }).getByRole("menuitem", { name: "整理", exact: true }).click();
  assert.deepEqual(await page.locator("[data-canvas-node-id].is-selected").evaluateAll(elements => elements.map(e => e.dataset.canvasNodeId).sort()),
    ["folder", "prompt", "output", "agent", "agent-output"].sort());
  await page.waitForFunction(() => window.calls.some(c => c.command === "project_canvas_group_update")
    && window.calls.filter(c => c.command === "project_canvas_node_update").length >= 4);
  const grouped = await page.evaluate(() => window.snapshot());
  await page.evaluate(() => window.save());
  await page.reload();
  await node("folder").waitFor();
  assert.deepEqual(await page.evaluate(() => window.snapshot()), grouped);
  assert.deepEqual(errors, []);
  console.log("PASS real asset/prompt/folder menus, downstream branches, Agent/group aliases, collision-free DOM, selection, repeat and reload persistence");
} finally {
  await browser.close();
  await server.close();
}
