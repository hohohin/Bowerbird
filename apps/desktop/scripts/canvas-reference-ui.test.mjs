import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE || "../../html-renderer/node_modules/playwright/index.mjs");
const server = await createServer({ server: { host: "127.0.0.1", port: 1446, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const evidence = [];
await mkdir(".tmp/reference-placement", { recursive: true });
try {
  for (const [agent, withReferences] of [[false, true], [true, true], [false, false]]) {
    await page.goto("http://127.0.0.1:1446/scripts/fixtures/canvas-reference/preview.html");
    await page.waitForFunction(() => window.launch && document.querySelector('[data-canvas-node-id="old"]'));
    const initial = await page.evaluate(() => window.snapshot());
    if (agent) await page.getByRole('button', { name: '时间线视图', exact: true }).click();
    await page.evaluate(([agent, withReferences]) => window.launch(agent, withReferences), [agent, withReferences]);
    if (withReferences) await page.waitForFunction(() => window.calls.filter(c => c.command === "project_canvas_node_update" && c.args.nodeId.includes("reference:")).length >= 4);
    if (agent) {
      await page.evaluate(() => window.addAgentGroup());
      await page.waitForFunction(() => window.calls.filter(c => c.command === "project_canvas_node_update" && c.args.nodeId.includes("reference:")).length >= 8);
    }
    await page.waitForFunction(agent => {
      const id = agent ? 'agent-group:run:0:0' : 'gen-prompt:job:turn:0';
      return window.snapshot().view.activeNodeId === id && document.activeElement?.getAttribute('data-canvas-node-id') === id;
    }, agent);
    const snapshot = await page.evaluate(() => window.snapshot());
    const card = snapshot.nodes.find(n => agent ? n.kind === "agent_group" : n.kind === "prompt");
    const refs = snapshot.nodes.filter(n => n.id.includes("reference:"));
    assert.equal(refs.length, withReferences ? 4 : 0);
    assert.ok(card.x < 10000, "the real component brings the new card into view");
    if (withReferences) assert.equal(refs[0].x, card.x);
    assert.ok(refs.every(n => n.x >= card.x && n.x <= card.x + 500 && n.y > card.y && n.y < card.y + 1200));
    for (const old of initial.nodes) assert.deepEqual(snapshot.nodes.find(n => n.id === old.id), old);
    assert.equal(snapshot.view.zoom, 0.9);
    assert.equal(snapshot.view.focusedThreadId, 't');
    assert.equal(snapshot.view.viewMode, 'canvas');
    // New cards anchor at the visible top-left (viewport x:24 y:72) instead of
    // following the reference-derived provisional position or re-centering the
    // view. In the agent flow the launch prompt is absorbed by its Run card, so
    // the focused card is the one that carries the anchor.
    const anchored = await page.evaluate(id => {
      const stage = document.querySelector('[data-canvas-stage]').getBoundingClientRect();
      const card = document.querySelector(`[data-canvas-node-id="${id}"]`).getBoundingClientRect();
      return [card.x - stage.x, card.y - stage.y];
    }, card.id);
    assert.ok(Math.abs(anchored[0] - 24) < 2 && Math.abs(anchored[1] - 72) < 2, `focused new card anchors at the visible top-left: ${anchored}`);
    if (agent) {
      const stageBox = await page.evaluate(() => document.querySelector('[data-canvas-stage]').getBoundingClientRect());
      const refsBox = await page.locator('[data-canvas-node-id="agent-reference:launch:0:0"]').boundingBox();
      assert.ok(refsBox && refsBox.y > anchored[1] && refsBox.x >= stageBox.x, "agent references follow below the anchored card");
    }
    evidence.push({ agent, withReferences, card, references: refs, view: snapshot.view });
    await page.screenshot({ path: `.tmp/reference-placement/${agent ? "agent" : withReferences ? "ordinary" : "no-references"}.png` });
    const writes = await page.evaluate(() => window.calls.filter(c => c.command === "project_canvas_node_update").length);
    await page.evaluate(() => window.emitChange());
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => window.calls.filter(c => c.command === "project_canvas_node_update").length), writes);
    assert.deepEqual((await page.evaluate(() => window.snapshot())).view, snapshot.view);
    await page.evaluate(() => window.save());
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-canvas-node-id="old"]'));
    assert.deepEqual((await page.evaluate(() => window.snapshot())).nodes, snapshot.nodes);
    assert.deepEqual((await page.evaluate(() => window.snapshot())).view, snapshot.view);
    assert.equal(await page.evaluate(() => window.calls.filter(c => c.command === "project_canvas_node_update").length), 0);
    await page.evaluate(() => sessionStorage.clear());
  }
  assert.deepEqual(errors, []);
  await writeFile(".tmp/reference-placement/coordinates.json", JSON.stringify(evidence, null, 2));
  console.log("PASS real CanvasWorkspace: ordinary + staged Agent card focus, visible top-left anchor, timeline return, unchanged old nodes, repeat and reload, persisted coordinates");
} finally {
  await browser.close();
  await server.close();
}
