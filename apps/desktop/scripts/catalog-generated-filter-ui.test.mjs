import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/catalog-generated/vite', server: { host: '127.0.0.1', port: 17882, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const ids = () => page.locator('.categorized-library [data-asset-id]').evaluateAll(nodes => [...new Set(nodes.map(el => el.dataset.assetId))].sort());
async function expectIds(expected) {
  await page.waitForFunction(expected => JSON.stringify([...new Set([...document.querySelectorAll('.categorized-library [data-asset-id]')].map(el => el.dataset.assetId))].sort()) === JSON.stringify(expected), [...expected].sort());
}
async function clickFilter(name) {
  const button = page.getByRole('button', { name, exact: true });
  if (!await button.isVisible()) await page.getByRole('button', { name: '更多素材库控件', exact: true }).click();
  await button.click();
}
try {
  await mkdir('.tmp/catalog-generated', { recursive: true });
  for (const scene of ['home', 'project']) {
    await page.goto(`http://127.0.0.1:17882/scripts/fixtures/${scene === 'home' ? 'project-drop/preview.html?layout' : 'canvas-reference/preview.html?source-library'}`);
    if (scene === 'project') {
      await page.waitForFunction(() => document.querySelector('.canvas-workspace')?.getAttribute('aria-busy') === 'false');
      await page.locator('.canvas-stage').focus(); await page.keyboard.press('Tab');
    }
    await page.getByRole('region', { name: '按标签浏览素材', exact: true }).waitFor();
    await page.evaluate(async () => {
      window.catalogMode = (await import('/src/lib/localFileMode.ts')).useLocalFileMode;
      const previous = window.__TAURI_INTERNALS__.invoke;
      const thumb = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="#9baec4"/></svg>');
      const assets = [
        { id: 'imported', name: '收集.png', source: 'imported' },
        { id: 'generated', name: '生成.png', source: 'new-provider', generation_session_id: 'session-1' },
        { id: 'outside', name: '范围外.png', source: 'bowerbird-cloud', generation_session_id: 'session-2' },
        { id: 'source-only', name: '无生成会话.png', source: 'codex' },
      ].map(asset => ({ ...asset, ext: 'png', width: 240, height: 160, store_path: `/${asset.id}.png`, thumb_path: thumb }));
      window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
        if (command === 'material_catalog') return { tags: [{ id: 'test-tag', name: '测试', count: 4, projectCount: 2, description: '' }],
          collections: [{ id: 'test-collection', name: '测试集合', parent_id: null, kind: 'collection' }], prompts: [], tag_asset_ids: { 'test-tag': assets.map(a => a.id) } };
        if (command === 'material_catalog_assets') return assets.filter(a => args.projectId || args.kind === 'collections' ? ['imported', 'generated'].includes(a.id) : true);
        if (command === 'file_colors') return args.path === '/generated.png' ? ['red'] : ['blue'];
        return previous(command, args);
      };
      window.catalogMode.getState().openBrowser();
    });
    await page.evaluate(() => window.catalogMode.getState().closeBrowser());
    await expectIds(['imported', 'generated', 'outside', 'source-only']);
    assert.equal(await page.locator('.folder-media-generated').count(), 2, 'badges follow generation sessions across providers');
    const badge = await page.locator('[data-asset-id="generated"] .folder-media-generated').evaluate(el => {
      const a = el.getBoundingClientRect(), b = el.closest('.folder-media-preview').getBoundingClientRect();
      return { x: a.left - b.left, y: a.top - b.top, pointer: getComputedStyle(el).pointerEvents };
    });
    assert.deepEqual(badge, { x: 4, y: 4, pointer: 'none' });
    await page.locator('[data-asset-id="imported"]').click({ modifiers: ['Control'] });
    await clickFilter('只看生成图'); await expectIds(['generated', 'outside']);
    await page.getByRole('group', { name: '分类素材所选操作' }).waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('group', { name: '分类素材所选操作' }).count(), 0, 'changing filter clears old selection');
    assert.equal(await page.getByRole('button', { name: '只看生成图', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.evaluate(() => window.catalogMode.getState().setQuery('生成.png')); await expectIds(['generated']);
    await page.evaluate(() => window.catalogMode.getState().setQuery('不存在'));
    await page.getByText('没有匹配的素材。', { exact: true }).waitFor();
    await page.evaluate(() => window.catalogMode.getState().setQuery(''));
    await clickFilter('颜色筛选');
    await page.getByRole('button', { name: '红', exact: true }).click(); await expectIds(['generated']);
    await page.getByRole('button', { name: '清除颜色筛选', exact: true }).click(); await expectIds(['generated', 'outside']);
    await page.keyboard.press('Escape');
    await clickFilter('只看生成图'); await expectIds(['imported', 'generated', 'outside', 'source-only']);
    await clickFilter('不看生成图'); await expectIds(['imported', 'source-only']);
    assert.equal(await page.locator('.folder-media-generated').count(), 0);
    await clickFilter('不看生成图'); await expectIds(['imported', 'generated', 'outside', 'source-only']);
    await clickFilter('只看生成图');
    await page.evaluate(() => window.catalogMode.getState().toggleCatalog());
    await page.locator('.catalog-view-wipe').waitFor({ state: 'detached' });
    await expectIds(['generated']);
    assert.equal(await page.getByRole('button', { name: '只看生成图', exact: true }).getAttribute('aria-pressed'), 'true', 'filter survives view switching');
    await clickFilter('不看生成图'); await expectIds(['imported']);
    if (scene === 'project') {
      await page.evaluate(() => window.catalogMode.getState().openSource('project'));
      await expectIds(['imported']);
      await clickFilter('只看生成图'); await expectIds(['generated']);
      await page.setViewportSize({ width: 900, height: 650 });
      await page.getByRole('separator', { name: '调整素材库宽度', exact: true }).focus();
      await page.keyboard.press('Home');
      await page.waitForTimeout(350);
    }
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await clickFilter('只看生成图');
      await page.screenshot({ path: `.tmp/catalog-generated/${scene}-${theme}.png` });
    }
    assert.ok((await ids()).length > 0);
    await page.setViewportSize({ width: 1280, height: 840 });
  }
  assert.deepEqual(errors, []);
  console.log('PASS: generated-only/hide/reset, session-based badges, search intersection, selection reset, collections/project scopes, view persistence, narrow controls, both themes');
} catch (error) {
  await page.screenshot({ path: '.tmp/catalog-generated/failure.png' });
  throw error;
} finally { await browser.close(); await server.close(); }
