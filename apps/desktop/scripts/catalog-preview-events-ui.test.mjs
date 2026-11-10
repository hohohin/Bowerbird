import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/catalog-preview-events/vite', server: { host: '127.0.0.1', port: 17981, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 840 }, reducedMotion: 'reduce' });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const commands = ['catalog_overview', 'catalog_page', 'list_generation_groups', 'folder_connections', 'connection_entries'];
const reads = () => page.evaluate(commands => window.requests.filter(r => commands.includes(r.command)), commands);
const image = id => page.locator(`[data-connection-entry="${id}"] img`);
const tab = () => page.getByRole('tab', { name: '文件夹', exact: true });
async function emitPreview(color) {
  await page.evaluate(color => {
    const entry = window.entries.find(item => item.id === 'root-0');
    const thumb = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180"><rect width="240" height="180" fill="${color}"/></svg>`)}`;
    for (const item of window.entries) if (item.asset_id === entry.asset_id) item.asset.thumb_path = thumb;
    window.previewChanged({ assets: [entry.asset], versions: { [entry.asset_id]: entry.version } });
  }, color);
}
try {
  await page.goto('http://127.0.0.1:17981/scripts/fixtures/connected-collections/preview.html');
  await tab().click(); await image('root-0').waitFor(); await page.waitForTimeout(200);
  const original = await image('root-0').getAttribute('src');
  const initialReads = await reads();
  await emitPreview('red');
  await page.waitForFunction(original => document.querySelector('[data-connection-entry="root-0"] img')?.getAttribute('src') !== original, original);
  await page.waitForTimeout(180);
  assert.deepEqual(await reads(), initialReads, 'preview completion patches the visible card without rereading counts/pages');

  await page.locator('[data-collection-id="child"]').click(); await image('ref-one').waitFor(); await page.waitForTimeout(120);
  const beforeReference = await reads();
  await emitPreview('blue');
  await page.waitForFunction(() => document.querySelector('[data-connection-entry="ref-one"] img')?.getAttribute('src') === window.entries.find(item => item.id === 'root-0').asset.thumb_path);
  await page.waitForTimeout(180);
  assert.deepEqual(await reads(), beforeReference, 'reference cards patch without resolving or reloading a page');

  await page.evaluate(() => window.connectionProgress({ rootId: 'root', scanning: true, error: null }));
  await page.locator('.connected-refreshing').waitFor();
  assert.deepEqual(await reads(), beforeReference, 'scan progress does not invalidate catalog data');
  await page.evaluate(() => window.setLibraryVisible(false));
  await page.locator('.catalog-virtual').waitFor({ state: 'detached' });
  await emitPreview('green');
  await page.evaluate(() => window.connectionProgress({ rootId: 'root', scanning: false, error: null }));
  const beforeReopen = await reads();
  await page.evaluate(() => window.setLibraryVisible(true)); await tab().click(); await image('root-0').waitFor();
  assert.equal(await image('root-0').getAttribute('src'), await page.evaluate(() => window.entries.find(item => item.id === 'root-0').asset.thumb_path));
  assert.equal(await page.locator('.connected-refreshing').count(), 0);
  assert.deepEqual(await reads(), beforeReopen, 'hidden previews/progress remain available without an index read');

  await page.getByRole('button', { name: '颜色筛选', exact: true }).click();
  await page.getByRole('button', { name: '红', exact: true }).click();
  await page.waitForFunction(() => window.requests.some(r => r.command === 'folder_connections' && r.args.filter.color === 'red'));
  await page.locator('[data-connection-entry="root-0"]').waitFor({ state: 'detached' });
  const beforeColor = (await reads()).length;
  await page.evaluate(() => {
    const entry = window.entries.find(item => item.id === 'root-0'); entry.color = 'red';
    window.previewChanged({ assets: [{ ...entry.asset, colors: '["#ff0000"]' }], versions: { [entry.asset_id]: entry.version } });
  });
  await image('root-0').waitFor();
  const colorReads = (await reads()).slice(beforeColor);
  assert.ok(colorReads.length > 0, 'preview colors can add newly matching members');
  assert.ok(colorReads.every(r => r.args.filter?.color === 'red'), 'only color-filtered queries revalidate');
  assert.deepEqual(errors, []);
  console.log('PASS preview events: direct card/reference updates, no list re-read, hidden cache, scan progress and color membership revalidation');
} catch (error) {
  console.error(errors, await page.evaluate(() => ({ text: document.body.innerText.slice(0, 1500), requests: window.requests.slice(-8) })));
  throw error;
} finally { await browser.close(); await server.close(); }
