import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const entry = 'scripts/fixtures/canvas-reference/preview.html';
const server = await createServer({
  cacheDir: '.tmp/canvas-selection-output-vite', optimizeDeps: { entries: [entry] },
  server: { host: '127.0.0.1', port: 18556, strictPort: false, hmr: false, watch: null },
});
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.setDefaultTimeout(8000);
  await page.goto(server.resolvedUrls.local[0] + entry);
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const snapshot = window.snapshot(), base = snapshot.nodes.find(node => node.id === 'old');
    const { api } = await import('/src/lib/api.ts');
    const [original] = await api.getAssetsByIds(['existing']);
    const images = Array.from({ length: 9 }, (_, i) => ({ ...original, id: 'image-' + i, name: 'image-' + i }));
    sessionStorage.setItem('reference-drafts', JSON.stringify(images));
    snapshot.nodes = images.map((asset, i) => ({ ...base, id: 'node-' + i, assetId: asset.id,
      x: 180 + i % 3 * 245, y: 120 + Math.floor(i / 3) * 210 }));
    snapshot.view = { ...snapshot.view, zoom: .8, panX: 90, panY: 50 };
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const generator = { ...newWorkflowNode('generation', 1110, 150, 'codex'), id: 'generator' };
    sessionStorage.setItem('workflow-p', JSON.stringify({ revision: 0, document: { schema_version: 1, nodes: [generator], run: null } }));
  });
  const node = i => page.locator('[data-canvas-node-id="node-' + i + '"]');
  const generator = page.locator('[data-workflow-card="generator"]');
  const frame = page.locator('[data-canvas-selection-frame]');
  const expected = [0,1,2,3,5,6,7,8].map(i => 'image-' + i);
  const refs = generator.locator('[data-workflow-reference-asset]');
  async function connect() {
    const from = await frame.getByRole('button').boundingBox(), to = await generator.boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + 25, { steps: 16 });
    await page.mouse.up();
  }
  async function select() {
    const first = await node(0).boundingBox(), last = await node(8).boundingBox();
    await page.mouse.move(first.x - 24, first.y - 24);
    await page.mouse.down();
    await page.mouse.move(last.x + last.width + 12, last.y + last.height + 12, { steps: 12 });
    await page.mouse.up();
    await node(4).click({ modifiers: ['Control'] });
    assert.equal(await page.locator('.canvas-node.is-selected').count(), 8);
    await frame.waitFor();
    const bounds = await frame.boundingBox();
    for (const delta of [bounds.x - first.x, bounds.y - first.y,
      bounds.x + bounds.width - last.x - last.width, bounds.y + bounds.height - last.y - last.height]) {
      assert.ok(Math.abs(delta) < 3, 'frame aligns with outer item edges at 80% zoom: ' + delta);
    }
  }
  async function checkEight() {
    await page.waitForFunction(() => document.querySelectorAll('[data-workflow-reference-asset]').length === 8);
    assert.deepEqual((await refs.evaluateAll(items => items.map(item => item.dataset.workflowReferenceAsset))), expected);
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes[0].inputs.image?.length === 8);
  }
  await page.reload();
  await node(8).waitFor();
  await select();
  await connect();
  await checkEight();
  await page.getByRole('button', { name: '撤销画布操作' }).click();
  await page.waitForFunction(() => !JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes[0].inputs.image?.length);
  if (!await frame.count()) await select();
  await connect();
  await checkEight();
  await page.reload();
  await checkEight();
  console.log('PASS: eight selected images, zoomed bounds, unselected interior item, batch references, undo and reload');
} finally { await browser.close(); await server.close(); }
