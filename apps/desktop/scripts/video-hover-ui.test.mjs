import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const directory = '.tmp/video-hover';
await mkdir(directory, { recursive: true });
const ffmpeg = process.env.BOWERBIRD_FFMPEG_BINARY || resolve('../../.tmp/video-integration/tools/local/ffmpeg.exe');
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=teal:s=180x320:r=25:d=2',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', `${directory}/portrait.mp4`]);
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: `${directory}/vite`,
  esbuild: { jsx: 'automatic' }, optimizeDeps: { entries: [], include: ['react', 'react-dom/client', 'react/jsx-runtime'] },
  server: { host: '127.0.0.1', port: 1764, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
const errors = [], requests = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (request.url().includes('portrait.mp4')) requests.push(request.url()); });
try {
  await page.route('**/video-hover-test', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('http://127.0.0.1:1764/video-hover-test');
  await page.evaluate(async () => {
    window.__TAURI_INTERNALS__ = { convertFileSrc: path => path, invoke: async () => null };
    const [{ default: React }, { default: { createRoot } }, { FileMediaCard }] = await Promise.all([
      import('/.tmp/video-hover/vite/deps/react.js'), import('/.tmp/video-hover/vite/deps/react-dom_client.js'),
      import('/src/components/FileMediaCard.tsx'), import('/src/components/LocalFileWorkspace.css'),
    ]);
    const poster = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="320"><rect width="180" height="320" fill="teal"/></svg>');
    const root = createRoot(document.getElementById('root'));
    window.renderCards = (multiple = false, selected = false, version = '1') => root.render(React.createElement(React.StrictMode, null,
      React.createElement('div', { className: 'card-surface', style: { height: 2000 } }, [0, 1].map(index => React.createElement(FileMediaCard, {
        key: index, entry: { path: '/.tmp/video-hover/portrait.mp4', name: `portrait-${index}.mp4`, directory: false, preview: poster, version },
        selected, revision: 1, labels: [], duration: index ? null : 62.4, aspectRatio: 180 / 320,
        style: { top: 30, left: 30 + index * 240, width: 180 }, onSelect() {}, onActivate: multiple ? undefined : () => {}, onOpen() {}, onContextMenu() {}, onDragStart() {},
      })))));
    window.renderCards();
  });
  const first = page.getByRole('button', { name: 'portrait-0.mp4', exact: true });
  const second = page.getByRole('button', { name: 'portrait-1.mp4', exact: true });
  await first.waitFor();
  await page.waitForTimeout(600);
  assert.equal(await page.locator('video').count(), 0);
  assert.equal(requests.length, 0, 'passive cards never request the original video');
  assert.equal(await first.locator('.folder-media-duration').textContent({ timeout: 2000 }), '1:02');
  assert.equal(await second.locator('.folder-media-duration').count(), 0, 'unknown duration is not zero');
  await first.hover(); await page.waitForTimeout(180); await page.mouse.move(900, 700); await page.waitForTimeout(450);
  assert.equal(requests.length, 0, 'passing over a card must not load its video');
  await first.hover(); await page.waitForTimeout(250);
  assert.equal(await page.locator('video').count(), 0, 'delay must elapse before creating a decoder');
  await page.waitForFunction(() => document.querySelector('.folder-media-card video')?.currentTime > 0.05);
  const state = await first.locator('video').evaluate(video => ({ muted: video.muted, volume: video.volume, paused: video.paused,
    width: video.videoWidth, height: video.videoHeight, fit: getComputedStyle(video).objectFit }));
  assert.equal(state.muted, true); assert.equal(state.paused, false); assert.equal(state.fit, 'contain');
  assert.deepEqual([state.width, state.height], [180, 320]);
  await page.screenshot({ path: `${directory}/portrait-preview.png` });
  await first.locator('video').evaluate(video => { window.previousPreview = video; });
  // A second surface can enter before the first receives leave (portal/reflow).
  await second.dispatchEvent('pointerenter', { pointerType: 'mouse' });
  await page.waitForFunction(() => document.querySelectorAll('.folder-media-card')[1].querySelector('video')?.currentTime > 0.05);
  assert.equal(await page.locator('video').count(), 1, 'only one hover decoder exists across cards');
  assert.deepEqual(await page.evaluate(() => ({ paused: window.previousPreview.paused, src: window.previousPreview.getAttribute('src') })), { paused: true, src: null });
  await second.dispatchEvent('pointerleave', { pointerType: 'mouse' }); await page.mouse.move(900, 700);
  assert.equal(await page.locator('video').count(), 0, 'pointer leave immediately releases the decoder');

  async function playing() { await first.hover(); await page.waitForFunction(() => document.querySelector('.folder-media-card video')?.currentTime > 0.05); }
  await playing(); await first.dispatchEvent('dragstart');
  assert.equal(await page.locator('video').count(), 0, 'dragging releases preview');
  await page.mouse.move(900, 700); await playing(); await page.mouse.wheel(0, 700);
  await page.waitForFunction(() => !document.querySelector('.folder-media-card video'));
  await page.evaluate(() => window.scrollTo(0, 0)); await page.mouse.move(900, 700); await playing();
  await page.evaluate(() => { const modal = document.createElement('div'); modal.id = 'test-modal'; modal.setAttribute('aria-modal', 'true'); document.body.append(modal); });
  await page.waitForFunction(() => !document.querySelector('.folder-media-card video'));
  await page.evaluate(() => document.getElementById('test-modal').remove());
  await page.mouse.move(900, 700); await playing();
  await page.evaluate(() => document.querySelector('.card-surface').style.display = 'none');
  await page.waitForFunction(() => !document.querySelector('.folder-media-card video'));
  await page.evaluate(() => document.querySelector('.card-surface').style.display = '');
  await page.mouse.move(900, 700); await playing();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert.equal(await page.locator('video').count(), 0);

  for (const [multiple, selected] of [[true, false], [false, true]]) {
    await page.mouse.move(900, 700); await page.evaluate(([multiple, selected]) => window.renderCards(multiple, selected), [multiple, selected]);
    await first.hover(); await page.waitForTimeout(600);
    assert.equal(await page.locator('video').count(), 0, 'selection mode and selected cards stay static');
  }
  await page.evaluate(() => window.renderCards()); await page.mouse.move(900, 700);
  await page.emulateMedia({ reducedMotion: 'reduce' }); await first.hover(); await page.waitForTimeout(600);
  assert.equal(await page.locator('video').count(), 0, 'reduced motion keeps static posters');
  await page.emulateMedia({ reducedMotion: 'no-preference' }); await page.mouse.move(900, 700); await playing();
  await page.evaluate(() => window.renderCards(false, false, '2'));
  await page.waitForFunction(() => !document.querySelector('.folder-media-card video'));
  await page.mouse.move(900, 700); await playing();
  assert.ok((await first.locator('video').getAttribute('src')).includes('preview=2'), 'changed originals use a new media source');
  await page.mouse.down();
  assert.equal(await page.locator('video').count(), 0, 'opening a full preview cannot retain a hover decoder');
  await page.mouse.up();
  await page.mouse.move(900, 700);
  await page.route('**/portrait.mp4?preview=broken', route => route.abort());
  await page.evaluate(() => window.renderCards(false, false, 'broken')); await first.hover();
  await page.waitForTimeout(1000);
  assert.equal(await page.locator('video').count(), 0, 'unreadable hover media releases the failed decoder and leaves its poster');
  assert.equal(await first.locator('img').count(), 1);
  await page.mouse.move(900, 700); await first.hover(); await page.waitForTimeout(100);
  await page.evaluate(() => window.renderCards(true)); await page.waitForTimeout(500);
  assert.equal(await page.locator('video').count(), 0, 'selection cancels an already pending hover');
  assert.deepEqual(errors, []);
  console.log('PASS: passive zero requests, delayed silent portrait preview, one decoder, pointer/drag/scroll/hidden/modal cleanup, selection and reduced motion, version refresh');
} finally { await browser.close(); await server.close(); }
