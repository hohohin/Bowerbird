import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/connection-refresh/vite', server: { host: '127.0.0.1', port: 17953, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 840 }, reducedMotion: 'reduce' });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const image = id => page.locator(`[data-connection-entry="${id}"] img`);
const row = id => page.locator(`[data-collection-id="${id}"]`);
const previews = path => page.evaluate(path => window.requests.filter(r => r.command === 'external_files_preview' && (!path || r.args.path === path)).length, path);
try {
  await page.goto('http://127.0.0.1:17953/scripts/fixtures/connected-collections/preview.html?cold');
  await image('root-0').waitFor();
  await page.waitForFunction(() => window.previewActive === 0);
  const startup = await page.evaluate(() => ({ requests: window.requests, peak: window.previewPeak }));
  assert.ok(startup.requests.findIndex(r => r.command === 'folder_connections') < startup.requests.findIndex(r => r.command === 'refresh_folder_connections'), 'cached tree is requested before a scan');
  assert.equal(startup.requests.find(r => r.command === 'refresh_folder_connections').args.folderId, 'root');
  assert.ok(startup.peak > 0 && startup.peak <= 4, 'cold previews use bounded concurrency');
  assert.ok(await previews() < 125, 'opening the collection does not generate all previews');
  assert.equal(await previews('/fixture/second-0.png'), 0, 'offscreen collection remains cold');
  const original = await image('root-0').getAttribute('src');
  const originalCalls = await previews('/fixture/root-0.png');
  await row('child').click();
  await image('ref-one').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-collection-id="child"]')?.getAttribute('aria-selected') === 'true');
  assert.equal(await previews('/fixture/root-0.png'), originalCalls, 'references reuse the original preview');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  assert.equal(await page.evaluate(() => window.requests.filter(r => r.command === 'refresh_folder_connections').at(-1).args.folderId), 'child');
  await page.getByRole('button', { name: '刷新集合', exact: true }).click();
  assert.equal(await page.evaluate(() => window.requests.filter(r => r.command === 'refresh_folder_connections').at(-1).args.folderId), 'child');
  await row('root').click(); await image('root-0').waitFor();
  assert.equal(await previews('/fixture/root-0.png'), originalCalls, 'unchanged revisit reuses the session cache');
  await page.evaluate(original => {
    // Same file path, byte length and second-level timestamp; only the content version differs.
    window.previewByPath['/fixture/root-0.png'] = original.replace('%237b9eaa', '%23aa785b');
    for (const entry of window.entries) if (entry.asset_id === 'root-0') entry.version = '2';
    window.changed();
  }, original);
  await page.waitForFunction(original => document.querySelector('[data-connection-entry="root-0"] img')?.getAttribute('src') !== original, original);
  await image('root-0').waitFor();
  assert.equal(await previews('/fixture/root-0.png'), originalCalls + 1, 'changed content invalidates the preview even within the same timestamp second');
  await row('child').click(); await image('ref-one').waitFor();
  assert.equal(await image('ref-one').getAttribute('src'), await page.evaluate(() => window.previewByPath['/fixture/root-0.png']));
  assert.equal(await previews('/fixture/root-0.png'), originalCalls + 1, 'both references share the refreshed content');
  await page.route('**/connection-source.svg*', route => route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="${route.request().url().endsWith('4') ? 20 : 10}" height="10"><rect width="20" height="10" fill="red"/></svg>` }));
  await row('root').click();
  await page.evaluate(() => {
    const entry = window.entries.find(e => e.id === 'root-0');
    entry.asset.store_path = entry.asset.thumb_path = '/connection-source.svg'; entry.asset.ext = 'svg'; entry.version = '3'; window.changed();
  });
  await page.waitForFunction(() => document.querySelector('[data-connection-entry="root-0"] img')?.naturalWidth === 10);
  await page.evaluate(() => { window.entries.find(e => e.id === 'root-0').version = '4'; window.changed(); });
  await page.waitForFunction(() => document.querySelector('[data-connection-entry="root-0"] img')?.naturalWidth === 20);
  assert.deepEqual(errors, []);
  console.log('PASS connection refresh: cache first, active folder priority, cold viewport bounds, four workers, warm reuse, same-second content change, shared references and direct SVG invalidation');
} finally { await browser.close(); await server.close(); }
