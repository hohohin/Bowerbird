import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const output = '.tmp/library-navigation';
const server = await createServer({ cacheDir: `${output}/vite`, server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, reducedMotion: 'reduce' });
page.setDefaultTimeout(25000);
const errors = [];
page.setDefaultNavigationTimeout(60000);
page.on('pageerror', e => errors.push(e.message));
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
const primary = () => page.getByRole('tablist', { name: '素材库来源', exact: true });
const lens = () => page.getByRole('tablist', { name: '素材库视角', exact: true });
const choose = key => primary().locator(`[data-tab-value="${key}"]`).click();
const selected = () => primary().getByRole('tab', { selected: true }).getAttribute('data-tab-value');
async function assertFloatingNavigation(root = page.locator('.library-catalog-layer:not([data-outgoing]) .categorized-library').first()) {
  const geometry = await root.evaluate(element => {
    const heading = element.querySelector('.file-view-heading');
    const rect = selector => {
      const box = element.querySelector(selector).getBoundingClientRect();
      return { top: box.top, height: box.height };
    };
    const measure = () => ['.catalog-body', '.catalog-gallery', '.catalog-scroller'].map(rect);
    const shown = measure(), top = element.getBoundingClientRect().top;
    const previous = heading.style.display;
    heading.style.display = 'none';
    const hidden = measure();
    heading.style.display = previous;
    return { top, shown, hidden };
  });
  assert.ok(geometry.shown.every(box => Math.abs(box.top - geometry.top) < 1), 'floating navigation must not reserve a header band or content padding');
  assert.deepEqual(geometry.shown, geometry.hidden, 'showing navigation must not move or shrink the content viewport');
}
async function filter(kind, projectId, media = 'images') {
  await page.waitForFunction(({ kind, projectId, media }) => {
    const state = window.mode.getState();
    const currentKind = state.lens === 'tags' ? 'tags' : 'all';
    const currentProject = (state.source === 'project') ? state.browseProjectId : null;
    return currentKind === kind && currentProject === projectId && state.media === media
      && window.requests.some(r => r.command === 'catalog_overview' && r.args.filter.kind === kind && r.args.filter.projectId === projectId && r.args.filter.media === media);
  }, { kind, projectId, media });
}
try {
  await mkdir(output, { recursive: true });
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/catalog-paging/preview.html?navigation`);
  assert.deepEqual(await primary().getByRole('tab').evaluateAll(tabs => tabs.map(tab => tab.dataset.tabValue)), ['global', 'project', 'folders']);
  await choose('global'); await filter('all', null);
  await assertFloatingNavigation();
  await choose('project'); await filter('all', 'p');
  assert.equal(await page.locator('.catalog-sidebar').count(), 0);
  await lens().getByRole('tab', { name: '标签', exact: true }).click(); await filter('tags', 'p');
  await choose('global'); await filter('tags', null);
  assert.equal(await selected(), 'global');
  await lens().getByRole('tab', { name: '标签', selected: true }).waitFor();
  await choose('folders');
  await primary().getByRole('tab', { name: '文件夹', selected: true }).waitFor();
  assert.equal(await lens().count(), 0);
  await choose('project'); await filter('tags', 'p');
  for (const media of ['videos', 'audios', 'texts', 'images']) {
    await page.evaluate(media => window.mode.getState().setMedia(media), media);
    await filter('tags', 'p', media);
    assert.equal(await selected(), 'project');
    await page.getByRole('complementary', { name: '标签分类' }).waitFor();
  }
  await page.evaluate(async () => {
    const { showImportedMedia } = await import('/src/lib/mediaImport.ts');
    showImportedMedia([{ id: 'imported-video', store_path: '/fixture/imported.mp4', ext: 'mp4' }], window.mode);
  });
  await filter('all', 'p', 'videos');
  assert.equal(await selected(), 'project', 'imported video returns to its scoped flat view');
  await page.evaluate(() => window.mode.getState().setMedia('images'));
  await lens().getByRole('tab', { name: '标签', exact: true }).click(); await filter('tags', 'p');
  for (const width of [1000, 600, 400, 320]) {
    await page.setViewportSize({ width, height: 800 });
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      const nav = await primary().boundingBox();
      assert.ok(nav.x >= 0 && nav.x + nav.width <= width, `navigation fits ${width}`);
      await assertFloatingNavigation();
      await page.screenshot({ path: `${output}/tags-${width}-${theme}.png` });
    }
  }
  await choose('global'); await filter('tags', null);
  await primary().getByRole('tab', { name: '全部素材', exact: true }).focus();
  await page.keyboard.press('ArrowRight'); await filter('tags', 'p');
  await page.keyboard.press('End'); await page.getByRole('complementary', { name: '文件夹目录' }).waitFor();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => document.activeElement?.dataset.tabValue === 'project'
    && !document.activeElement.closest('[data-outgoing]'));
  await page.locator('.library-catalog-transition[aria-busy="false"]').waitFor();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.keyboard.press('Home'); assert.equal(await selected(), 'global');

  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/catalog-paging/preview.html?split`);
  const left = page.locator('[data-library-pane="home-left"]');
  await left.getByRole('button', { name: '向右分栏', exact: true }).click();
  const right = page.locator('[data-library-pane="home-pane-1"]');
  await right.getByRole('tab', { name: '标签', exact: true }).click();
  assert.equal(await left.getByRole('tablist', { name: '素材库来源' }).getByRole('tab', { selected: true }).getAttribute('aria-label'), '全部素材');
  for (const width of [1000, 800]) {
    await page.setViewportSize({ width, height: 800 });
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      for (const pane of [left, right]) {
        await assertFloatingNavigation(pane.locator('.library-catalog-layer:not([data-outgoing]) .categorized-library'));
        const fits = await pane.locator('.library-source-navigation').evaluate(nav => {
          const bounds = nav.closest('[data-library-pane]').getBoundingClientRect();
          const row = nav.getBoundingClientRect();
          return row.left >= bounds.left && row.right <= bounds.right;
        });
        assert.equal(fits, true, 'navigation fits its own split pane');
      }
      await page.screenshot({ path: `${output}/split-${width}-${theme}.png` });
    }
  }

  await page.setViewportSize({ width: 1280, height: 840 });
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/canvas-reference/preview.html?source-library&local-files`);
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.getByRole('button', { name: '打开素材库', exact: true }).click();
  await choose('project');
  await lens().getByRole('tab', { name: '平铺', exact: true }).click();
  await primary().getByRole('tab', { selected: true }).focus();
  await page.keyboard.press('Tab');
  assert.equal(await selected(), 'project');
  await lens().getByRole('tab', { name: '标签', selected: true }).waitFor();
  await page.keyboard.press('f');
  await page.getByRole('complementary', { name: '文件夹目录' }).waitFor();
  await page.keyboard.press('Tab');
  assert.equal(await selected(), 'folders');
  await page.keyboard.press('q');
  assert.equal(await selected(), 'global');
  await lens().getByRole('tab', { name: '标签', selected: true }).waitFor();
  await page.keyboard.press('e');
  assert.equal(await selected(), 'project');
  await assertFloatingNavigation();
  await page.screenshot({ path: `${output}/canvas-tags.png` });

  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/connected-collections/preview.html`);
  await choose('folders');
  await page.getByRole('treeitem', { name: '风景', exact: true }).click();
  await page.locator('[data-connection-entry="child-0"]').waitFor();
  await choose('global');
  await page.locator('[data-asset-id]').first().waitFor();
  await choose('folders');
  assert.equal(await page.getByRole('treeitem', { name: '风景', exact: true }).getAttribute('aria-selected'), 'true');
  await assertFloatingNavigation();
  await page.screenshot({ path: `${output}/collections.png` });
  assert.deepEqual(errors, []);
  await writeFile(`${output}/result.json`, JSON.stringify({ passed: true, widths: [1000, 600, 400, 320], errors }, null, 2));
  console.log('PASS flat navigation, tag scopes, collections, media, keyboard, themes and pane isolation');
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` });
  console.error(errors);
  throw error;
} finally { await browser.close(); await server.close(); }
