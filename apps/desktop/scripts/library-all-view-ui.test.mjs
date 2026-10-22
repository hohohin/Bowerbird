import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/library-all/vite', server: { host: '127.0.0.1', port: 17884, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
page.setDefaultTimeout(10000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
const names = { all: '平铺浏览全部图片', tags: '按标签浏览素材', collections: '按集合浏览素材' };
const region = kind => page.getByRole('region', { name: names[kind], exact: true });
async function settled(kind) {
  await region(kind).waitFor();
  await page.locator('.catalog-view-wipe').waitFor({ state: 'detached' });
}
async function expectIds(expected) {
  await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('.categorized-library [data-asset-id]')].map(el => el.dataset.assetId).sort()) === JSON.stringify(expected), [...expected].sort());
}
async function cycle(kind) {
  await page.locator('.categorized-library [role="tab"][aria-selected="true"]').focus();
  await page.keyboard.press('Tab'); await settled(kind);
}
async function control(name) {
  const button = page.getByRole('button', { name, exact: true });
  if (!await button.isVisible()) await page.getByRole('button', { name: '更多素材库控件', exact: true }).click();
  await button.click();
  const more = page.getByRole('button', { name: '更多素材库控件', exact: true });
  if (await more.count() && await more.getAttribute('aria-expanded') === 'true') await more.click();
}
try {
  await mkdir('.tmp/library-all', { recursive: true });
  for (const scene of ['home', 'project']) {
    await page.setViewportSize({ width: 1280, height: 840 });
    await page.goto(`http://127.0.0.1:17884/scripts/fixtures/${scene === 'home' ? 'project-drop/preview.html?layout' : 'canvas-reference/preview.html?source-library'}`);
    if (scene === 'project') {
      await page.waitForFunction(() => document.querySelector('.canvas-workspace')?.getAttribute('aria-busy') === 'false');
      await page.locator('.canvas-stage').focus(); await page.keyboard.press('Tab');
    }
    await settled('tags');
    await page.evaluate(async () => {
      window.catalogMode = (await import('/src/lib/localFileMode.ts')).useLocalFileMode;
      const previous = window.__TAURI_INTERNALS__.invoke;
      const thumb = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="#7b9eaa"/></svg>');
      const assets = [
        { id: 'tagged', name: '多标签.png' }, { id: 'untagged', name: '未分类.png' },
        { id: 'generated', name: '生成.png', generation_session_id: 'generation' },
        { id: 'outside', name: '项目外.png' }, { id: 'video', name: '视频.mp4', ext: 'mp4' },
      ].map(a => ({ ext: 'png', source: 'imported', width: 240, height: 160, store_path: `/${a.id}.png`, thumb_path: thumb, ...a }));
      window.catalogQueries = [];
      window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
        if (command === 'material_catalog') return { tags: ['one', 'two'].map(id => ({ id, name: id, description: '', count: 1, projectCount: 1 })),
          collections: [{ id: 'collection', name: '测试集合', parent_id: null, kind: 'collection' }], prompts: [], tag_asset_ids: { one: ['tagged'], two: ['tagged'] } };
        if (command === 'material_catalog_assets') {
          window.catalogQueries.push(args);
          if (!['tags', 'collections'].includes(args.kind)) throw new Error('Unsupported backend kind');
          return assets.filter(a => (!args.projectId || a.id !== 'outside') && (args.kind !== 'collections' || a.id === 'tagged'));
        }
        return previous(command, args);
      };
    });
    if (scene === 'home') {
      assert.deepEqual(await page.getByRole('tab').allTextContents(), ['全部', '标签分类', '集合分类']);
      await page.getByRole('tab', { name: '全部', exact: true }).click();
    } else {
      assert.deepEqual(await page.getByRole('tab').evaluateAll(tabs => tabs.map(tab => tab.getAttribute('aria-label'))), ['全局素材', '项目素材']);
      await cycle('collections'); await cycle('all');
    }
    await settled('all'); await expectIds(['tagged', 'untagged', 'generated', 'outside']);
    assert.equal(await region('all').locator('.catalog-sidebar, [data-tag-section]').count(), 0, 'all view has no sidebar or grouping');
    assert.equal(await region('all').locator('.folder-media-generated').count(), 1);
    const lastQuery = await page.evaluate(() => window.catalogQueries.at(-1));
    assert.deepEqual(lastQuery, { kind: 'tags', id: null, projectId: null }, 'uses existing unfiltered backend query');
    await control('只看生成图'); await expectIds(['generated']);
    await control('只看生成图');
    await control('不看生成图'); await expectIds(['tagged', 'untagged', 'outside']);
    await control('不看生成图');
    await page.getByRole('textbox', { name: '搜索全部图片', exact: true }).fill('未分类');
    await expectIds(['untagged']);
    await page.evaluate(() => window.catalogMode.getState().setQuery(''));
    await cycle('tags'); await cycle('collections'); await cycle('all');
    await expectIds(['tagged', 'untagged', 'generated', 'outside']);
    if (scene === 'home') {
      await page.getByRole('tab', { name: '全部', exact: true }).press('ArrowRight'); await settled('tags');
      await page.getByRole('tab', { name: '标签分类', exact: true }).press('End'); await settled('collections');
      await page.getByRole('tab', { name: '集合分类', exact: true }).press('Home'); await settled('all');
    } else {
      await page.getByRole('tab', { name: '项目素材', exact: true }).click(); await settled('tags');
      await cycle('collections'); await cycle('all'); await expectIds(['tagged', 'untagged', 'generated']);
      assert.ok((await page.evaluate(() => window.catalogQueries.at(-1))).projectId, 'flat project view keeps project scope');
      await page.keyboard.press('q'); await settled('all'); await expectIds(['tagged', 'untagged', 'generated', 'outside']);
      await page.keyboard.press('e'); await settled('all'); await expectIds(['tagged', 'untagged', 'generated']);
    }
    await control('文件浏览器');
    await page.locator('.local-file-workspace').waitFor();
    await control('文件浏览器'); await settled('all');
    await control('视频');
    await page.getByRole('region', { name: '平铺浏览视频', exact: true }).waitFor();
    if (scene === 'home') assert.deepEqual(await page.getByRole('tab').allTextContents(), ['视频平铺', '集合分类']);
    await control('图片'); await settled('all');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.setViewportSize({ width: 900, height: 650 });
      if (scene === 'project') await page.getByRole('separator', { name: '调整素材库宽度', exact: true }).press('Home');
      await page.waitForTimeout(300);
      const geometry = await region('all').evaluate(el => {
        const root = el.getBoundingClientRect(), gallery = el.querySelector('.catalog-gallery').getBoundingClientRect();
        const nav = el.querySelector('.library-view-switch').getBoundingClientRect(), controls = el.querySelector('.library-controls-host').getBoundingClientRect();
        return { fullWidth: Math.abs(root.width - gallery.width) < 2, contained: nav.left >= root.left && nav.right <= root.right,
          centered: Math.abs(nav.x + nav.width / 2 - gallery.x - gallery.width / 2) < 1,
          noOverlap: controls.top >= nav.bottom || controls.left >= nav.right };
      });
      assert.deepEqual(geometry, { fullWidth: true, contained: true, centered: true, noOverlap: true });
      await page.screenshot({ path: `.tmp/library-all/${scene}-${theme}.png` });
    }
  }
  assert.deepEqual(errors, []);
  console.log('PASS all-images view, unique/untagged images, home three tabs, keyboard cycle, source memory, project scoping, filters, file/video return, narrow layouts and themes');
} finally { await browser.close(); await server.close(); }
