import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 1591, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
try {
  await page.goto('http://127.0.0.1:1591/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(() => { const snapshot = window.snapshot(); snapshot.nodes = snapshot.nodes.filter(node => node.id !== 'far'); sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot)); });
  await page.reload();
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { useStore } = await import('/src/store.ts');
    const { canvasWorkflowController, CanvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const dataUrl = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="red"/></svg>');
    const document = { schemaVersion: 1, width: 8, height: 8, layers: [{ id: 'base', name: '底图', dataUrl, x: 0, y: 0, width: 8, height: 8, opacity: 1, visible: true, background: true }] };
    useStore.setState({ cloudAuth: { logged_in: true, cloud_available: true, user_id: 'test' }, layerEditor: null, layerWorkspaceIds: new Set() });
    const workspaces = new Map();
    window.layerRequests = []; window.layerReleases = []; window.exports = [];
    api.layerWorkspaceLoad = async id => workspaces.get(id) ?? null;
    api.layerWorkspaceSave = async (id, value) => { workspaces.set(id, structuredClone(value)); };
    api.readImageDataUrl = async () => dataUrl;
    api.layerCloudRequest = async request => {
      if (request.action === 'layer_quote') return { services: [{ service: 'image_layer_decompose', available: true }] };
      if (request.action === 'get_by_key') return { status: 'not_found' };
      const entry = [...workspaces.entries()].find(([, value]) => value.pending?.request.idempotency_key === request.idempotency_key);
      if (!entry) throw new Error('request submitted before pending workspace saved');
      window.layerRequests.push({ assetId: entry[0], key: request.idempotency_key });
      return new Promise(resolve => window.layerReleases.push(fail => resolve(fail ? { status: 'failed', error: { message: '模拟拆分失败' } } : { status: 'succeeded', layer_result: { document } })));
    };
    api.layerExport = async id => { window.exports.push(id); return { id: id === 'existing' ? 'c' : 'd' }; };
    const trigger = { ...newWorkflowNode('trigger', 100, 70, 'codex'), id: 'switch' };
    const split = (id, assetId, x) => ({ ...newWorkflowNode('instruction', x, 70, 'codex'), id, action: 'layers', inputs: { image: [{ assetId }], signal: [{ nodeId: 'switch', portId: 'signal' }] } });
    window.setup = async (name, same = false, dependency = false) => {
      workspaces.clear(); window.layerRequests = []; window.layerReleases = []; window.exports = [];
      const a = split('first', 'existing', 480), b = split('second', same ? 'existing' : 'a', 860);
      if (dependency) b.inputs.image = [{ nodeId: 'first', portId: 'image' }];
      const downstream = { ...newWorkflowNode('instruction', 1200, 70, 'codex'), id: 'downstream', action: 'reuse', inputs: { image: [{ nodeId: 'second', portId: 'image' }] } };
      const c = name === 'p' ? canvasWorkflowController(name) : new CanvasWorkflowController(name);
      await c.load(); await c.edit([trigger, a, b, downstream]); window.c = c;
      window.running = c.start('switch');
    };
    await window.setup('p');
  });
  await page.waitForFunction(() => window.layerRequests.length === 2);
  assert.deepEqual(await page.evaluate(() => window.layerRequests.map(r => r.assetId).sort()), ['a', 'existing']);
  await page.getByRole('button', { name: '适应内容', exact: true }).click();
  await page.locator('[data-workflow-card="switch"]').hover();
  await page.getByRole('tooltip').waitFor();
  assert.match(await page.getByRole('tooltip').innerText(), /2 个步骤同时执行中/);
  assert.equal(await page.getByRole('tooltip').locator('li').filter({ hasText: '分层拆分 · 执行中' }).count(), 2);
  await page.screenshot({ path: '.tmp/workflow/layers-parallel.png' });
  await page.evaluate(() => window.layerReleases[1]());
  await page.waitForFunction(() => window.c.document.run.steps.downstream.status === 'done');
  assert.equal(await page.evaluate(() => window.c.document.run.steps.first.status), 'running');
  await page.evaluate(async () => { window.layerReleases[0](); await window.running; });
  assert.equal(await page.evaluate(() => window.c.document.run.status), 'done');
  assert.equal(await page.evaluate(() => new Set(window.layerRequests.map(r => r.key)).size), 2);
  assert.equal(await page.evaluate(() => window.exports.length), 2);

  // Same original image is serialized and the second card reuses the saved workspace.
  await page.evaluate(() => window.setup('parallel-same', true));
  await page.waitForFunction(() => window.layerRequests.length === 1);
  await page.evaluate(async () => { window.layerReleases[0](); await window.running; });
  assert.equal(await page.evaluate(() => window.c.document.run.status), 'done');
  assert.equal(await page.evaluate(() => window.layerRequests.length), 1);

  // A dependent split starts only after its source exports its result.
  await page.evaluate(() => window.setup('parallel-dependency', false, true));
  await page.waitForFunction(() => window.layerRequests.length === 1);
  await page.evaluate(() => window.layerReleases[0]());
  await page.waitForFunction(() => window.layerRequests.length === 2);
  assert.deepEqual(await page.evaluate(() => window.exports), ['existing']);
  assert.equal(await page.evaluate(() => window.layerRequests[1].assetId), 'c');
  await page.evaluate(async () => { window.layerReleases[1](); await window.running; });
  assert.equal(await page.evaluate(() => window.c.document.run.status), 'done');

  await page.evaluate(() => window.setup('parallel-failure'));
  await page.waitForFunction(() => window.layerRequests.length === 2);
  await page.evaluate(() => window.layerReleases[1](true));
  await page.waitForFunction(() => window.c.document.run.steps.second.status === 'running');
  await page.evaluate(async () => { window.layerReleases[0](); await window.running; });
  assert.deepEqual(await page.evaluate(() => [window.c.document.run.status, window.c.document.run.steps.second.status, window.c.document.run.steps.downstream.status, window.exports.length]), ['failed', 'failed', 'pending', 0]);

  await page.evaluate(() => window.setup('parallel-stop'));
  await page.waitForFunction(() => window.layerRequests.length === 2);
  await page.evaluate(async () => { const stopping = window.c.stop(); window.layerReleases.forEach(release => release()); await stopping; await window.running; });
  assert.deepEqual(await page.evaluate(() => [window.c.document.run.status, window.exports.length, window.c.document.run.steps.downstream.status]), ['stopped', 0, 'pending']);
  console.log('parallel layers: simultaneous submission, per-step hover progress, distinct saved keys, same-image reuse, dependent ordering, failure and stop passed');
} finally { await browser.close(); await server.close(); }
