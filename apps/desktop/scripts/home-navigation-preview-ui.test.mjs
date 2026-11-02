import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
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
try {
  const fixture = process.env.HOME_NAVIGATION_BASELINE ? 'library-tactical' : 'home-navigation';
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/${fixture}/preview.html`);
  await page.locator('.library-home').waitFor();
  assert.equal(await page.getByRole('navigation', { name: '首页' }).count(), 1, 'home exposes peer library and project navigation');
  const nav = page.getByRole('navigation', { name: '首页' });
  const library = nav.getByRole('button', { name: '素材库', exact: true });
  const projects = nav.getByRole('button', { name: '项目', exact: true });
  await page.locator('.library-home [data-asset-id]').first().waitFor();
  const pane = page.locator('.library-pane-content').first();
  await pane.focus();
  const mode = await page.evaluate(() => window.mode.getState().mode);
  await page.keyboard.press('Tab');
  await page.waitForFunction(mode => window.mode.getState().mode !== mode, mode);
  assert.equal(await library.getAttribute('aria-current'), 'page', 'library Tab keeps its existing catalog action');
  await page.evaluate(() => window.mode.getState().setCatalogView('all'));
  const libraryScroll = page.locator('.library-home .catalog-scroller').first();
  await libraryScroll.evaluate(el => { el.scrollTop = 400; });
  await page.waitForTimeout(100);
  const scroll = await libraryScroll.evaluate(el => el.scrollTop);
  await projects.click();
  const projectPage = page.getByRole('region', { name: '项目管理' });
  await projectPage.locator('.project-manager-card').first().waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0, 'project directory is a page, not a dialog');
  assert.equal(await page.locator('.app-modal-backdrop').count(), 0);
  assert.equal(await projects.getAttribute('aria-current'), 'page');
  await page.keyboard.press('Tab');
  assert.equal(await projects.getAttribute('aria-current'), 'page', 'Tab never switches home pages');
  await page.getByRole('textbox', { name: '搜索项目' }).fill('品牌');
  const filtered = await projectPage.locator('.project-manager-card').count();
  assert.ok(filtered > 0 && filtered < 18);
  await page.getByRole('button', { name: '列表视图', exact: true }).click();
  await library.click();
  assert.equal(await page.evaluate(() => window.mode.getState().mode), 'all');
  assert.equal(await libraryScroll.evaluate(el => el.scrollTop), scroll, 'library position survives page switching');
  await projects.click();
  assert.equal(await page.getByRole('textbox', { name: '搜索项目' }).inputValue(), '品牌');
  assert.equal(await page.getByRole('button', { name: '列表视图', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.getByRole('textbox', { name: '搜索项目' }).fill('');
  await page.getByRole('button', { name: '网格视图', exact: true }).click();
  await mkdir('.tmp/home-navigation', { recursive: true });
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    for (const width of [1440, 900, 800]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(200);
      const top = await nav.boundingBox(), content = await projectPage.boundingBox();
      assert.ok(content.y >= top.y + top.height, 'navigation stays above content');
      assert.ok(content.width > width - 4 && content.x >= 0, 'projects occupy the full main area');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: `.tmp/home-navigation/projects-${theme}-${width}.png` });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await projectPage.getByRole('button', { name: /^打开项目 / }).first().click();
  await page.getByRole('region', { name: '项目画布预览' }).waitFor();
  await page.getByRole('button', { name: '返回主页', exact: true }).click();
  await projectPage.waitFor();
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  await page.getByRole('region', { name: '项目画布预览' }).waitFor();
  assert.equal(await page.evaluate(() => window.store.getState().projects.length), 19);
  await page.getByRole('button', { name: '返回主页', exact: true }).click();
  await library.click();
  await page.screenshot({ path: '.tmp/home-navigation/library-light-1440.png' });
  assert.deepEqual(errors, []); assert.deepEqual(remote, []);
  console.log('PASS home preview: peer navigation, inline projects, preserved state, existing library Tab, project opening/creation, dark/light 800–1440px');
} finally { await browser.close(); await server.close(); }
