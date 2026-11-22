import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const output = '.tmp/library-tab-memory';
const server = await createServer({ cacheDir: `${output}/vite`, server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
page.setDefaultTimeout(25000);
const errors = [];
page.setDefaultNavigationTimeout(60000);
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
const url = `${server.resolvedUrls.local[0]}scripts/fixtures/home-navigation-live/preview.html?source-library&detail-route&canvas-library&media-home`;
const home = page.locator('.home-workspace-page[data-suspended="false"] .library-home');
const canvas = page.locator('.canvas-workspace[aria-busy="false"]');
const nav = page.getByRole('navigation', { name: '首页' });
const tabs = root => root.getByRole('tablist', { name: '素材库来源', exact: true });
const lens = root => root.getByRole('tablist', { name: '素材库视角', exact: true });
const source = (root, key) => tabs(root).locator(`[data-tab-value="${key}"]`);
async function selected(root, key) {
  await tabs(root).getByRole('tab', { selected: true }).and(source(root, key)).waitFor();
}
async function choose(root, key) {
  await source(root, key).click();
  await selected(root, key);
}
async function tags(root) {
  await lens(root).getByRole('tab', { name: '标签', selected: true }).waitFor();
}
async function openProject(id = 'p') {
  await nav.getByRole('button', { name: '项目', exact: true }).click();
  const label = id === 'p' ? '山野品牌 1' : '秋日海报 2';
  await page.locator('.home-workspace-page[data-suspended="false"] .library-project-page')
    .getByRole('button', { name: `打开项目 ${label}`, exact: true }).click();
  await canvas.waitFor();
}
async function openDrawer() {
  const button = page.getByRole('button', { name: '打开素材库', exact: true });
  if (await button.isVisible()) await button.click();
}
async function closeDrawer() {
  await page.getByRole('button', { name: '收起素材库', exact: true }).click();
  await page.getByRole('button', { name: '打开素材库', exact: true }).waitFor();
}
try {
  await mkdir(output, { recursive: true });
  await page.goto(url);
  await selected(home, 'global');
  await choose(home, 'folders');
  await page.reload();
  await selected(home, 'folders');
  await page.evaluate(() => {
    window.mode.getState().selectProject('p');
    window.mode.getState().openSource('project');
  });
  await lens(home).getByRole('tab', { name: '标签', exact: true }).click();
  await page.reload();
  await selected(home, 'project');
  await tags(home);
  assert.equal(await page.evaluate(() => window.mode.getState().browseProjectId), 'p');
  assert.equal(await page.getByRole('menu', { name: '选择浏览项目' }).count(), 0);

  await openProject();
  await openDrawer();
  await selected(canvas, 'project');
  await choose(canvas, 'folders');
  await closeDrawer();
  await openDrawer();
  await selected(canvas, 'folders');
  await closeDrawer();
  await canvas.getByRole('button', { name: '展开画板素材库', exact: true }).click();
  await selected(canvas, 'folders');
  await closeDrawer();
  await canvas.locator('.canvas-source-toggle').focus();
  await page.keyboard.press('Tab');
  await selected(canvas, 'folders');
  await source(canvas, 'folders').focus();
  await page.keyboard.press('Tab');
  await selected(canvas, 'folders');
  await source(canvas, 'folders').focus();
  await page.keyboard.press('q');
  await selected(canvas, 'global');
  await page.keyboard.press('e');
  await selected(canvas, 'project');
  await page.keyboard.press('Tab');
  await selected(canvas, 'project');
  await tags(canvas);
  await source(canvas, 'project').click();
  const projectMenu = page.getByRole('menu', { name: '选择浏览项目' });
  await projectMenu.getByRole('menuitemradio', { name: '秋日海报 2' }).click();
  await canvas.getByRole('status').filter({ hasText: '正在跨项目浏览' }).waitFor();
  await tags(canvas);
  await page.screenshot({ path: `${output}/cross-project.png` });
  const route = await page.evaluate(() => window.store.getState().activeProjectId);
  assert.equal(route, 'p');
  await canvas.getByRole('button', { name: '回到当前项目', exact: true }).click();
  await canvas.getByRole('button', { name: '回到当前项目', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.mode.getState().browseProjectId), 'p');
  await page.keyboard.press('f');
  await selected(canvas, 'folders');

  await page.getByRole('button', { name: '返回主页', exact: true }).click();
  await nav.getByRole('button', { name: '素材库', exact: true }).click();
  await selected(home, 'project'); await tags(home);
  assert.equal(await page.evaluate(() => window.mode.getState().source), 'project');
  await openProject('home-project-1');
  await openDrawer();
  await selected(canvas, 'project');
  await choose(canvas, 'global');
  await page.getByRole('button', { name: '返回主页', exact: true }).click();
  await page.reload();
  await openProject();
  await openDrawer();
  await selected(canvas, 'folders');
  await page.screenshot({ path: `${output}/restored-canvas.png` });

  await page.getByRole('button', { name: '返回主页', exact: true }).click();
  await nav.getByRole('button', { name: '素材库', exact: true }).click();
  await selected(home, 'project'); await tags(home);
  await home.getByRole('button', { name: '向右分栏', exact: true }).click();
  const left = home.locator('[data-library-pane="home-left"]'), right = home.locator('[data-library-pane="home-pane-1"]');
  await choose(right, 'folders');
  await selected(left, 'project'); await tags(left);
  await nav.getByRole('button', { name: '项目', exact: true }).click();
  await nav.getByRole('button', { name: '素材库', exact: true }).click();
  await selected(right, 'folders');
  await selected(left, 'project'); await tags(left);
  await page.screenshot({ path: `${output}/independent-panes.png` });
  assert.deepEqual(errors, []);
  console.log('PASS source/lens memory, canvas opening, Q/E/F and Tab, cross-project return, and independent panes');
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await server.close();
}
