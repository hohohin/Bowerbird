import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/catalog-cache/vite', server: { host: '127.0.0.1', port: 17979, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 840 }, reducedMotion: 'reduce' });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const commands = ['catalog_overview', 'catalog_page', 'list_generation_groups', 'folder_connections', 'connection_entries'];
const reads = () => page.evaluate(commands => window.requests.filter(r => commands.includes(r.command)), commands);
const hide = async () => { await page.evaluate(() => window.setLibraryVisible(false)); await page.locator('.catalog-virtual').waitFor({ state: 'detached' }); };
const hold = () => page.evaluate(() => { window.catalogGate = new Promise(resolve => { window.releaseCatalog = () => { window.catalogGate = null; resolve(); }; }); });
const paint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function show(kind) {
  await page.evaluate(() => window.setLibraryVisible(true));
  if (kind === 'folders') await page.getByRole('tab', { name: '文件夹', exact: true }).click();
}
try {
  await page.addInitScript(() => { window.total = 120; });
  for (const kind of ['all', 'tags', 'folders']) {
    await page.goto(`http://127.0.0.1:17979/scripts/fixtures/${kind === 'folders' ? 'connected-collections' : 'catalog-paging'}/preview.html`);
    if (kind === 'tags') await page.evaluate(() => window.changeKind('tags'));
    if (kind === 'folders') await page.getByRole('tab', { name: '文件夹', exact: true }).click();
    const card = page.locator(kind === 'folders' ? '[data-connection-entry="root-0"]' : '[data-asset-id="asset-0"]').first();
    await card.waitFor();
    await page.waitForTimeout(300);
    const before = await reads();
    await hide(); await hold();
    await show(kind);
    await card.waitFor({ timeout: 3000 }); await paint();
    assert.deepEqual(await reads(), before, `${kind}: reopening with fresh snapshots must not re-read the list, counts or groups`);
    assert.equal(await page.getByText('正在读取素材…', { exact: true }).count(), 0);
    await page.evaluate(() => window.releaseCatalog());

    if (kind === 'folders') {
      const beforeSplit = await reads();
      await page.getByRole('button', { name: '向右分栏', exact: true }).click();
      await page.locator('[data-connection-entry="root-0"]').nth(1).waitFor();
      await paint();
      assert.deepEqual(await reads(), beforeSplit, 'a second pane shares folder counts, pages and groups');
      await page.getByRole('button', { name: '关闭此栏', exact: true }).last().click();
    }

    // Invalidate while no library is mounted, then stall native reads. Old cards
    // must remain usable until the new snapshot arrives, without missing changes.
    await hide();
    await page.evaluate(kind => {
      if (kind === 'folders') {
        const entry = window.entries.find(item => item.id === 'root-0');
        entry.name = entry.asset.name = '更新后的素材.png'; window.changed();
      } else {
        window.assetDimensions = i => i === 0 ? { name: '更新后的素材.png' } : {};
        window.refresh();
      }
    }, kind);
    await hold();
    await show(kind);
    await card.waitFor({ timeout: 3000 });
    await page.waitForFunction(({ commands, count }) => window.requests.filter(r => commands.includes(r.command)).length > count, { commands, count: before.length });
    assert.ok((await reads()).length > before.length, `${kind}: hidden change triggers revalidation`);
    assert.equal(await page.getByText('正在读取素材…', { exact: true }).count(), 0);
    await page.evaluate(() => window.releaseCatalog());
    await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('aria-label') === '更新后的素材.png', kind === 'folders' ? '[data-connection-entry="root-0"] [data-asset-id]' : '[data-asset-id="asset-0"]');
    console.log(`PASS ${kind}: immediate reopen, no duplicate reads, hidden changes, cached cards during delayed revalidation`);
  }
  assert.deepEqual(errors, []);
} catch (error) {
  console.error('browser errors', errors);
  console.error(await page.evaluate(() => ({ text: document.body.innerText.slice(0, 2000), requests: window.requests?.slice(-10) })));
  throw error;
} finally { await browser.close(); await server.close(); }
