import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const cache = '.tmp/workflow-layer-updates-vite';
const server = await createServer({ configFile: false, cacheDir: cache, optimizeDeps: { include: ['react', 'react-dom/client', 'react-dom', 'zustand/shallow'] },
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
    const node = newWorkflowNode('trigger', 400, 50, '');
    controller.document = { ...controller.document, nodes: [node] };
    window.workflowNodeId = node.id;
    const ref = React.createRef(); window.layer = ref;
    const noop = () => {};
    const materials = [{ id: 'source', assetId: 'source-asset', x: 40, y: 50, width: 100, height: 80 }];
    window.layerCommits = 0;
    const root = createRoot(document.getElementById('root'));
    flushSync(() => root.render(React.createElement(React.Profiler, { id: 'workflow', onRender: () => window.layerCommits++ },
      React.createElement('div', { className: 'canvas-plane', style: { position: 'relative', width: 1000, height: 600 } },
        React.createElement(CanvasWorkflowLayer, { ref, projectId: 'updates', provisional: true, materials, graphNodes: [], selectedIds: new Set(), panReady: false,
          onSelect: noop, onNodesChanged: noop, onEdited: noop, onOpenGeneration: noop, onOpenAgent: noop, onDragStart: noop, onDragMove: noop,
          onDragEnd: noop, onNodeMenu: noop, onRemove: noop, ensureMaterialized: async () => {}, toBoardPoint: (x, y) => ({ x, y }), onPlaced: noop })))));
    window.changeUnrelated = () => { for (let i = 0; i < 30; i++) useStore.setState({ searchQuery: `unrelated-${i}` }); };
    window.moveCursor = (x, y) => document.body.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y }));
    window.unmountLayer = () => flushSync(() => root.render(null));
  }, cache);
  await page.locator('[data-workflow-material="source"]').waitFor();
  await page.waitForTimeout(150);
  await page.evaluate(() => { window.layerCommits = 0; window.changeUnrelated(); });
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => window.layerCommits), 0, 'unrelated store updates must not commit the workflow tree');

  await page.locator('[data-workflow-material="source"]').dispatchEvent('pointerdown', { clientX: 140, clientY: 90 });
  await page.locator('.workflow-wires .is-draft').waitFor({ state: 'attached' });
  await page.evaluate(() => window.moveCursor(200, 200));
  await page.waitForTimeout(80);
  await page.evaluate(() => { window.layerCommits = 0; for (let i = 0; i < 60; i++) window.moveCursor(300 + i, 250 + i); });
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
  console.log('PASS: unrelated store changes, draft cursor bursts, winding-key cursor bursts and equivalent node positions cause zero workflow commits; cancellation and unmount clean up');
} finally { await browser?.close(); await server.close(); }
