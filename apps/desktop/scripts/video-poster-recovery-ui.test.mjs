import assert from 'node:assert/strict';
import { createServer } from 'vite';
const { chromium } = await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE ?? '../../html-renderer/node_modules/playwright/index.mjs');

const server = await createServer({ cacheDir: '.tmp/video-poster-recovery-vite', server: { host: '127.0.0.1', port: 17934, strictPort: true, hmr: false, watch: null } });
await server.listen();
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let cachedPosterExists = true;
  await page.route('**/cached-cover.jpg*', route => cachedPosterExists
    ? route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="red"/></svg>' })
    : route.fulfill({ status: 404, body: 'missing cached cover' }));
  await page.route('**/video-poster-recovery', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('http://127.0.0.1:17934/video-poster-recovery');
  await page.evaluate(async () => {
    const w = window;
    w.calls = [];
    w.recoveredPoster = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="green"/></svg>');
    w.posterResponses = new Map();
    w.__TAURI_INTERNALS__ = {
      convertFileSrc: path => path,
      invoke: async (command, args) => {
        if (command !== 'video_poster') return null;
        w.calls.push(args.sourcePath);
        const responses = w.posterResponses.get(args.sourcePath) ?? [w.recoveredPoster];
        const response = responses.length > 1 ? responses.shift() : responses[0];
        if (response instanceof Error) throw response;
        return response;
      },
    };
    const [{ default: React }, { default: { createRoot } }, { default: { flushSync } }, { VideoPoster }, { CanvasConversationImages }] = await Promise.all([
      import('/.tmp/video-poster-recovery-vite/deps/react.js'), import('/.tmp/video-poster-recovery-vite/deps/react-dom_client.js'),
      import('/.tmp/video-poster-recovery-vite/deps/react-dom.js'), import('/src/components/VideoPoster.tsx'), import('/src/components/CanvasConversationImages.tsx'),
    ]);
    const root = createRoot(document.getElementById('root'));
    w.unmountPoster = () => flushSync(() => root.render(null));
    w.renderPoster = (path, poster) => flushSync(() => root.render(React.createElement(React.StrictMode, {},
      React.createElement(VideoPoster, { path, poster, alt: path }))));
    w.renderConversation = (path, poster) => flushSync(() => root.render(React.createElement(CanvasConversationImages, {
      images: [{ id: 'result', assetId: 'generated-video', name: '生成视频', storePath: path, thumbPath: poster }],
      imageOnly: true, onSelect() {}, onPointerDown() {}, onClick() {}, onDoubleClick() {}, onContextMenu() {},
    })));
  });
  await page.clock.install();
  const image = page.locator('#root img');
  const waitForRecovered = async () => {
    try { await page.waitForFunction(() => document.querySelector('#root img')?.getAttribute('src') === window.recoveredPoster, undefined, { timeout: 5000 }); }
    catch (error) {
      console.error(await page.evaluate(() => ({ calls: window.calls, src: document.querySelector('#root img')?.getAttribute('src') })));
      throw error;
    }
  };

  // A successful request can later become stale when a thumbnail is removed.
  // Reopening must invalidate that request's resolved value and call native repair.
  await page.evaluate(() => {
    window.posterResponses.set('/generated-cache.mp4', ['/cached-cover.jpg', window.recoveredPoster]);
    window.renderPoster('/generated-cache.mp4');
  });
  await page.waitForFunction(() => document.querySelector('#root img')?.naturalWidth === 160);
  assert.equal(await image.getAttribute('src'), '/cached-cover.jpg');
  await page.evaluate(() => window.unmountPoster());
  cachedPosterExists = false;
  await page.evaluate(() => window.renderPoster('/generated-cache.mp4'));
  await page.waitForFunction(() => document.querySelector('#root img')?.getAttribute('src') === '/cached-cover.jpg');
  // Force a fresh image read after deletion instead of accepting Chromium's
  // decoded-image memory cache, which can survive removal of the DOM node.
  await image.evaluate(node => { node.src = '/cached-cover.jpg?verify-deleted=1'; });
  await waitForRecovered();
  assert.equal(await page.evaluate(() => window.calls.filter(path => path === '/generated-cache.mp4').length), 2,
    'a lost previously resolved cover must invoke native repair exactly once');

  // Generated conversation snapshots can also retain a missing thumbnail path.
  await page.evaluate(() => window.renderConversation('/conversation-result.mp4', '/cached-cover.jpg?conversation-missing=1'));
  await waitForRecovered();
  assert.equal(await page.locator('[data-conversation-image="generated-video"] img').count(), 1);
  assert.equal(await page.evaluate(() => window.calls.filter(path => path === '/conversation-result.mp4').length), 1);

  // A transient decoder failure may recover after its bounded cooldown. React
  // remounts in that interval must neither repeat extraction nor lock in null.
  await page.evaluate(() => {
    window.posterResponses.set('/transient.mp4', [new Error('temporary native failure'), window.recoveredPoster]);
    window.renderPoster('/transient.mp4');
  });
  await page.waitForFunction(() => window.calls.includes('/transient.mp4'));
  await page.evaluate(() => {
    for (let i = 0; i < 5; i++) {
      window.unmountPoster();
      window.renderPoster('/transient.mp4');
    }
  });
  assert.equal(await page.evaluate(() => window.calls.filter(path => path === '/transient.mp4').length), 1,
    'remounts during cooldown must share a failed request');
  await page.clock.fastForward(10_100);
  await waitForRecovered();
  assert.equal(await page.evaluate(() => window.calls.filter(path => path === '/transient.mp4').length), 2);

  // A permanent failure gets one automatic retry, then remains a static icon.
  // Moving to another video must cancel any future retries for the old source.
  await page.evaluate(() => {
    window.posterResponses.set('/unsupported.mp4', [null]);
    window.renderPoster('/unsupported.mp4');
  });
  await page.waitForFunction(() => window.calls.includes('/unsupported.mp4'));
  await page.clock.fastForward(10_100);
  await page.waitForFunction(() => window.calls.filter(path => path === '/unsupported.mp4').length === 2);
  await page.clock.fastForward(30_000);
  assert.equal(await page.evaluate(() => window.calls.filter(path => path === '/unsupported.mp4').length), 2,
    'unsupported media must not spin in an extraction loop');
  assert.match(await image.getAttribute('src'), /^data:image\/svg\+xml,/);
  assert.notEqual(await image.getAttribute('src'), await page.evaluate(() => window.recoveredPoster));
  assert.ok(await image.evaluate(node => node.naturalWidth > 0), 'unsupported media must display a valid placeholder');
  await page.evaluate(() => {
    window.posterResponses.set('/leaving.mp4', [null, window.recoveredPoster]);
    window.renderPoster('/leaving.mp4');
  });
  await page.waitForFunction(() => window.calls.includes('/leaving.mp4'));
  await page.evaluate(() => window.renderPoster('/next.mp4', window.recoveredPoster));
  await page.clock.fastForward(10_100);
  await waitForRecovered();
  assert.equal(await page.evaluate(() => window.calls.filter(path => path === '/leaving.mp4').length), 1,
    'switching videos must cancel the previous source retry');

  // The same carousel component can return to a video whose original cover
  // and first repair both failed. Its old terminal image state must not hide
  // a newly successful repair after another source has been displayed.
  await page.evaluate(() => {
    window.posterResponses.set('/roundtrip.mp4', [
      '/cached-cover.jpg?roundtrip=first', '/cached-cover.jpg?roundtrip=second', window.recoveredPoster,
    ]);
    window.renderPoster('/roundtrip.mp4');
  });
  await page.waitForFunction(() => window.calls.filter(path => path === '/roundtrip.mp4').length === 2
    && document.querySelector('#root img')?.getAttribute('src')?.startsWith('data:image/svg+xml,')
    && document.querySelector('#root img')?.getAttribute('src') !== window.recoveredPoster);
  await page.evaluate(() => window.renderPoster('/roundtrip-other.mp4', window.recoveredPoster));
  await waitForRecovered();
  await page.evaluate(() => window.renderPoster('/roundtrip.mp4'));
  await waitForRecovered();
  assert.equal(await page.evaluate(() => window.calls.filter(path => path === '/roundtrip.mp4').length), 3,
    'returning to a previously failed video must permit its newly available cover');
  assert.equal(await page.locator('video').count(), 0, 'repair must stay a passive static image');
  assert.equal(await page.evaluate(() => performance.getEntriesByType('resource').some(entry => /\.mp4(?:[?#]|$)/.test(entry.name))), false,
    'passive repair must not ask WebView to decode or fetch video bytes');
  assert.deepEqual(errors, []);
  console.log('PASS: lost cached covers rebuild once, generated conversation cover repair, cooldown/remount coalescing, one transient retry, bounded permanent failure, source-switch cleanup and failed carousel return without passive video decoding');
} finally {
  await browser?.close();
  await server.close();
}
