import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const baseline = process.env.BOWERBIRD_TEXT_BENCHMARK_BASELINE;
const trackedPaths = [
  'src/components/TextPlateEditor.tsx',
  'src/components/useRecentTextDocument.ts',
  'src/lib/textDocumentAutosave.ts',
];
const originals = baseline && new Map(trackedPaths.map(path => [path,
  execFileSync('git', ['show', `${baseline}:apps/desktop/${path}`], { cwd: root, encoding: 'utf8' }),
]));
const server = await createServer({
  root, cacheDir: '.tmp/text-document-input-benchmark-vite',
  plugins: [{ name: 'text-document-benchmark', enforce: 'pre', transform(source, id) {
    if (id.endsWith('/src/lib/documentCodec.ts')) {
      return source.replace('return writeDocumentState(serializeReadableMarkdown(value), value);', `
        const started = performance.now();
        const markdown = writeDocumentState(serializeReadableMarkdown(value), value);
        performance.measure('serializeMarkdown', { start: started, end: performance.now() });
        return markdown;
      `);
    }
    if (originals) for (const [path, baseSource] of originals) if (id.endsWith(`/${path}`)) return baseSource;
  } }],
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const probe = await page.context().newCDPSession(page);
const cpuThrottle = Number(process.env.BOWERBIRD_TEXT_BENCHMARK_CPU ?? 1);
await probe.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle });
const errors = [], requested = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => requested.push(request.url()));
await page.route('**/fixture/reference.png*', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#95b4ac"/></svg>' }));

const percent = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
try {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.serializationRequests = [];
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        if (String(url).includes('documentSerialization.worker')) {
          this.addEventListener('message', event => window.serializationRequests.push(event.data));
        }
      }
    };
  });
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/text-workspace-live/preview.html?benchmark`, { timeout: 120000 });
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await editor.locator('[data-slate-string]').first().click({ timeout: 90000 });
  assert.equal(await editor.locator('img').count(), 8);
  assert.equal(await editor.locator('table').count(), 6);
  await page.waitForFunction(() => window.draft?.markdown.includes('bowerbird-document:2:') && document.querySelector('.text-workspace-autosave.is-saved'));
  const heavyRenderer = /\/(?:equation-node(?:-static)?|code-drawing-node|excalidraw-node)\.tsx/;
  assert.ok(requested.every(url => !heavyRenderer.test(url)), 'plain editor did not request advanced block renderers');
  await page.keyboard.press('Home');
  await page.evaluate(() => {
    window.serializationRequests.length = 0;
    performance.clearMeasures('serializeMarkdown');
    const frames = [], longTasks = [];
    let last = performance.now(), frame;
    const tick = now => { frames.push(now - last); last = now; frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);
    const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(entry => entry.duration)));
    observer.observe({ type: 'longtask' });
    window.finishBenchmark = () => {
      cancelAnimationFrame(frame); observer.disconnect();
      return { frames: frames.slice(1), longTasks, mainThreadSerialization: performance.getEntriesByName('serializeMarkdown').map(entry => entry.duration) };
    };
  });
  for (let burst = 0; burst < 5; burst++) {
    await page.keyboard.type('writing a sentence here.', { delay: 18 });
    // Include the 300 ms autosave and time for the worker to deliver the result.
    await page.waitForTimeout(650);
    await page.waitForFunction(count => (window.draft?.markdown.match(/writing a sentence here\./g) ?? []).length === count, burst + 1);
  }
  const { frames, longTasks, mainThreadSerialization } = await page.evaluate(() => window.finishBenchmark());
  const requests = await page.evaluate(() => window.serializationRequests);
  const stats = {
    baseline: baseline || null, cpuThrottle, keys: 120, frames: frames.length,
    averageFps: Number((1000 * frames.length / frames.reduce((total, frame) => total + frame, 0)).toFixed(1)),
    p95Ms: Number(percent(frames, 0.95).toFixed(1)), worstMs: Number(Math.max(...frames).toFixed(1)),
    framesOver25Ms: frames.filter(ms => ms > 25).length, longTasks: longTasks.length,
    mainThreadSerializationMs: mainThreadSerialization.map(ms => Number(ms.toFixed(1))),
    serializedInWorker: requests.filter(response => typeof response.result === 'string').length,
  };
  console.log(JSON.stringify(stats, null, 2));
  assert.match(await editor.innerText(), /(?:writing a sentence here\.){5}/);
  if (!baseline) {
    assert.equal(stats.serializedInWorker, 5);
    assert.deepEqual(mainThreadSerialization, []);
    assert.ok(requests.every(response => response.result.includes('bowerbird-document:2:')));
  }
  assert.deepEqual(errors, []);
} catch (error) {
  if (errors.length) console.error(errors);
  throw error;
} finally {
  await browser.close();
  await server.close();
}
