import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/home-navigation-memory-vite', server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(10000);
const errors = [], remote = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => {
  if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue();
  remote.push(route.request().url()); return route.abort();
});
const url = `${server.resolvedUrls.local[0]}scripts/fixtures/home-navigation-live/preview.html?source-library&detail-route&canvas-library&media-home`;
const nav = page.getByRole('navigation', { name: '首页' });
const library = nav.getByRole('button', { name: '素材库', exact: true });
const projects = nav.getByRole('button', { name: '项目', exact: true });
const canvas = page.locator('.canvas-workspace[aria-busy="false"]');
const projectPage = page.locator('.home-workspace-page[data-suspended="false"] .library-project-page');
async function expectHome(view) {
  await page.locator(`.home-workspace-page[data-suspended="false"] ${view === 'library' ? '.library-home' : '.library-project-page'}`).waitFor();
  assert.equal(await (view === 'library' ? library : projects).getAttribute('aria-current'), 'page');
  assert.equal(await page.evaluate(() => window.store.getState().activeProjectId), null);
}
async function openProject() {
  await projects.click();
  await projectPage.getByRole('button', { name: '打开项目 山野品牌 1', exact: true }).click();
  await canvas.waitFor();
}
try {
  await page.goto(url);
  await expectHome('library');
  await projects.click();
  await page.reload();
  await expectHome('projects');
  await library.click();
  await page.reload();
  await expectHome('library');

  assert.equal(await page.evaluate(async () => {
    window.failHomeOpen = true;
    try { await window.store.getState().enterProject('p'); return false; }
    catch { return true; }
    finally { window.failHomeOpen = false; }
  }), true);
  await page.reload();
  await expectHome('library');

  await openProject();
  // Canvas material navigation must not replace the remembered home destination.
  await page.evaluate(() => window.store.getState().setCurrentFolder(null));
  await page.getByRole('button', { name: '返回主页', exact: true }).click();
  await expectHome('projects');
  await page.reload();
  await expectHome('projects');

  await openProject();
  await page.evaluate(() => window.store.getState().focusAsset('existing'));
  await page.reload();
  await expectHome('projects');

  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  await canvas.waitFor();
  await page.evaluate(() => window.store.getState().setColorFilter(null));
  await page.getByRole('button', { name: '返回主页', exact: true }).click();
  await expectHome('projects');

  await openProject();
  await page.evaluate(() => {
    window.originalFlush = window.store.getState().projectCanvasFlush;
    window.store.setState({ projectCanvasFlush: async () => { throw new Error('隔离保存失败'); } });
  });
  await page.getByRole('button', { name: '返回主页', exact: true }).click();
  await page.waitForFunction(() => !window.store.getState().projectRoutePending);
  assert.equal(await canvas.isVisible(), true, 'failed save keeps the project open');
  await page.evaluate(() => window.store.setState({ projectCanvasFlush: window.originalFlush }));
  await page.getByRole('button', { name: '探索', exact: true }).click();
  await nav.waitFor();
  await library.click();
  await expectHome('library');
  await page.reload();
  await expectHome('library');

  await page.evaluate(() => localStorage.setItem('bowerbird.libraryHomeView', 'invalid'));
  await page.reload();
  await expectHome('library');
  const noStorage = await browser.newPage();
  await noStorage.addInitScript(() => {
    const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
    Storage.prototype.getItem = function(key) { if (key === 'bowerbird.libraryHomeView') throw new Error('unavailable'); return get.call(this, key); };
    Storage.prototype.setItem = function(key, value) { if (key === 'bowerbird.libraryHomeView') throw new Error('unavailable'); return set.call(this, key, value); };
  });
  await noStorage.goto(url);
  await noStorage.getByRole('navigation', { name: '首页' }).getByRole('button', { name: '项目', exact: true }).click();
  await noStorage.locator('.home-workspace-page[data-suspended="false"] .library-project-page').waitFor();
  await noStorage.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(remote, []);
  console.log('home navigation memory: reload, canvas return, draft return, save failure, explicit destination, invalid/unavailable storage passed');
} finally {
  await browser.close();
  await server.close();
}
