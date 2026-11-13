import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const output = '.tmp/library-tab-memory';
const server = await createServer({ cacheDir: `${output}/vite`, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
page.setDefaultTimeout(12000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
const url = `${server.resolvedUrls.local[0]}scripts/fixtures/home-navigation-live/preview.html?source-library&detail-route&canvas-library&media-home`;
const home = page.locator('.home-workspace-page[data-suspended="false"] .library-home');
const canvas = page.locator('.canvas-workspace[aria-busy="false"]');
const nav = page.getByRole('navigation', { name: '首页' });
const tabs = root => root.getByRole('tablist', { name: '素材视图切换条', exact: true });
async function selected(root, label) {
  await tabs(root).getByRole('tab', { name: label, selected: true, exact: true }).waitFor();
}
async function choose(root, label) {
  await tabs(root).getByRole('tab', { name: label, exact: true }).click();
  await selected(root, label);
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
  await selected(home, '全部素材');
  await choose(home, '文件夹');
  await page.reload();
  await selected(home, '文件夹');
  await choose(home, '标签分类');
  await page.evaluate(() => window.mode.getState().selectProject('p'));
  await home.getByRole('tablist', { name: '标签素材范围', exact: true }).getByRole('tab', { name: '项目素材', exact: true }).click();
  await page.reload();
  await selected(home, '标签分类');
  assert.equal(await page.evaluate(() => window.mode.getState().source), 'project');
  assert.equal(await page.evaluate(() => window.mode.getState().browseProjectId), 'p');
  assert.equal(await page.evaluate(() => window.mode.getState().scopeMenuOpen), false);

  await openProject();
  await openDrawer();
  await selected(canvas, '项目素材');
  await choose(canvas, '文件夹');
  await closeDrawer();
  await openDrawer();
  await selected(canvas, '文件夹');
  await closeDrawer();
  await canvas.getByRole('button', { name: '展开画板素材库', exact: true }).click();
  await selected(canvas, '文件夹');
  await closeDrawer();
  await canvas.locator('.canvas-source-toggle').focus();
  await page.keyboard.press('Tab');
  await selected(canvas, '文件夹');
  await tabs(canvas).getByRole('tab', { name: '文件夹', exact: true }).focus();
  await page.keyboard.press('q');
  await selected(canvas, '全部素材');
  await page.keyboard.press('e');
  await selected(canvas, '项目素材');
  await choose(canvas, '文件夹');

  await page.getByRole('button', { name: '返回主页', exact: true }).click();
  await nav.getByRole('button', { name: '素材库', exact: true }).click();
  await selected(home, '标签分类');
  assert.equal(await page.evaluate(() => window.mode.getState().source), 'project');
  await openProject('home-project-1');
  await openDrawer();
  await selected(canvas, '项目素材');
  await choose(canvas, '全部素材');
  await page.getByRole('button', { name: '返回主页', exact: true }).click();
  await page.reload();
  await openProject();
  await openDrawer();
  await selected(canvas, '文件夹');
  await page.screenshot({ path: `${output}/restored-canvas.png` });

  await page.getByRole('button', { name: '返回主页', exact: true }).click();
  await nav.getByRole('button', { name: '素材库', exact: true }).click();
  await selected(home, '标签分类');
  await home.getByRole('button', { name: '向右分栏', exact: true }).click();
  const left = home.locator('[data-library-pane="home-left"]'), right = home.locator('[data-library-pane="home-pane-1"]');
  await choose(right, '文件夹');
  await selected(left, '标签分类');
  await nav.getByRole('button', { name: '项目', exact: true }).click();
  await nav.getByRole('button', { name: '素材库', exact: true }).click();
  await selected(right, '文件夹');
  await selected(left, '标签分类');
  await page.screenshot({ path: `${output}/independent-panes.png` });
  assert.deepEqual(errors, []);
  console.log('PASS tab memory: home reload, tag scope, canvas buttons/Tab, Q/E, project isolation, restart and independent panes');
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await server.close();
}
