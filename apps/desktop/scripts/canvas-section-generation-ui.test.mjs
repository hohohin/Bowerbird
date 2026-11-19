import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const entry = 'scripts/fixtures/canvas-reference/preview.html';
const server = await createServer({ cacheDir: '.tmp/section-generation-vite', optimizeDeps: { entries: [entry] },
  server: { host: '127.0.0.1', port: 17992, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.setDefaultNavigationTimeout(90000);
  await page.goto(server.resolvedUrls.local[0] + entry, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(() => {
    const graph = window.snapshot(), base = graph.nodes[0];
    const prompt = (id, x, group = id) => ({ ...base, id, kind: 'prompt', role: null, assetId: null, x, y: 140, width: 180, height: 148,
      payloadJson: JSON.stringify({ job_id: id, turn_key: id, provider: 'codex', status: 'done', workflow_generation_group: group }) });
    const output = (assetId, id) => ({ ...base, id: 'out-' + id, assetId, kind: 'asset', role: 'output',
      payloadJson: JSON.stringify({ snapshot: { name: assetId, width: 190, height: 150 }, execution: { job_id: id, turn_key: id } }) });
    const section = (id, x, width, members) => ({ ...base, id, kind: 'note', role: null, assetId: null, x, y: 90, width, height: 600,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: 'section', member_ids: members }) });
    graph.nodes = [section('frame', 60, 740, ['out-first']), section('other-frame', 980, 420, ['owned']),
      prompt('first', 110, 'group'), prompt('second', 420, 'group'), prompt('single', 440),
      prompt('outside', 900), prompt('owned', 340), output('a','first'), output('b','second'),
      output('c','single'), output('d','outside'), output('existing','owned')];
    graph.view = { ...graph.view, zoom: .8, panX: 80, panY: 70 };
    graph.edges = [];
    sessionStorage.setItem('reference-fixture', JSON.stringify(graph));
  });
  await page.reload();
  const card = id => page.locator('[data-canvas-node-id="' + id + '"]');
  await card('single').waitFor();
  const point = async id => { const { x, y } = await card(id).boundingBox(); return [x, y]; };
  const ids = ['frame', 'first', 'single', 'outside', 'owned'];
  const before = await Promise.all(ids.map(point));
  const heading = await card('frame').locator('.canvas-section-heading svg').boundingBox();
  await page.mouse.move(heading.x + heading.width / 2, heading.y + heading.height / 2);
  await page.mouse.down();
  await page.mouse.move(heading.x + heading.width / 2 + 54, heading.y + heading.height / 2 + 41, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(() => window.snapshot().nodes.find(n => n.id === 'frame').x !== 60);
  const moved = await Promise.all(ids.map(point)), delta = moved[0].map((v, i) => v - before[0][i]);
  assert.ok(Math.abs(delta[0]) > 10);
  for (const index of [1, 2]) for (const axis of [0, 1])
    assert.ok(Math.abs(moved[index][axis] - before[index][axis] - delta[axis]) < 1, ids[index] + ' follows section');
  assert.deepEqual(moved.slice(3), before.slice(3));
  await page.waitForFunction(() => window.snapshot().nodes.find(n => n.id === 'single').x !== 440);
  const saved = await page.evaluate(() => JSON.stringify(window.snapshot()));
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => window.snapshot().nodes.find(n => n.id === 'single').x === 440);
  assert.deepEqual(await Promise.all(ids.map(point)), before);
  // Reopen the same persisted move in a fresh renderer.
  await page.evaluate(saved => sessionStorage.setItem('reference-fixture', saved), saved);
  await page.reload();
  await card('single').waitFor();
  assert.deepEqual(await Promise.all(ids.map(point)), moved);
  console.log('PASS generated single and grouped images follow their section, with explicit owner, outside, undo and reload checks');
} finally { await browser.close(); await server.close(); }
