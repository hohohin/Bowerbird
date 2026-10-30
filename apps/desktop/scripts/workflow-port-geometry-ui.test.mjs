import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const cache = '.tmp/workflow-port-geometry-vite';
const server = await createServer({ configFile: false, cacheDir: cache, optimizeDeps: { include: ['react', 'react-dom/client', 'react-dom'] },
  server: { host: '127.0.0.1', port: 17936, strictPort: true, hmr: false, watch: null } });
await server.listen();
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/port-geometry', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('http://127.0.0.1:17936/port-geometry');
  await page.evaluate(async cache => {
    const [{ default: React }, { default: { createRoot } }, { default: { flushSync } }, { useWorkflowPortGeometry }] = await Promise.all([
      import(`/${cache}/deps/react.js`), import(`/${cache}/deps/react-dom_client.js`), import(`/${cache}/deps/react-dom.js`), import('/src/lib/useWorkflowPortGeometry.ts'),
    ]);
    const original = HTMLElement.prototype.getBoundingClientRect;
    window.reads = 0;
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.matches('[data-canvas-node-id],[data-workflow-cell],[data-workflow-text-input],[data-canvas-cell]')) window.reads++;
      return original.call(this);
    };
    window.geometry = null;
    function Cells() {
      const [revision, replace] = React.useState(0);
      window.replacePort = () => flushSync(() => replace(value => value + 1));
      return React.createElement(React.Fragment, {},
        React.createElement('div', { 'data-canvas-cell': 'first', style: { height: 40 } }),
        React.createElement('div', { 'data-canvas-cell': 'second', style: { position: 'relative', width: '100%', height: 60 } },
          React.createElement('button', { key: revision, 'data-workflow-cell': 'cell', style: { position: 'absolute', left: 200 + revision * 10, top: 10, padding: 0, border: 0, width: 10, height: 10 } }),
          React.createElement('button', { 'data-workflow-text-input': 'cell', 'data-content-input-type': 'image', style: { position: 'absolute', left: 0, top: 20, padding: 0, border: 0, width: 10, height: 10 } })));
    }
    function Fixture({ x = 20, y = 30, width = 300, height = 200, payloadJson = 'a', connected = true, second = false }) {
      const svg = React.useRef(null);
      const node = { id: 'table', x, y, width, height, payloadJson };
      const targets = connected ? [{ node, kind: 'output', port: 'cell' }, { node, kind: 'output', port: 'cell' },
        { node, kind: 'cell', port: 'second' }, ...(second ? [{ node, kind: 'input', port: 'cell', image: true }] : [])] : [];
      const rect = useWorkflowPortGeometry(svg, targets);
      window.geometry = { output: rect(node, 'output', 'cell'), embedded: rect(node, 'cell', 'second'), input: rect(node, 'input', 'cell', true) };
      return React.createElement('div', { className: 'canvas-plane', style: { position: 'relative', transform: 'scale(0.625)', transformOrigin: '0 0' } },
        React.createElement('svg', { ref: svg, style: { position: 'absolute', width: 1, height: 1, overflow: 'visible' } }),
        React.createElement('div', { 'data-canvas-node-id': 'table', style: { position: 'absolute', left: x, top: y, width, height } },
          React.createElement(Cells)));
    }
    const root = createRoot(document.getElementById('root'));
    window.renderGeometry = props => flushSync(() => root.render(React.createElement(React.StrictMode, {}, React.createElement(Fixture, props))));
    window.unmountGeometry = () => flushSync(() => root.render(null));
    window.renderGeometry({});
  }, cache);
  await page.waitForFunction(() => window.geometry?.output?.x === 220);
  await page.waitForTimeout(100);
  assert.deepEqual(await page.evaluate(() => window.geometry.output), { x: 220, y: 80, width: 10, height: 10 });
  assert.deepEqual(await page.evaluate(() => window.geometry.embedded), { x: 20, y: 70, width: 300, height: 60 });

  // Repeated pointer frames change card coordinates, not its socket layout.
  await page.evaluate(() => { window.reads = 0; for (let i = 0; i < 20; i++) window.renderGeometry({ x: 100 + i, y: 200 + i }); });
  assert.equal(await page.evaluate(() => window.reads), 0, 'translation must use cached local coordinates');
  assert.deepEqual(await page.evaluate(() => window.geometry.output), { x: 319, y: 269, width: 10, height: 10 });
  await page.evaluate(() => { window.reads = 0; document.querySelector('.canvas-plane').style.transform = 'translate(70px, 40px) scale(1.75)'; });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.reads), 0, 'camera transform must not remeasure sockets');

  // A preceding row resizes without changing the destination cell or card size.
  await page.evaluate(() => { document.querySelector('[data-canvas-cell="first"]').style.height = '85px'; });
  await page.waitForFunction(() => Math.abs(window.geometry.output.y - 314) < .01);
  assert.deepEqual(await page.evaluate(() => window.geometry.embedded), { x: 119, y: 304, width: 300, height: 60 });

  // New connection and layout payload changes update committed geometry once.
  await page.evaluate(() => window.renderGeometry({ x: 119, y: 219, width: 360.5, second: true, payloadJson: 'resized' }));
  await page.waitForFunction(() => window.geometry.input?.width === 10 && Math.abs(window.geometry.embedded.width - 360.5) < .01);
  assert.equal(await page.evaluate(() => window.geometry.input.x), 119);
  assert.equal(await page.evaluate(() => window.geometry.output.x), 319);
  await page.evaluate(() => window.replacePort());
  await page.waitForFunction(() => window.geometry.output?.x === 329);
  assert.equal(await page.locator('[data-workflow-cell="cell"]').count(), 1,
    'child-local replacement refreshes cached elements without a parent prop change');
  await page.evaluate(() => window.renderGeometry({ connected: false }));
  await page.waitForFunction(() => !window.geometry.output && !window.geometry.embedded);
  await page.evaluate(() => { window.unmountGeometry(); window.reads = 0; });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.reads), 0, 'unmount releases observers and queued frames');
  await page.evaluate(() => window.renderGeometry({}));
  await page.waitForFunction(() => window.geometry.output?.x === 220);
  assert.deepEqual(errors, []);
  console.log('PASS: connected port deduplication, cached drag coordinates, camera independence, row resize tracking without parent updates, fractional column width, socket replacement, disconnect and StrictMode cleanup');
} finally { await browser?.close(); await server.close(); }
