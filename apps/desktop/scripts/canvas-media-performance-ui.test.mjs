import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const baseline = process.argv.includes('--before');
const tiersOnly = process.argv.includes('--tiers-only');
const root = process.cwd();
const frozen = path.join(root, '.tmp/canvas-media-performance-before/src');
const live = path.join(root, 'src');
const out = '.tmp/canvas-media-performance';
await mkdir(out, { recursive: true });
const slash = value => value.replaceAll('\\', '/');
const server = await createServer({ configFile: false, root, plugins: baseline ? [{
  name: 'frozen-media-baseline', enforce: 'pre',
  resolveId(source, importer) {
    if (!importer || !source.startsWith('.')) return;
    const target = path.resolve(path.dirname(importer.split('?')[0]), source);
    if (target.startsWith(live + path.sep)) return this.resolve(slash(path.join(frozen, path.relative(live, target))), importer, { skipSelf: true });
    if (target.startsWith(path.dirname(frozen) + path.sep) && !target.startsWith(frozen + path.sep)) return this.resolve(slash(path.join(root, path.relative(path.dirname(frozen), target))), importer, { skipSelf: true });
  },
}] : [], server: { host: '127.0.0.1', port: 1627, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });

// Small compressed fixtures still have real raster dimensions and partial alpha.
function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const label = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([label, data])));
  return Buffer.concat([length, label, data, crc]);
}
const rasters = new Map();
function png(width) {
  if (rasters.has(width)) return rasters.get(width);
  const height = width / 2, header = Buffer.alloc(13), row = Buffer.alloc(1 + width * 4);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  for (let x = 0; x < width; x++) { const offset = 1 + x * 4; row[offset] = 30; row[offset + 1] = 140; row[offset + 2] = 220; row[offset + 3] = x < width / 4 ? 0 : 128; }
  const raw = Buffer.alloc(row.length * height); for (let y = 0; y < height; y++) row.copy(raw, y * row.length);
  const bytes = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  rasters.set(width, bytes); return bytes;
}
for (const size of [512, 1024, 2048, 4096]) png(size);
const records = [];
let displayPixelRatioEvents = [];
let timelineVisibilityMode = null;
async function open(scenario) {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1200 }, deviceScaleFactor: 1 });
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/__canvas_perf__/**', async route => {
    const url = new URL(route.request().url()); requests.push(url.pathname);
    if (url.pathname.endsWith('.mp4')) return route.fulfill({ status: 404, body: 'Synthetic fixture: playback bytes are intentionally absent.' });
    const size = Number(url.pathname.match(/\/(?:preview|poster)\/(\d+)\//)?.[1] || 4096);
    await route.fulfill({ contentType: 'image/png', body: png(size) });
  });
  await page.goto(`http://127.0.0.1:1627/scripts/fixtures/canvas-media-performance/preview.html?scenario=${scenario}`);
  await page.locator('[data-canvas-node-id="perf-node-0"]').waitFor();
  await page.waitForTimeout(1800);
  return { page, errors, requests };
}
async function measure(page) {
  return page.evaluate(async () => {
    const stage = document.querySelector('.canvas-stage');
    if (!stage) throw new Error('Canvas stage is absent');
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const samples = [];
    for (const kind of ['pan', 'zoom']) {
      const values = []; let previous = await frame();
      for (let index = 0; index < 70; index++) {
        stage.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
          clientX: 900, clientY: 500, ctrlKey: kind === 'zoom', deltaX: kind === 'pan' ? (index % 2 ? -6 : 6) : 0,
          deltaY: kind === 'zoom' ? (index % 2 ? -8 : 8) : 0 }));
        const now = await frame(); if (index > 4) values.push(now - previous); previous = now;
      }
      values.sort((a,b) => a-b);
      samples.push({ kind, p95Ms: values[Math.floor(values.length * .95)], maxMs: values.at(-1), samples: values.length });
    }
    const images = [...stage.querySelectorAll('img')].filter(image => image.complete && image.naturalWidth > 0 && image.currentSrc.includes('/__canvas_perf__/'));
    const unique = new Map(images.map(image => [image.currentSrc, image.naturalWidth * image.naturalHeight]));
    return { samples, mountedNodes: stage.querySelectorAll('[data-canvas-node-id]').length,
      loadedMediaElements: images.length, uniqueLoadedMediaSources: unique.size,
      decodedPixelProxy: [...unique.values()].reduce((sum, pixels) => sum + pixels, 0),
      posterRequests: window.mediaCalls.filter(call => call.command === 'video_poster').length,
      offscreenPosterRequests: window.mediaCalls.filter(call => call.command === 'video_poster' && Number(call.args.sourcePath.match(/\/(\d+)\.mp4$/)?.[1]) >= 30).length,
      previewRequests: window.mediaCalls.filter(call => call.command === 'canvas_image_preview').length,
      previewSizes: [...new Set(window.mediaCalls.filter(call => call.command === 'canvas_image_preview').map(call => call.args.maxSize))],
      edgeCount: stage.querySelectorAll('.canvas-graph-edges path').length,
      offscreenCardPresent: !!stage.querySelector('[data-canvas-node-id="perf-node-329"]'),
    };
  });
}
try {
  for (const scenario of tiersOnly ? [] : ['images', 'videos', 'mixed']) {
    const { page, errors, requests } = await open(scenario);
    const beforeGeometry = await page.evaluate(() => ({ nodes: window.snapshot().nodes,
      edges: [...document.querySelectorAll('.canvas-graph-edges path')].map(edge => edge.getAttribute('d')) }));
    const result = await measure(page);
    assert.deepEqual(await page.evaluate(() => ({ nodes: window.snapshot().nodes,
      edges: [...document.querySelectorAll('.canvas-graph-edges path')].map(edge => edge.getAttribute('d')) })), beforeGeometry,
    'Pan/zoom and media loading preserve persisted geometry and board-space wire endpoints');
    assert.equal(result.mountedNodes, 330, 'Visibility gates media, never card geometry');
    assert.equal(result.offscreenCardPresent, true);
    assert.equal(result.edgeCount, 9);
    if (!baseline) {
      assert.equal(result.offscreenPosterRequests, 0, 'Offscreen videos must not extract posters');
      if (scenario !== 'videos') {
        assert.ok(result.previewRequests > 0, 'Visible images request bounded raster previews');
        assert.ok(requests.every(url => !url.startsWith('/__canvas_perf__/original/')), 'Canvas uses previews before explicit original viewing');
      }
    }
    assert.deepEqual(errors, []);
    records.push({ scenario, ...result, imageHttpRequests: requests.filter(url => url.endsWith('.png')).length });
    if (!baseline && scenario === 'mixed') {
      const timelineButton = page.locator('button[aria-label="时间线视图"]');
      const useViewButton = await timelineButton.isVisible();
      timelineVisibilityMode = useViewButton ? 'real view controls' : 'stage class contract (view controls hidden)';
      if (useViewButton) await timelineButton.click();
      else await page.locator('.canvas-stage').evaluate(stage => stage.classList.add('is-view-hidden'));
      await page.waitForFunction(() => [...document.querySelectorAll('.canvas-stage img')].every(image => !image.src.includes('/__canvas_perf__/')));
      assert.equal(await page.locator('.canvas-stage [data-canvas-node-id]').count(), 330, 'Hidden view retains card geometry');
      assert.equal(await page.locator('.canvas-graph-edges path').count(), 9);
      assert.deepEqual(await page.evaluate(() => window.snapshot().nodes), beforeGeometry.nodes);
      if (useViewButton) await page.locator('button[aria-label="画板视图"]').click();
      else await page.locator('.canvas-stage').evaluate(stage => stage.classList.remove('is-view-hidden'));
      await page.waitForFunction(() => [0, 1].every(index => document.querySelector(`[data-canvas-node-id="perf-node-${index}"] > img`)?.src.includes('/__canvas_perf__/')));
      await page.evaluate(() => document.querySelector('.canvas-stage').dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, deltaX: 20000, deltaY: 20000,
      })));
      await page.waitForFunction(() => window.mediaCalls.some(call => call.command === 'canvas_image_preview' && call.args.path.endsWith('/40.png')));
      await page.waitForFunction(() => window.mediaCalls.some(call => call.command === 'video_poster' && call.args.sourcePath.endsWith('/41.mp4')));
      await page.waitForFunction(() => document.querySelector('[data-canvas-node-id="perf-node-0"] > img')?.getAttribute('data-canvas-media-loaded') === 'false');
      assert.equal(await page.locator('[data-canvas-node-id]').count(), 330);
      assert.equal(await page.locator('.canvas-graph-edges path').count(), 9);
      assert.deepEqual(await page.evaluate(() => window.snapshot().nodes), beforeGeometry.nodes);
    }
    await page.close();
  }
  if (!baseline) {
    const { page, errors } = await open('tiers');
    const card = page.locator('[data-canvas-node-id="perf-node-0"]');
    const image = card.locator(':scope > img');
    await page.waitForFunction(() => document.querySelector('[data-canvas-node-id="perf-node-0"] > img')?.naturalWidth === 512);
    const alpha = await image.evaluate(image => {
      const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 8;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, 16, 8);
      return [context.getImageData(0, 0, 1, 1).data[3], context.getImageData(8, 4, 1, 1).data[3]];
    });
    assert.deepEqual(alpha, [0, 128], 'Mock preview preserves transparent and partially transparent pixels');
    await page.evaluate(() => {
      window.dprEvents = [];
      for (const dpr of [1, 2]) window.matchMedia(`(resolution: ${dpr}dppx)`).addEventListener('change', event => window.dprEvents.push({ dpr, matches: event.matches, current: window.devicePixelRatio }));
      window.addEventListener('resize', () => window.dprEvents.push({ resize: true, current: window.devicePixelRatio }));
    });
    const display = await page.context().newCDPSession(page);
    for (const [deviceScaleFactor, width] of [[2, 1024], [1, 512]]) {
      // CDP's same-size DPR override changes the property without dispatching
      // resolution/resize events. A real viewport change exercises the browser's
      // resize notification; this is DPR + resize coverage, not an OS monitor test.
      await display.send('Emulation.setDeviceMetricsOverride', { width: deviceScaleFactor === 2 ? 1801 : 1800, height: 1200, deviceScaleFactor, mobile: false });
      await page.waitForFunction(dpr => window.devicePixelRatio === dpr && window.dprEvents.some(event => event.current === dpr), deviceScaleFactor);
      await page.waitForFunction(width => document.querySelector('[data-canvas-node-id="perf-node-0"] > img')?.naturalWidth === width, width);
    }
    displayPixelRatioEvents = await page.evaluate(() => window.dprEvents);
    await display.detach();
    for (const [ratio, width] of [[2, 1024], [2.2, 2048]]) {
      const bounds = await card.boundingBox();
      await page.evaluate(({ ratio, x, y }) => document.querySelector('.canvas-stage').dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, ctrlKey: true, clientX: x, clientY: y, deltaY: -Math.log(ratio) / .0015,
      })), { ratio, x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
      await page.waitForFunction(width => document.querySelector('[data-canvas-node-id="perf-node-0"] > img')?.naturalWidth === width, width);
    }
    assert.deepEqual(await page.evaluate(() => [...new Set(window.mediaCalls.filter(call => call.command === 'canvas_image_preview').map(call => call.args.maxSize))]), [512, 1024, 2048]);
    await card.focus(); await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: /媒体预览/ }); await dialog.waitFor();
    assert.equal(await dialog.locator('img').getAttribute('src'), '/__canvas_perf__/original/0.png', 'Explicit viewer uses the original image');
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);
    await page.close();
  }
  const report = { mode: baseline ? 'before' : 'after', measuredAt: new Date().toISOString(), environment: 'Chrome headless; Vite development; synthetic IPC and compressed PNG fixtures; 1800x1200 DPR1',
    limitations: 'Decoded pixels count unique loaded img sources; this is a memory proxy, not process/GPU memory. Frame intervals include headless scheduling and development overhead; compare trends only, not native WebView2 FPS.',
    checks: baseline ? ['330 mounted cards', '9 unchanged board-space edges'] : [...(tiersOnly ? [] : ['330 mounted cards', '9 unchanged board-space edges', 'zero offscreen poster extraction', 'visible-after-pan media loads', 'offscreen image source released', 'hidden timeline view releases media and canvas view restores it']), '512/1024/2048 upgrade', 'DPR upgrade/downgrade with real browser resize notification (CDP)', 'mock alpha 0/128 preserved', 'original image viewer'],
    canvasWorkspaceSha256: createHash('sha256').update(await readFile(path.join(baseline ? frozen : live, 'components/CanvasWorkspace.tsx'))).digest('hex'), displayPixelRatioEvents, timelineVisibilityMode, records };
  await writeFile(`${out}/${baseline ? 'before' : tiersOnly ? 'after-tiers' : 'after'}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); await server.close(); }
