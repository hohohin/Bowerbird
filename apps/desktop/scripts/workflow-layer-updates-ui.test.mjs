import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const cache = '.tmp/workflow-layer-updates-vite';
const server = await createServer({ cacheDir: cache,
  plugins: [{ name: 'count-workflow-card-renders', enforce: 'pre', transform(code, id) {
    if (!id.endsWith('/WorkflowCard.tsx')) return;
    const marker = 'const creating = !nodeById.has(node.id);';
    assert.ok(code.includes(marker));
    return code.replace(marker, 'window.cardRenders.set(node.id, (window.cardRenders.get(node.id) ?? 0) + 1);\n' + marker);
  } }], optimizeDeps: { include: ['react', 'react-dom/client', 'react-dom', 'zustand/shallow'] },
  server: { host: '127.0.0.1', port: 17937, strictPort: true, hmr: false, watch: null } });
await server.listen();
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/layer-updates', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('http://127.0.0.1:17937/layer-updates');
  await page.evaluate(async cache => {
    window.__TAURI_INTERNALS__ = { convertFileSrc: path => path, invoke: async command => command === 'canvas_workflow_get'
      ? { document: { version: 1, nodes: [], runs: [], run: null }, revision: 0 } : [] };
    const [{ default: React }, { default: { createRoot } }, { default: { flushSync } }, { CanvasWorkflowLayer }, { canvasWorkflowController }, { newWorkflowNode }, { useStore }] = await Promise.all([
      import(`/${cache}/deps/react.js`), import(`/${cache}/deps/react-dom_client.js`), import(`/${cache}/deps/react-dom.js`),
      import('/src/components/CanvasWorkflowLayer.tsx'), import('/src/lib/canvasWorkflowRuntime.ts'), import('/src/lib/canvasWorkflow.ts'), import('/src/store.ts'),
    ]);
    const controller = canvasWorkflowController('updates');
    await controller.load(true);
    const node = newWorkflowNode('trigger', 400, 50, '');
    const active = newWorkflowNode('generation', 1000, 500, 'jimeng');
    const staticCards = Array.from({ length: 50 }, (_, i) => newWorkflowNode('trigger', 1000 + i * 225, 100, ''));
    controller.document = { ...controller.document, nodes: [node, active, ...staticCards] };
    window.cardRenders = new Map();
    window.activeCard = active.id;
    window.editCard = () => controller.edit(controller.document.nodes.map(card => card.id === node.id
      ? { ...card, triggerMode: 'completion' } : card));
    const graphNodes = Array.from({ length: 101 }, (_, i) => ({ id: 'asset-' + i, kind: 'asset',
      x: i * 100, y: 1000, width: 80, height: 80, assetId: 'media-' + i }));
    useStore.setState({ genJobs: { current: { id: 'current', running: true, turns: [{ turnKey: 'turn' }] } } });
    window.pushProgress = index => useStore.setState(state => ({ genJobs: { ...state.genJobs,
      current: { ...state.genJobs.current, progress: { stage: 'queued', queue_position: index, queue_length: 80, turnKey: 'turn' } } } }));
    window.workflowNodeId = node.id;
    const ref = React.createRef(); window.layer = ref;
    const noop = () => {};
    const materials = [{ id: 'source', assetId: 'source-asset', x: 40, y: 50, width: 100, height: 80 }];
    window.layerCommits = 0;
    const root = createRoot(document.getElementById('root'));
    flushSync(() => root.render(React.createElement(React.Profiler, { id: 'workflow', onRender: () => window.layerCommits++ },
      React.createElement('div', { className: 'canvas-plane', style: { position: 'relative', width: 1000, height: 600 } },
        React.createElement(CanvasWorkflowLayer, { ref, projectId: 'updates', provisional: true, materials, graphNodes, entryCardIds: null, deferredCandidateIds: null,
          generationCardOrigins: new Map(), activeGenerationIds: new Set([active.id]), getZoom: () => 1,
          generationActivities: new Map([[active.id, { running: true, jobId: 'current' }]]), selectedIds: new Set(), panReady: false,
          onSelect: noop, onNodesChanged: noop, onEdited: noop, onOpenGeneration: noop, onOpenAgent: noop, onDragStart: noop, onDragMove: noop,
          onDragEnd: noop, onNodeMenu: noop, onRemove: noop, ensureMaterialized: async () => {}, toBoardPoint: (x, y) => ({ x, y }), onPlaced: noop })))));
    window.changeUnrelated = () => { for (let i = 0; i < 30; i++) useStore.setState({ searchQuery: `unrelated-${i}` }); };
    window.moveCursor = (x, y, buttons = 0) => document.body.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', buttons, clientX: x, clientY: y }));
    window.unmountLayer = () => flushSync(() => root.render(null));
  }, cache);
  await page.locator('[data-workflow-material="source"]').waitFor();
  await page.waitForTimeout(150);
  assert.equal(await page.locator('[data-workflow-card]').count(), 52);
  await page.evaluate(async () => {
    window.cardRenders.clear();
    const card = document.querySelector('[data-workflow-card="' + window.activeCard + '"]');
    for (let i = 1; i <= 36; i++) {
      window.pushProgress(i);
      card.style.height = (650 + i) + 'px';
      await new Promise(requestAnimationFrame);
    }
  });
  await page.getByText('排队中 · 队列位置 36 / 80', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => [...window.cardRenders.keys()].filter(id => id !== window.activeCard)), [],
    'single-card progress and measurement must leave all 51 static cards untouched');
  await page.evaluate(async () => { window.cardRenders.clear(); await window.editCard(); });
  await page.getByRole('spinbutton', { name: '剩余触发次数' }).waitFor();
  assert.deepEqual(await page.evaluate(() => [...window.cardRenders.keys()]), [await page.evaluate(() => window.workflowNodeId)],
    'editing one trigger must commit only that card, including the save acknowledgement');

  const trigger = page.locator('[data-workflow-card]').first().locator('header');
  await trigger.hover();
  await page.getByRole('tooltip').waitFor();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  const layoutReads = await trigger.evaluate(async anchor => {
    let reads = 0;
    const original = anchor.getBoundingClientRect;
    anchor.getBoundingClientRect = () => { reads++; return original.call(anchor); };
    for (let i = 0; i < 20; i++) await new Promise(requestAnimationFrame);
    delete anchor.getBoundingClientRect;
    return reads;
  });
  assert.equal(layoutReads, 0, 'an idle trigger tooltip must not poll anchor layout');
  await page.evaluate(() => { document.querySelector('.canvas-plane').style.transform = 'translateX(2px)'; });
  await page.getByRole('tooltip').waitFor({ state: 'detached' });
  await page.evaluate(() => { window.layerCommits = 0; window.changeUnrelated(); });
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => window.layerCommits), 0, 'unrelated store updates must not commit the workflow tree');

  await page.locator('[data-workflow-material="source"]').getByRole('button', { name: '添加下游', exact: true }).dispatchEvent('pointerdown', { button: 0, buttons: 1, pointerType: 'mouse', clientX: 158, clientY: 90 });
  await page.locator('.workflow-wires .is-draft').waitFor({ state: 'attached' });
  await page.evaluate(() => window.moveCursor(200, 200, 1));
  await page.waitForTimeout(80);
  await page.evaluate(() => { window.layerCommits = 0; for (let i = 0; i < 60; i++) window.moveCursor(300 + i, 250 + i, 1); });
  await page.waitForFunction(() => document.querySelector('.workflow-wires .is-draft')?.getAttribute('d')?.endsWith('359 309'));
  assert.equal(await page.evaluate(() => window.layerCommits), 0, 'draft cursor updates must not commit unrelated cards');
  await page.keyboard.press('Escape');
  await page.locator('.workflow-wires .is-draft').waitFor({ state: 'detached' });

  await page.evaluate(() => window.layer.current.arm(200, 100));
  await page.locator('.workflow-key-ghost').waitFor();
  await page.waitForTimeout(80);
  await page.evaluate(() => { window.layerCommits = 0; for (let i = 0; i < 60; i++) window.moveCursor(400 + i, 300 + i); });
  await page.waitForFunction(() => document.querySelector('.workflow-key-ghost')?.style.left === '475px');
  assert.equal(await page.evaluate(() => window.layerCommits), 0, 'winding-key cursor updates must not commit unrelated cards');
  await page.keyboard.press('Escape');
  await page.locator('.workflow-key-ghost').waitFor({ state: 'detached' });

  await page.evaluate(() => { window.layerCommits = 0; for (let i = 0; i < 30; i++) window.layer.current.position(new Map([[window.workflowNodeId, { x: 400, y: 50 }]])); });
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => window.layerCommits), 0, 'equivalent positions must not redraw');
  await page.evaluate(() => { window.layer.current.arm(20, 20); window.moveCursor(30, 30); window.unmountLayer(); });
  await page.waitForTimeout(80);
  assert.deepEqual(errors, []);
  console.log('PASS: 52 cards and 101 nodes isolate progress, size and configuration edits; idle hover has zero layout reads; draft, key and equivalent position updates cause zero workflow commits');
} finally { await browser?.close(); await server.close(); }
