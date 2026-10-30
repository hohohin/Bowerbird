import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/connected-collections/vite', server: { host: '127.0.0.1', port: 17951, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 840 }, reducedMotion: 'reduce' });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const row = id => page.locator(`[data-collection-id="${id}"]`);
const card = id => page.locator(`[data-connection-entry="${id}"] .folder-media-card`);
const active = async id => page.waitForFunction(id => document.querySelector(`[data-collection-id="${id}"]`)?.getAttribute('aria-selected') === 'true', id);
const menu = name => page.getByRole('menuitem', { name, exact: true });
const dialog = () => page.getByRole('dialog');
async function navigate(id) { await row(id).click(); await active(id); await page.waitForTimeout(120); }
async function context(id) { await card(id).click({ button: 'right' }); await page.getByRole('menu').waitFor(); }
try {
  await mkdir('.tmp/connected-collections', { recursive: true });
  await page.goto('http://127.0.0.1:17951/scripts/fixtures/connected-collections/preview.html');
  await card('root-0').waitFor();
  assert.deepEqual(await page.locator('[data-catalog-section]').evaluateAll(items => items.map(item => item.dataset.catalogSection)), ['root', 'child', 'nested', 'empty', 'second', 'offline']);
  assert.equal(await page.getByText(/父集合|子集合|全部展开/).count(), 0);
  const plus = row('child').getByRole('button', { name: /新建集合/ });
  assert.equal(await plus.evaluate(el => getComputedStyle(el.parentElement).opacity), '1');
  assert.ok((await page.evaluate(() => window.requests.filter(r => r.command === 'connection_entries'))).every(r => r.args.limit <= 60));
  assert.ok(await page.locator('[data-connection-entry]').count() < 125);
  await navigate('child');
  await page.locator('.catalog-scroller').evaluate(el => { el.scrollTop += 40; });
  await page.waitForFunction(() => document.querySelector('.catalog-section-heading.is-pinned .catalog-section-title')?.textContent === '风景');
  await card('ref-one').click({ modifiers: ['Control'] }); await card('ref-two').click({ modifiers: ['Control'] });
  assert.equal(await card('ref-one').getAttribute('aria-pressed'), 'true'); assert.equal(await card('ref-two').getAttribute('aria-pressed'), 'true');
  assert.equal(await card('child-0').getAttribute('aria-pressed'), 'false');
  await page.locator('.connected-selection').getByRole('button', { name: '添加到集合', exact: true }).click();
  await dialog().getByText('另一目录', { exact: true }).click(); await dialog().getByRole('button', { name: '添加', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.requests.find(r => r.command === 'create_material_references').args), { assetIds: ['root-0'], folderId: 'second' });
  await context('ref-one'); await menu('重命名分身').click(); await dialog().getByRole('textbox').fill('新分身'); await dialog().getByRole('button', { name: '重命名分身', exact: true }).click();
  assert.equal(await page.evaluate(() => window.entries.find(e => e.id === 'root-0').name), 'root-0.png');
  await context('ref-one'); await menu('删除分身').click(); await dialog().getByRole('button', { name: '删除分身', exact: true }).click();
  assert.ok(await page.evaluate(() => window.entries.some(e => e.id === 'root-0') && !window.entries.some(e => e.id === 'ref-one')));
  await plus.click(); await dialog().getByRole('textbox').fill('新集合'); await dialog().getByRole('button', { name: '保存', exact: true }).click();
  const created = await page.evaluate(() => window.folders.find(f => f.name === '新集合').id); await active(created);
  assert.equal(await page.evaluate(() => window.requests.find(r => r.command === 'create_connected_collection').args.parentId), 'child');
  await navigate('root'); await row('root').getByRole('button', { name: '收起素材目录' }).click();
  assert.equal(await row('nested').count(), 0);
  await page.locator('.catalog-scroller').evaluate(el => { const section = el.querySelector('[data-catalog-section="nested"]'); el.scrollTop = section.offsetTop; });
  await active('nested'); await row('nested').waitFor();
  assert.equal(await page.locator('.catalog-section-heading.is-pinned .catalog-section-title').textContent(), '晨间');
  await navigate('offline'); await page.getByRole('button', { name: '重新定位', exact: true }).click();
  assert.equal(await page.evaluate(() => window.requests.filter(r => r.command === 'relocate_folder').length), 0);
  await row('second').click({ button: 'right' }); await menu('断开连接').click();
  await dialog().getByRole('button', { name: '断开连接', exact: true }).click();
  assert.ok(await page.evaluate(() => window.entries.some(e => e.id === 'second-0')));
  await page.getByRole('button', { name: '建立连接', exact: true }).click();
  assert.equal(await page.evaluate(() => window.requests.filter(r => r.command === 'connect_folder').length), 0);
  await page.evaluate(() => { window.picker = '/fixture/new'; });
  await page.getByRole('button', { name: '建立连接', exact: true }).click();
  await page.getByRole('treeitem', { name: '新连接', exact: true }).waitFor();
  const connected = await page.evaluate(() => window.folders.find(f => f.name === '新连接')?.id); await active(connected);
  for (const kind of ['tags', 'all', 'collections']) {
    await page.evaluate(kind => window.mode.getState().setCatalogView(kind), kind);
    await page.waitForTimeout(150);
    assert.equal(await page.locator('.local-file-workspace').count(), 0);
    assert.equal(await page.getByRole('button', { name: '打开系统文件浏览器', exact: true }).count(), 0);
  }
  await navigate('root');
  await page.screenshot({ path: '.tmp/connected-collections/production-dark.png' });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.waitForTimeout(250);
  await page.screenshot({ path: '.tmp/connected-collections/production-light.png' });
  const batching = await page.evaluate(async () => {
    const sample = window.entries[0], start = window.requests.length;
    window.entries.push(...Array.from({ length: 2505 }, (_, i) => ({ ...sample, id: `bulk-${i}`, folder_id: 'bulk' })));
    const ids = await window.connections.ids('bulk');
    const resolved = await window.connections.resolve(ids);
    await window.connections.moveEntries(ids, 'empty');
    await window.connections.trashEntries(ids);
    return { ids: ids.length, resolved: resolved.length, requests: window.requests.slice(start) };
  });
  assert.equal(batching.ids, 2505); assert.equal(batching.resolved, 2505);
  assert.deepEqual(batching.requests.filter(r => r.command === 'connection_entry_ids').map(r => r.args.offset), [0, 2000]);
  for (const command of ['resolve_connection_entries', 'move_connection_entries', 'trash_connection_entries']) assert.deepEqual(batching.requests.filter(r => r.command === command).map(r => r.args.ids.length), [2000, 505]);
  assert.deepEqual(errors, []);
  console.log('PASS production connected collections: DFS, paging, sticky title, entry selection, references, rename/trash, create, collapse/scroll, disconnect, picker cancel/connect, view routing');
} catch (error) {
  await page.screenshot({ path: '.tmp/connected-collections/failure.png' });
  console.error(await page.evaluate(() => ({ text: document.body.innerText, scroll: document.querySelector('.catalog-scroller')?.scrollTop, headings: [...document.querySelectorAll('.catalog-section-heading')].map(el => ({ text: el.textContent, className: el.className })), requests: window.requests.slice(-8) })), errors);
  throw error;
} finally { await browser.close(); await server.close(); }
