import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

// The review server is already running; this script never launches a second one.
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(8000);
const errors = [], remote = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => {
  if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue();
  remote.push(route.request().url()); return route.abort();
});
try {
  await page.goto('http://127.0.0.1:17922/scripts/fixtures/notifications-scrollbars/preview.html');
  const bell = page.locator('.notification-bell-button');
  await bell.waitFor();
  const bellBox = await bell.boundingBox();
  const accountBox = await page.locator('.topbar-account-trigger').boundingBox();
  const updateBox = await page.locator('.topbar-update-slot').boundingBox();
  assert.ok(updateBox.x + updateBox.width <= bellBox.x, 'bell follows the real reserved update slot');
  assert.ok(bellBox.x + bellBox.width <= accountBox.x, 'bell is immediately before Bcoin/account');
  assert.equal(await page.locator('.library-generation-activity').count(), 0, 'old library activity box is absent in the candidate');
  await mkdir('.tmp/notifications-scrollbars', { recursive: true });
  await page.screenshot({ path: '.tmp/notifications-scrollbars/idle-dark-1440.png' });

  await page.getByRole('button', { name: '模拟完成', exact: true }).click();
  await page.getByRole('dialog', { name: '新通知', exact: true }).waitFor();
  assert.equal(await page.locator('.toast-viewport .app-toast').count(), 0, 'generation completion appears only under bell');
  await page.waitForTimeout(240);
  await page.screenshot({ path: '.tmp/notifications-scrollbars/latest-dark-1440.png' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '普通提示', exact: true }).click();
  await page.locator('.toast-viewport').getByText('素材已复制', { exact: true }).waitFor();
  await page.locator('.toast-viewport').getByRole('button', { name: '关闭通知', exact: true }).click();

  for (const width of [900, 1440]) for (const theme of ['dark', 'light']) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await bell.click();
    const panel = page.getByRole('dialog', { name: '通知历史', exact: true });
    await panel.waitFor();
    assert.equal(await panel.getByRole('listitem').count(), 12);
    await page.waitForTimeout(240);
    const bounds = await panel.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y >= 44 && bounds.y + bounds.height < 860, `history stays within app viewport: ${JSON.stringify(bounds)}`);
    await panel.locator('.notification-bell-history').hover();
    await page.mouse.wheel(0, 90);
    await page.waitForFunction(() => document.querySelector('.notification-bell-history').scrollTop > 0);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `.tmp/notifications-scrollbars/bell-${theme}-${width}.png` });
    await panel.getByRole('button', { name: '关闭通知面板', exact: true }).click();
    await page.getByRole('button', { name: '滚动演示', exact: true }).click();
    const vertical = page.getByRole('region', { name: '滚动条演示', exact: true }).locator('.preview-scroll-list');
    await vertical.hover();
    await page.mouse.wheel(0, 300);
    await page.waitForFunction(() => document.querySelector('.preview-scroll-list').scrollTop > 0);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `.tmp/notifications-scrollbars/scroll-${theme}-${width}.png` });
    await page.getByRole('button', { name: '关闭滚动条演示', exact: true }).click();
    await page.getByRole('combobox', { name: '选择项目', exact: true }).click();
    const menu = page.getByRole('listbox', { name: '选择项目', exact: true });
    await menu.waitFor();
    const menuBox = await menu.boundingBox();
    assert.ok(menuBox.x >= 0 && menuBox.x + menuBox.width <= width && menuBox.y >= 0, 'project menu remains in viewport');
    await menu.hover();
    await page.mouse.wheel(0, 90);
    await page.waitForFunction(() => document.querySelector('.library-project-menu').scrollTop > 0);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `.tmp/notifications-scrollbars/menu-${theme}-${width}.png` });
    await menu.getByRole('option', { name: '秋日系列 · 电商海报', exact: true }).click();
    assert.ok((await page.getByRole('combobox', { name: '选择项目', exact: true }).innerText()).includes('秋日系列'));
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(remote, []);
  console.log('PASS: true topbar bell placement, single completion surface, ordinary toast, history/gallery/menu and dark/light 900/1440 layout');
} finally { await browser.close(); }
