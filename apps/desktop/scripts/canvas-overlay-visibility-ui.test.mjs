import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/canvas-overlay-visibility-vite',
  optimizeDeps: { entries: ['scripts/fixtures/canvas-reference/preview.html'] },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
try {
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/canvas-reference/preview.html`);
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(() => {
    const snapshot = window.snapshot(), base = snapshot.nodes[0];
    const prompt = (id, x, y, threadId = 't') => ({ ...base, id, kind: 'prompt', assetId: null, role: null,
      x, y, threadId, width: 260, height: 148,
      payloadJson: JSON.stringify({ schema_version: 1, text: id, provider: 'codex', status: 'done' }) });
    snapshot.nodes = [{ ...base, x: 100, y: 400 }, prompt('ordinary', 100, 100),
      prompt('agent-launch', 450, 100), prompt('archived', 450, 400, 'archived-thread'),
      { ...prompt('agent-group', 800, 100), kind: 'agent_group', width: 286, height: 184,
        payloadJson: JSON.stringify({ schema_version: 1, run_id: 'saved-run', status: 'failed' }) }];
    snapshot.edges = [{ id: 'agent-input', projectId: 'p', threadId: 't', fromNodeId: 'agent-launch',
      toNodeId: 'agent-group', kind: 'input', ordinal: 0, createdAt: 1 }];
    snapshot.threads.push({ id: 'archived-thread', projectId: 'p', title: '已归档', archivedAt: 2 });
    snapshot.view = { ...snapshot.view, panX: 50, panY: 60, zoom: 1 };
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
  });
  await page.reload();
  await page.locator('[data-canvas-node-id="agent-group"]').waitFor();
  await page.locator('[data-card-name="ordinary"] input:not(:disabled)').waitFor();
  for (const id of ['agent-launch', 'archived']) {
    assert.equal(await page.locator(`[data-canvas-node-id="${id}"]`).count(), 0, `${id}: card body is hidden`);
    assert.equal(await page.locator(`[data-card-name="${id}"]`).count(), 0, `${id}: hidden cards must not leave standalone names`);
    assert.equal(await page.locator(`[data-workflow-material="${id}"]`).count(), 0, `${id}: hidden cards must not leave hover hotspots`);
  }
  for (const id of ['ordinary', 'old']) {
    await page.locator(`[data-canvas-node-id="${id}"]`).waitFor();
    assert.equal(await page.locator(`[data-card-name="${id}"]`).count(), 1);
    const hotspot = page.locator(`[data-workflow-material="${id}"]`);
    assert.equal(await hotspot.count(), 1);
    await page.locator(`[data-canvas-node-id="${id}"]`).hover();
    await hotspot.getByRole('button', { name: '添加下游', exact: true }).waitFor();
  }
  assert.equal(await page.locator('[data-card-name="agent-group"]').count(), 1);
  assert.ok(await page.locator('[data-canvas-node-id="old"] img').evaluate(image => image.complete && image.naturalWidth > 0));
  // Visibility is a projection: preserve exact historical nodes and their saved names.
  const names = await page.evaluate(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.cardNames);
  assert.ok(names['agent-launch']);
  assert.ok(names.archived);
  await page.evaluate(() => {
    const snapshot = window.snapshot();
    if (!snapshot.nodes.some(node => node.id === 'agent-launch')) throw new Error('history was removed');
    snapshot.edges = [];
    snapshot.nodes = snapshot.nodes.filter(node => node.id !== 'agent-group');
    snapshot.threads.find(thread => thread.id === 'archived-thread').archivedAt = null;
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
  });
  await page.reload();
  for (const id of ['agent-launch', 'archived']) {
    await page.locator(`[data-canvas-node-id="${id}"]`).waitFor();
    assert.equal(await page.locator(`[data-workflow-material="${id}"]`).count(), 1);
    assert.equal(await page.locator(`[data-card-name="${id}"] input`).inputValue(), names[id]);
  }
  assert.deepEqual(errors, []);
  console.log('Canvas overlay visibility: Agent history, archived threads, active media, and restored names passed.');
} finally {
  await browser.close();
  await server.close();
}
