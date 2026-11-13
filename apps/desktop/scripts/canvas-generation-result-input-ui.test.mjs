import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const entry = 'scripts/fixtures/canvas-reference/preview.html';
const server = await createServer({ cacheDir: '.tmp/canvas-result-input-vite', optimizeDeps: { entries: [entry] },
  server: { host: '127.0.0.1', port: 17968, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 980 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + entry);
  await page.locator('[data-canvas-node-id="old"]').waitFor();

  for (const grouped of [false, true]) {
    await page.evaluate(async grouped => {
      const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
      const snapshot = window.snapshot(), base = snapshot.nodes.find(node => node.id === 'old');
      const makeTurn = (id, x, at) => ({ ...base, id, kind: 'prompt', assetId: null, role: null, x, y: 120, createdAt: at,
        payloadJson: JSON.stringify({ schema_version: 1, job_id: 'upstream-job', turn_key: id, text: '上游', provider: 'codex', status: 'done' }) });
      const makeOutput = (assetId, turn) => ({ ...base, role: 'output', assetId, id: 'output-' + assetId, createdAt: turn.createdAt,
        payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: assetId, width: 190, height: 150 }, execution: { job_id: 'upstream-job', turn_key: turn.id } }) });
      const first = makeTurn('first', 100, 1), next = makeTurn('next', 400, 2);
      snapshot.nodes = [{ ...base, x: 110, y: 425 }, first, makeOutput('a', first),
        ...(grouped ? [next, makeOutput('b', next), makeOutput('c', next)] : []),
        { ...makeOutput('d', grouped ? next : first), hiddenAt: 4 }];
      snapshot.view = { ...snapshot.view, zoom: 0.8, panX: 60, panY: 40 };
      sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
      const target = { ...newWorkflowNode('generation', 670, 160, 'codex'), id: 'draw', prompt: '下游' };
      sessionStorage.setItem('workflow-p', JSON.stringify({ revision: 1, document: { schema_version: 1, nodes: [target], run: null } }));
    }, grouped);
    await page.reload();
    const target = page.locator('[data-workflow-card="draw"]');
    await target.waitFor();
    for (const id of ['first', 'old']) {
      const handle = page.locator(`[data-workflow-material="${id}"] [data-canvas-connect-side="output"]`);
      await page.locator(`[data-canvas-node-id="${id}"]`).hover();
      const from = await handle.boundingBox(), to = await target.boundingBox();
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.x + to.width / 2, to.y + 60, { steps: 12 });
      await page.mouse.up();
      await page.waitForFunction(n => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(n => n.id === 'draw').inputs.image?.length === n,
        id === 'first' ? 1 : 2);
    }
    await page.evaluate(async () => {
      const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
      const c = canvasWorkflowController('p');
      await c.edit(c.document.nodes.map(node => node.id === 'draw' ? { ...node, prompt: '主体 @[subject]，背景 @[background]',
        promptReferences: node.inputs.image.map((input, i) => ({ id: i ? 'background' : 'subject', type: 'image', slot: i + 1, input, label: '图片来源 ' + (i + 1) })) } : node));
    });
    await page.reload();
    await target.waitFor();
    const result = await page.evaluate(async () => {
      const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
      const { api } = await import('/src/lib/api.ts');
      const c = canvasWorkflowController('p'), requests = [];
      const store = window.store;
      store.setState({ codexHealth: { ok: true, reason: '' },
        cloudEntitlement: { policy: { can_use_byo: true, max_parallel_jobs: 3 }, balances: { daily: 0, topup: 0, sub: 0 } } });
      const assets = await api.getAssetsByIds(['a', 'b', 'c', 'd', 'existing']);
      api.codexCreateImage = async args => {
        requests.push({ ids: args.referenceImages.map(path => assets.find(a => a.store_path === path)?.id), prompt: args.prompt });
        return null;
      };
      await c.start('draw', true);
      return { requests, status: c.document.run.status, diagnostic: c.issue,
        inputs: c.document.nodes.find(node => node.id === 'draw').inputs.image };
    });
    assert.equal(result.status, 'done', JSON.stringify(result));
    assert.equal(result.inputs[0].canvasNodeId, grouped ? 'next' : 'first');
    assert.equal(result.inputs[1].assetNodeId, 'old');
    assert.deepEqual(result.requests, [{ ids: grouped ? ['b', 'c', 'existing'] : ['a', 'existing'],
      prompt: grouped ? '主体 @图片1 @图片2，背景 @图片3' : '主体 @图片1，背景 @图片2' }]);
  }
  const rejected = await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const c = canvasWorkflowController('p'), getCanvas = api.projectCanvasGet;
    const exactSession = c.document.nodes.find(node => node.id === 'draw').inputs.image[0].canvasNodeId;
    let requests = 0;
    api.codexCreateImage = async () => { requests++; };
    const results = [];
    for (const mode of ['hidden', 'running']) {
      api.projectCanvasGet = async (...args) => {
        const canvas = await getCanvas(...args);
        return { ...canvas, nodes: canvas.nodes.map(node => node.id !== exactSession ? node : mode === 'hidden'
          ? { ...node, hiddenAt: 10 } : { ...node, payloadJson: JSON.stringify({ ...JSON.parse(node.payloadJson), status: 'running' }) }) };
      };
      await c.start('draw', true);
      results.push({ status: c.document.run.status, source: c.issue?.source?.canvasNodeId, requests,
        slots: c.document.nodes.find(node => node.id === 'draw').inputs.image.map(input => input.slot) });
    }
    return results;
  });
  for (const result of rejected) assert.deepEqual(result, { status: 'failed', source: 'next', requests: 0, slots: [1, 2] });
  assert.deepEqual(errors, []);
  console.log('PASS generated single and grouped outputs retain both live wires, reload, turn identity and exact downstream request');
} finally {
  await browser.close();
  await server.close();
}
