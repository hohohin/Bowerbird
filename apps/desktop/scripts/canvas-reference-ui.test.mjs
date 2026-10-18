import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE || "../../html-renderer/node_modules/playwright/index.mjs");
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: '.tmp/card-placement-vite', server: { host: "127.0.0.1", port: 1446, strictPort: true, hmr: false, watch: null } });
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
    assert.deepEqual([card.x, card.y], [662, 300], "card uses the visible reference, not the far-away provisional coordinate");
    if (withReferences) assert.equal(refs[0].x, card.x);
    assert.ok(refs.every(n => n.x >= card.x && n.x <= card.x + 500 && n.y > card.y && n.y < card.y + 1200));
    for (const old of initial.nodes) assert.deepEqual(snapshot.nodes.find(n => n.id === old.id), old);
    assert.equal(snapshot.view.zoom, 0.9);
    assert.equal(snapshot.view.focusedThreadId, 't');
    assert.equal(snapshot.view.viewMode, 'canvas');
    const visible = await page.evaluate(id => {
      const stage = document.querySelector('[data-canvas-stage]').getBoundingClientRect();
      const card = document.querySelector(`[data-canvas-node-id="${id}"]`).getBoundingClientRect();
      const composer = document.querySelector('.canvas-composer-host').getBoundingClientRect();
      const bottom = Math.min(stage.height, composer.top - stage.top);
      return card.left >= stage.left + 24 && card.right <= stage.right - 24
        && card.top >= stage.top + 72 && card.bottom <= stage.top + bottom - 24;
    }, card.id);
    assert.ok(visible, 'new card remains visible');
    assert.deepEqual([snapshot.view.panX, snapshot.view.panY], [initial.view.panX, initial.view.panY], 'already visible cards do not move the camera');
    if (agent) {
      const refsBox = await page.locator('[data-canvas-node-id="agent-reference:launch:0:0"]').boundingBox();
      assert.ok(refsBox && refsBox.y > card.y, "agent references follow below the focused card");
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
  for (const grouped of [false, true]) {
    await page.reload();
    await page.locator('[data-canvas-node-id="old"]').waitFor();
    await page.evaluate(grouped => {
      const s = window.snapshot(), old = s.nodes.find(node => node.id === 'old');
      old.x = 19000; old.y = 5000;
      if (grouped) {
        s.groups = [{ id: 'source-group', projectId: 'p', name: '参考组', x: 400, y: 300,
          width: 240, height: 230, zIndex: 2, createdAt: 1, updatedAt: 1 }];
        s.groupItems = [{ groupId: 'source-group', nodeId: 'old', ordinal: 0 }];
      } else {
        old.role = 'output';
        old.payloadJson = JSON.stringify({ schema_version: 1, snapshot: { name: '结果', width: 190, height: 150 }, execution: { job_id: 'source-job', turn_key: 'source-turn' } });
        s.nodes.push({ ...old, id: 'source-conversation', kind: 'prompt', assetId: null, role: null,
          x: 400, y: 300, width: 260, height: 148, payloadJson: JSON.stringify({ schema_version: 1,
            job_id: 'source-job', turn_key: 'source-turn', provider: 'codex', status: 'done', text: '已有会话' }) });
      }
      // A large section frame is a container, not an occupied solid rectangle.
      s.nodes.push({ ...old, id: 'section', kind: 'note', assetId: null, role: null, x: 300, y: 200, width: 1500, height: 1500,
        payloadJson: JSON.stringify({ schema_version: 1, note_type: 'section', text: '创作区', cells: [], member_ids: [] }) });
      sessionStorage.setItem('reference-fixture', JSON.stringify(s));
    }, grouped);
    await page.reload();
    const sourceId = grouped ? 'source-group' : 'source-conversation';
    await page.locator(`[data-canvas-node-id="${sourceId}"]`).waitFor();
    await page.evaluate(() => window.launch(false, false));
    await page.waitForFunction(() => window.snapshot().nodes.find(n => n.id === 'gen-prompt:job:turn:0')?.x < 2000);
    const snapshot = await page.evaluate(() => window.snapshot());
    const card = snapshot.nodes.find(n => n.id === 'gen-prompt:job:turn:0');
    assert.deepEqual([card.x, card.y], [grouped ? 712 : 732, 300]);
    assert.deepEqual([snapshot.nodes.find(n => n.id === 'old').x, snapshot.nodes.find(n => n.id === 'old').y], [19000, 5000]);
    await page.evaluate(() => sessionStorage.clear());
  }
  // Two independent submissions can arrive in the same snapshot, with no canvas references.
  await page.reload();await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const base = window.snapshot().nodes[0];
    for (const id of ['batch-one', 'batch-two']) await api.projectCanvasNodeCreate({ ...base, id,
      kind: 'prompt', assetId: null, role: null, x: 24000, y: 88, width: 260, height: 148,
      payloadJson: JSON.stringify({ schema_version: 1, job_id: id, turn_key: 'one', provider: 'codex', status: 'running', text: id }) });
    window.emitChange();
  });
  await page.waitForFunction(() => ['batch-one', 'batch-two'].every(id => window.snapshot().nodes.find(n => n.id === id)?.x < 2000));
  const batch = await page.evaluate(() => window.snapshot().nodes.filter(n => n.id.startsWith('batch-')));
  assert.ok(batch[0].x + batch[0].width + 31 <= batch[1].x || batch[1].x + batch[1].width + 31 <= batch[0].x
    || batch[0].y + batch[0].height + 31 <= batch[1].y || batch[1].y + batch[1].height + 31 <= batch[0].y);
  const moveBox = await page.locator('[data-canvas-node-id="batch-two"]').boundingBox();
  await page.mouse.move(moveBox.x + 40, moveBox.y + 20);await page.mouse.down();
  await page.mouse.move(moveBox.x + 120, moveBox.y + 80, { steps: 5 });await page.mouse.up();
  await page.waitForFunction(before => window.snapshot().nodes.find(n => n.id === 'batch-two').x !== before, batch[1].x);
  const moved = await page.evaluate(() => window.snapshot().nodes.find(n => n.id === 'batch-two'));
  await page.evaluate(() => window.emitChange());await page.waitForTimeout(350);
  assert.deepEqual(await page.evaluate(() => window.snapshot().nodes.find(n => n.id === 'batch-two')), moved);
  await page.screenshot({ path: '.tmp/reference-placement/batch-local.png' });
  assert.deepEqual(errors, []);
  await writeFile(".tmp/reference-placement/coordinates.json", JSON.stringify(evidence, null, 2));
  console.log("PASS real CanvasWorkspace: local ordinary/Agent placement, stable camera, folded/grouped references, section frames, batched submissions, manual positions, repeat and reload");
} finally {
  await browser.close();
  await server.close();
}
