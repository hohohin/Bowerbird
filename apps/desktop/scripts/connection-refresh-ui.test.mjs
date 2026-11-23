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
const pageReads = folder => page.evaluate(folderId => window.requests.filter(r => r.command === 'connection_entries' && r.args.folderId === folderId).length, folder);
const overview = () => page.getByRole('button', { name: '全部文件夹素材', exact: true }).click();
const paint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const interactionCounts = () => page.evaluate(() => ({
  observers: window.observersCreated,
  previews: window.requests.filter(r => r.command === 'external_files_preview').length,
  verified: window.requests.filter(r => r.command === 'resolve_connection_entries' && r.args.verifyOriginals !== false).length,
  indexed: window.requests.filter(r => r.command === 'resolve_connection_entries' && r.args.verifyOriginals === false).length,
}));
try {
  await page.goto('http://127.0.0.1:17953/scripts/fixtures/connected-collections/preview.html?cold');
  await overview();
  await image('root-0').waitFor();
  await page.waitForFunction(() => window.previewActive === 0);
  const startup = await page.evaluate(() => ({ requests: window.requests, peak: window.previewPeak }));
  assert.ok(startup.requests.some(r => r.command === 'folder_connections'), 'opening reads the existing folder index');
  assert.equal(startup.requests.filter(r => r.command === 'refresh_folder_connections').length, 0, 'opening a folder view must not start a full scan');
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
  assert.equal(await page.evaluate(() => window.requests.filter(r => r.command === 'refresh_folder_connections').length), 0, 'window focus must not start a full scan');
  await page.getByRole('button', { name: '刷新文件夹', exact: true }).click();
  assert.equal(await page.evaluate(() => window.requests.filter(r => r.command === 'refresh_folder_connections').at(-1).args.folderId), 'child');
  assert.equal(await page.evaluate(() => window.requests.filter(r => r.command === 'refresh_folder_connections').at(-1).args.force), true, 'manual refresh bypasses the cooldown');
  assert.equal(await page.evaluate(() => window.requests.filter(r => r.command === 'refresh_folder_connections').length), 1);
  await page.evaluate(() => window.setLibraryVisible(false));
  await page.locator('.catalog-virtual').waitFor({ state: 'detached' });
  // Cross both the former 30s automatic-check window and the 60s list TTL.
  await page.clock.setFixedTime(new Date(Date.now() + 90_000));
  await page.evaluate(() => window.setLibraryVisible(true));
  await overview();
  await image('root-0').waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => window.requests.filter(r => r.command === 'refresh_folder_connections').length), 1, 'reopening after 90s and focusing reuse the index');
  await row('root').click(); await image('root-0').waitFor();
  assert.equal(await previews('/fixture/root-0.png'), originalCalls, 'unchanged revisit reuses the session cache');
  await page.evaluate(original => {
    // Same file path, byte length and second-level timestamp; only the content version differs.
    window.previewByPath['/fixture/root-0.png'] = original.replace('%237b9eaa', '%23aa785b');
    for (const entry of window.entries) if (entry.asset_id === 'root-0') { entry.version = '2'; entry.asset.thumb_path = null; }
    window.changed();
  }, original);
  await page.waitForFunction(() => document.querySelector('[data-connection-entry="root-0"] img')?.getAttribute('src') === window.previewByPath['/fixture/root-0.png']);
  assert.equal(await previews('/fixture/root-0.png'), originalCalls + 1, 'changed content invalidates the preview even within the same timestamp second');
  await row('child').click(); await image('ref-one').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-connection-entry="ref-one"] img')?.getAttribute('src') === window.previewByPath['/fixture/root-0.png']);
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

  await page.goto('http://127.0.0.1:17953/scripts/fixtures/connected-collections/preview.html');
  await row('second').waitFor();
  await page.evaluate(() => {
    const promise = new Promise(resolve => { window.releasePage = resolve; });
    window.pageGate = { folderId: 'second', promise };
  });
  await row('second').click();
  await page.waitForFunction(() => window.requests.some(r => r.command === 'connection_entries' && r.args.folderId === 'second'));
  for (let i = 0; i < 3; i++) {
    await page.evaluate(i => {
      window.entries.find(entry => entry.id === 'root-0').name = `root-0 (v${i + 2}).png`;
      window.changed({ rootIds: ['root'], folderIds: ['root'] });
    }, i);
    await page.waitForTimeout(160);
  }
  await page.evaluate(() => { window.pageGate = null; window.releasePage(); });
  await image('second-0').waitFor();
  const inFlightReads = await pageReads('second');
  await row('child').click();
  await image('ref-one').waitFor();
  const siblingReadsBefore = await pageReads('child');
  await page.evaluate(() => {
    window.folders.find(folder => folder.id === 'root').name = '更新后的目录';
    window.changed({ rootIds: ['root'], folderIds: ['root'] });
  });
  await page.getByRole('treeitem', { name: '更新后的目录' }).waitFor();
  await page.waitForTimeout(160);
  const siblingReads = await pageReads('child') - siblingReadsBefore;
  await row('second').click();
  await image('second-0').waitFor();
  await page.waitForTimeout(160);
  const reopenedReads = await pageReads('second') - inFlightReads;
  console.log(`Scoped scan IPC: ${inFlightReads} reads for an in-flight page, ${siblingReads} extra sibling page reads, ${reopenedReads} extra reads revisiting another root`);
  assert.equal(inFlightReads, 1);
  assert.equal(siblingReads, 0);
  assert.equal(reopenedReads, 0);
  await page.evaluate(() => {
    const entry = window.entries.find(item => item.id === 'second-0');
    entry.name = entry.asset.name = '本目录更新.png';
    window.changed({ folderIds: ['second'] });
  });
  await page.locator('[data-connection-entry="second-0"] [aria-label="本目录更新.png"]').waitFor();
  assert.equal(await pageReads('second'), inFlightReads + 1, 'an exact scope still reloads its own changed page');

  await page.addInitScript(() => {
    window.observersCreated = 0;
    window.observerOptions = [];
    const Original = window.IntersectionObserver;
    window.IntersectionObserver = class extends Original {
      constructor(callback, options) {
        super(callback, options); window.observersCreated++; window.observerOptions.push({ root: options?.root, margin: this.rootMargin });
      }
    };
  });
  await page.goto('http://127.0.0.1:17953/scripts/fixtures/connected-collections/preview.html?cold');
  await row('root').waitFor();
  await page.waitForTimeout(400);
  const before = await interactionCounts();
  await row('root').click();
  await image('root-0').waitFor();
  await page.waitForTimeout(1000);
  const visibleCards = await interactionCounts();
  assert.deepEqual(await page.evaluate(() => window.observerOptions.filter(({ root }) => root === document.querySelector('.connected-collections .library-scroller')).map(({ margin }) => margin).sort()),
    ['0px 0px 0px 0px', '400px 400px 400px 400px'], 'visual folder cards share the visible and prefetch observers for the scroll viewport');
  await page.evaluate(() => { window.previousCatalog = document.querySelector('.connected-collections .catalog-virtual'); });
  const card = page.locator('[data-connection-entry="root-0"] button[data-asset-id]');
  await card.click({ modifiers: ['Control'] });
  await page.getByRole('button', { name: '取消选择', exact: true }).waitFor();
  await paint();
  const checked = await interactionCounts();
  assert.equal(checked.verified, visibleCards.verified, 'click selection performs no original verification');
  assert.equal(checked.indexed, visibleCards.indexed, 'a loaded selection needs no index read either');
  await page.evaluate(() => {
    const bridge = window.__TAURI_INTERNALS__, invoke = bridge.invoke;
    const gate = new Promise(resolve => { window.releaseSelection = () => { bridge.invoke = invoke; resolve(); }; });
    bridge.invoke = (command, args) => {
      const response = invoke(command, args);
      return command === 'resolve_connection_entries' && args.verifyOriginals === false ? gate.then(() => response) : response;
    };
  });
  await page.getByRole('button', { name: '全选', exact: true }).click();
  await page.waitForFunction(count => window.requests.filter(r => r.command === 'resolve_connection_entries' && r.args.verifyOriginals === false).length > count, checked.indexed);
  assert.equal(await card.evaluate(element => {
    const event = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
    return !element.dispatchEvent(event) && !event.dataTransfer.getData('text/plain');
  }), true, 'drag waits for the entire selection to resolve from the index');
  await page.evaluate(() => window.releaseSelection());
  assert.equal((await interactionCounts()).verified, checked.verified, 'unloaded selection IDs use indexed availability only');
  await page.getByRole('button', { name: '取消选择', exact: true }).click();
  const scroller = page.locator('.connected-collections .catalog-scroller');
  await scroller.evaluate(element => { element.scrollTop = 440; });
  await paint();
  const rootTop = await scroller.evaluate(element => element.scrollTop);
  assert.ok(rootTop > 0);

  const status = page.locator('.connected-collections .connected-status');
  await page.evaluate(() => window.connectionProgress({ rootId: 'root', folderId: 'child', scanning: true, error: null }));
  await status.filter({ hasText: '后台正在同步「风景」' }).waitFor();
  await row('child').click();
  await image('ref-one').waitFor();
  await status.filter({ hasText: '正在读取「风景」' }).waitFor();
  const keptCatalog = await page.evaluate(() => window.previousCatalog === document.querySelector('.connected-collections .catalog-virtual'));
  assert.equal(keptCatalog, true, 'folder switches keep the virtual catalog mounted');
  await page.evaluate(() => window.connectionProgress({ rootId: 'root', folderId: 'child', scanning: false, error: null }));
  await status.waitFor({ state: 'detached' });
  await row('root').click();
  await paint();
  assert.ok(Math.abs(await scroller.evaluate(element => element.scrollTop) - rootTop) < 2, 'folder switches restore that folder’s scroll position');
  await scroller.evaluate(element => { element.scrollTop = 0; });
  await paint();
  await page.evaluate(() => {
    window.connectionProgress({ rootId: 'root', scanning: true, error: null });
    window.connectionProgress({ rootId: 'root', activeFolderId: 'child', scanning: true, error: null });
  });
  await status.filter({ hasText: '后台正在同步「风景」' }).waitFor();
  await page.evaluate(() => window.connectionProgress({ rootId: 'root', activeFolderId: 'root', scanning: true, error: null }));
  await status.filter({ hasText: '正在读取「素材目录」' }).waitFor();
  await page.evaluate(() => window.connectionProgress({ rootId: 'root', scanning: false, error: null }));
  await status.waitFor({ state: 'detached' });
  console.log(`Interaction IPC: ${visibleCards.observers - before.observers} new observer instances, ${visibleCards.previews - before.previews} cold preview reads, ${checked.verified - visibleCards.verified} verified loaded-selection reads; catalog retained on switch`);
  assert.deepEqual(errors, []);
  console.log('PASS connection refresh: open/focus never scan, manual folder refresh, bounded previews, same-second content change, shared references, SVG and scoped scans');
} finally { await browser.close(); await server.close(); }
