import assert from 'node:assert/strict';
import { createServer } from 'vite';
const { chromium } = await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE ?? '../../html-renderer/node_modules/playwright/index.mjs');

const server = await createServer({ cacheDir: '.tmp/video-poster-visibility-vite', optimizeDeps: { include: ['react', 'react-dom/client', 'react-dom'] }, server: { host: '127.0.0.1', port: 17935, strictPort: true, hmr: false, watch: null } });
await server.listen();
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [], imageReads = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/visibility-cover-*.svg', route => {
    imageReads.push(route.request().url());
    return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="green"/></svg>' });
  });
  await page.route('**/video-poster-visibility', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('http://127.0.0.1:17935/video-poster-visibility');
  await page.evaluate(async () => {
    const w = window;
    w.calls = [];
    w.held = new Map();
    w.active = 0; w.maxActive = 0;
    w.poster = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="green"/></svg>');
    w.__TAURI_INTERNALS__ = {
      convertFileSrc: path => path,
      invoke: async (command, args) => {
        if (command !== 'video_poster') return null;
        w.calls.push(args.sourcePath);
        w.active++; w.maxActive = Math.max(w.maxActive, w.active);
        try {
          if (args.sourcePath.includes('block')) await new Promise(resolve => w.held.set(args.sourcePath, resolve));
          return args.sourcePath.includes('failure') ? null : w.poster;
        } finally { w.active--; }
      },
    };
    const [{ default: React }, { default: { createRoot } }, { default: { flushSync } }, { VideoPoster }] = await Promise.all([
      import('/.tmp/video-poster-visibility-vite/deps/react.js'), import('/.tmp/video-poster-visibility-vite/deps/react-dom_client.js'),
      import('/.tmp/video-poster-visibility-vite/deps/react-dom.js'), import('/src/components/VideoPoster.tsx'),
    ]);
    const root = createRoot(document.getElementById('root'));
    w.renderPosters = (items, canvas = true) => flushSync(() => root.render(React.createElement(React.StrictMode, {},
      React.createElement('div', { className: canvas ? 'canvas-stage' : undefined, style: { position: 'relative', width: 400, height: 250, overflow: 'hidden' } },
        ...items.map(item => React.createElement(VideoPoster, { key: item.id, path: item.path, poster: item.poster, 'data-id': item.id,
          style: { position: 'absolute', top: 20, left: item.hidden ? 900 : (item.left ?? 20), width: 160, height: 90 } }))))));
    w.release = path => { w.held.get(path)?.(); w.held.delete(path); };
  });
  const calls = () => page.evaluate(() => window.calls);
  const settle = () => page.waitForTimeout(180);

  // A card can be inside the window but outside the clipped canvas stage.
  await page.evaluate(() => window.renderPosters([
    { id: 'saved', path: '/saved.mp4', poster: '/visibility-cover-saved.svg', hidden: true },
    { id: 'missing', path: '/missing.mp4', hidden: true },
  ]));
  await settle();
  assert.deepEqual(await calls(), []);
  assert.deepEqual(imageReads, []);
  assert.equal(await page.locator('#root img').evaluateAll(nodes => nodes.every(node => node.getAttribute('src')?.startsWith('data:image/svg+xml,') && node.getAttribute('src') !== window.poster)), true);
  await page.evaluate(() => window.renderPosters([
    { id: 'saved', path: '/saved.mp4', poster: '/visibility-cover-saved.svg' },
    { id: 'missing', path: '/missing.mp4', left: 200 },
  ]));
  await page.waitForFunction(() => window.calls.includes('/missing.mp4') && [...document.querySelectorAll('#root img')].every(img => img.naturalWidth === 160));
  assert.equal(imageReads.length, 1);
  assert.deepEqual(await calls(), ['/missing.mp4']);
  await page.evaluate(() => window.renderPosters([
    { id: 'saved', path: '/saved.mp4', poster: '/visibility-cover-saved.svg', hidden: true },
    { id: 'missing', path: '/missing.mp4', hidden: true },
  ]));
  await page.waitForFunction(() => [...document.querySelectorAll('#root img')].every(img => img.getAttribute('src')?.startsWith('data:image/svg+xml,') && img.getAttribute('src') !== window.poster));

  // A waiting task loses all consumers before the native decoder is free.
  await page.evaluate(() => window.renderPosters([{ id: 'block', path: '/block-queue.mp4' }]));
  await page.waitForFunction(() => window.held.has('/block-queue.mp4'));
  await page.evaluate(() => window.renderPosters([
    { id: 'block', path: '/block-queue.mp4' }, { id: 'queued', path: '/queued.mp4', left: 200 },
  ]));
  await settle();
  await page.evaluate(() => window.renderPosters([
    { id: 'block', path: '/block-queue.mp4' }, { id: 'queued', path: '/queued.mp4', hidden: true },
  ]));
  await settle();
  await page.evaluate(() => window.release('/block-queue.mp4'));
  await settle();
  assert.equal((await calls()).includes('/queued.mp4'), false, 'offscreen queued extraction must be skipped');
  await page.evaluate(() => window.renderPosters([{ id: 'queued', path: '/queued.mp4' }]));
  await page.waitForFunction(() => window.calls.includes('/queued.mp4'));

  // Removing one consumer must not cancel a shared queued request still visible elsewhere.
  await page.evaluate(() => window.renderPosters([{ id: 'block2', path: '/block-shared.mp4' }]));
  await page.waitForFunction(() => window.held.has('/block-shared.mp4'));
  await page.evaluate(() => window.renderPosters([
    { id: 'block2', path: '/block-shared.mp4' }, { id: 'shared1', path: '/shared.mp4' }, { id: 'shared2', path: '/shared.mp4', left: 200 },
  ]));
  await settle();
  await page.evaluate(() => window.renderPosters([
    { id: 'block2', path: '/block-shared.mp4' }, { id: 'shared1', path: '/shared.mp4', hidden: true }, { id: 'shared2', path: '/shared.mp4', left: 200 },
  ]));
  await settle();
  await page.evaluate(() => window.release('/block-shared.mp4'));
  await page.waitForFunction(() => window.calls.includes('/shared.mp4'));
  assert.equal((await calls()).filter(path => path === '/shared.mp4').length, 1);
  assert.equal(await page.evaluate(() => window.maxActive), 1, 'native extraction stays serial');

  // Non-canvas callers retain viewport-based behavior.
  await page.evaluate(() => window.renderPosters([{ id: 'outside', path: '/outside-canvas.mp4' }], false));
  await page.waitForFunction(() => window.calls.includes('/outside-canvas.mp4'));

  // Leaving during cooldown pauses retries; returning must not reset the budget.
  await page.clock.install();
  await page.evaluate(() => window.renderPosters([{ id: 'failure', path: '/failure.mp4' }]));
  await page.waitForFunction(() => window.calls.includes('/failure.mp4'));
  await page.evaluate(() => window.renderPosters([{ id: 'failure', path: '/failure.mp4', hidden: true }]));
  await settle();
  await page.clock.fastForward(10_100);
  assert.equal((await calls()).filter(path => path === '/failure.mp4').length, 1, 'offscreen failure must not retry');
  await page.evaluate(() => window.renderPosters([{ id: 'failure', path: '/failure.mp4' }]));
  await page.waitForFunction(() => window.calls.filter(path => path === '/failure.mp4').length === 2);
  await page.clock.fastForward(30_000);
  await page.evaluate(() => window.renderPosters([{ id: 'failure', path: '/failure.mp4', hidden: true }]));
  await settle();
  await page.evaluate(() => window.renderPosters([{ id: 'failure', path: '/failure.mp4' }]));
  await settle();
  await page.clock.fastForward(10_100);
  assert.equal((await calls()).filter(path => path === '/failure.mp4').length, 2, 'visibility toggles must not reset the one-retry budget');
  assert.equal(await page.locator('video').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: canvas clipping defers cover reads and extraction, leaving clears real sources, abandoned queue work skips, shared consumers coalesce, native work stays serial, non-canvas preview works, visibility pauses bounded retries');
} finally {
  await browser?.close();
  await server.close();
}
