import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/library-selection-completion/vite', server: { host: '127.0.0.1', port: 1704, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
const library = page.locator('.categorized-library');
const card = id => library.locator(`[data-asset-id="${id}"]`);
const selection = library.getByRole('group', { name: '分类素材所选操作' });
const dialog = () => page.getByRole('dialog');
async function selectPair() {
  await card('existing').click({ modifiers: ['Control'] });
  await card('a').click();
  assert.equal(await library.locator('.folder-media-card[aria-pressed="true"]').count(), 2);
}
async function deleteMenu() {
  await card('existing').click({ button: 'right' });
  await page.getByRole("menuitem", { name: "删除", exact: true }).click();
  await page.getByRole('menuitem', { name: '物理删除', exact: true }).click();
  await dialog().getByRole('list', { name: '待删除素材' }).waitFor();
}
async function verifyBrowseMode() {
  await selection.waitFor({ state: 'detached' });
  await card('b').click();
  await page.getByRole('dialog', { name: /^媒体预览/ }).waitFor();
  await page.keyboard.press('Escape');
}
try {
  await page.goto('http://127.0.0.1:1704/scripts/fixtures/canvas-reference/preview.html?source-library&detail-route');
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await page.evaluate(() => {
    const previous = window.__TAURI_INTERNALS__.invoke;
    const assets = window.store.getState().assets.filter(a => ['existing', 'a', 'b'].includes(a.id));
    const deleted = new Set();
    const collections = [{ id: 'test', name: '测试集合', kind: 'collection' },
      { id: 'child', name: '海报参考', parent_id: 'test', kind: 'collection' },
      ...Array.from({ length: 15 }, (_, i) => ({ id: `more-${i}`, name: `作品参考 ${i + 1}`, kind: 'collection' }))];
    window.deletions = [];
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'material_catalog') return { tags: [], collections, prompts: [], tag_asset_ids: {} };
      if (command === 'material_catalog_assets') return assets.filter(a => !deleted.has(a.id));
      if (command === 'list_collections') return collections;
      if (command === 'set_collection_members') {
        if (window.failAssignment) throw '模拟添加失败';
        return null;
      }
      if (command === 'delete_asset_with_mode') {
        window.deletions.push(args.id);
        if (window.failDeleteId === args.id) throw '模拟删除失败';
        deleted.add(args.id);
      }
      return previous(command, args);
    };
  });
  await page.getByRole('button', { name: '返回主页', exact: true }).click();
  await card('existing').waitFor();
  await selectPair();
  await deleteMenu();
  await dialog().getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await library.locator('.folder-media-card[aria-pressed="true"]').count(), 2, 'cancel retains selection');

  // The menu closes before the assignment dialog completes: completion must retain its originating view.
  await card('existing').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '添加到集合', exact: true }).click();
  await dialog().getByRole('radio', { name: '海报参考', exact: true }).waitFor({ state: 'attached' });
  assert.equal(await dialog().locator('select').count(), 0, 'collection choices are shown directly, without a dropdown');
  await dialog().getByText('海报参考', { exact: true }).click();
  assert.equal(await dialog().getByRole('radio', { name: '海报参考', exact: true }).isChecked(), true);
  await dialog().getByRole('radio', { name: '海报参考', exact: true }).press('ArrowUp');
  assert.equal(await dialog().getByRole('radio', { name: '测试集合', exact: true }).isChecked(), true, 'native arrow navigation selects the preceding parent');
  const indent = name => dialog().getByRole('radio', { name, exact: true }).evaluate(input => parseFloat(getComputedStyle(input.parentElement).paddingLeft));
  assert.ok(await indent('海报参考') > await indent('测试集合'), 'child collections retain sidebar hierarchy');
  await dialog().getByRole('scrollbar', { name: '目标集合滚动条' }).waitFor({ state: 'attached' });
  await mkdir('.tmp/collection-choice', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.setViewportSize({ width: 760, height: 700 });
    await dialog().screenshot({ path: `.tmp/collection-choice/${theme}.png` });
    const bounds = await dialog().locator('.app-modal').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 760 && bounds.y + bounds.height <= 700);
  }
  await page.setViewportSize({ width: 1400, height: 900 });
  await dialog().getByText('新建集合', { exact: true }).click();
  await dialog().getByLabel('集合名称', { exact: true }).fill('新的参考');
  await dialog().getByText('海报参考', { exact: true }).click();
  assert.equal(await dialog().getByLabel('集合名称', { exact: true }).count(), 0);
  await page.evaluate(() => { window.failAssignment = true; });
  await dialog().getByRole('button', { name: '添加', exact: true }).click();
  await dialog().getByRole('alert').waitFor();
  assert.equal(await library.locator('.folder-media-card[aria-pressed="true"]').count(), 2);
  await page.evaluate(() => { window.failAssignment = false; });
  await dialog().getByRole('button', { name: '添加', exact: true }).click();
  await verifyBrowseMode();

  await selectPair();
  await selection.getByRole('button', { name: '添加到集合', exact: true }).click();
  await dialog().getByRole('button', { name: '添加', exact: true }).click();
  await verifyBrowseMode();

  await selectPair();
  await deleteMenu();
  await page.evaluate(() => { window.failDeleteId = 'a'; });
  await dialog().getByRole('button', { name: '物理删除', exact: true }).click();
  await dialog().getByRole('button', { name: '重试失败项', exact: true }).waitFor();
  assert.equal(await selection.count(), 1, 'partial failure keeps selection mode');
  assert.equal(await dialog().locator('[data-delete-asset-id]').count(), 1);
  await page.evaluate(() => { window.failDeleteId = null; });
  await dialog().getByRole('button', { name: '重试失败项', exact: true }).click();
  await card('a').waitFor({ state: 'detached' });
  await library.getByRole('status').waitFor({ state: 'detached' });
  await verifyBrowseMode();
  assert.deepEqual(await page.evaluate(() => window.deletions), ['existing', 'a', 'a'], 'retry does not delete successful items twice');
  await card('b').click({ modifiers: ['Control'] });
  await card('b').click({ button: 'right' });
  await page.getByRole("menuitem", { name: "删除", exact: true }).click();
  await page.getByRole('menuitem', { name: '物理删除', exact: true }).click();
  await dialog().getByRole('button', { name: '物理删除', exact: true }).click();
  await selection.waitFor({ state: 'detached' });
  await dialog().waitFor({ state: 'detached' });

  // Local file selection has independent state and must also exit after deletion.
  await page.goto('http://127.0.0.1:1704/scripts/fixtures/canvas-reference/preview.html?source-library&local-files&detail-route');
  await page.getByRole('button', { name: '返回主页', exact: true }).click();
  await page.getByRole('button', { name: '文件浏览器', exact: true }).click();
  const original = page.locator('.folder-media-card[aria-label="原图.png"]');
  await original.click({ modifiers: ['Control'] });
  await page.locator('.folder-media-card[aria-label="另一张.png"]').click();
  await page.getByRole('button', { name: '复制到收集箱', exact: true }).click();
  await page.getByRole('button', { name: '取消文件选择', exact: true }).waitFor({ state: 'detached' });
  await original.click({ modifiers: ['Control'] });
  await page.locator('.folder-media-card[aria-label="另一张.png"]').click();
  await original.click({ button: 'right' });
  await page.getByRole("menuitem", { name: "删除", exact: true }).click();
  await page.getByRole('menuitem', { name: '删除本机文件', exact: true }).click();
  await dialog().getByRole('button', { name: '删除本机文件', exact: true }).click();
  await dialog().waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('button', { name: '取消文件选择', exact: true }).count(), 0, 'empty file selection does not leave multi-select mode active');
  assert.deepEqual(errors, []);
  console.log('PASS selection completion: cancel/failure retention, assignment via menu/bar, partial deletion retry, local file deletion');
} finally {
  await browser.close();
  await server.close();
}
