import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/topbar-update/vite', server: { host: '127.0.0.1', port: 17965, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
page.setDefaultTimeout(6000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
try {
  await page.goto('http://127.0.0.1:17965/scripts/fixtures/canvas-reference/preview.html?source-library&detail-route&canvas-library');
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  const slot = page.locator('.topbar-update-slot');
  const button = slot.getByRole('button');
  const credits = page.locator('.app-topbar-credits');
  await slot.waitFor();
  await page.evaluate(() => window.store.setState({ cloudAuth: { logged_in: true, user_id: 'test-user', display_name: '测试用户' } }));
  await page.evaluate(async () => { window.updater = (await import('/src/lib/appUpdater.ts')).useAppUpdater; });
  for (const phase of ['idle', 'checking', 'current']) {
    await page.evaluate(phase => window.updater.setState({ phase, update: null, error: null }), phase);
    assert.equal(await button.count(), 0, `${phase}: no false update notice`);
  }
  const before = await credits.boundingBox();
  await page.evaluate(() => window.updater.setState({ phase: 'available', startupPrompt: false, update: { version: '99.1.1', currentVersion: '26.11.202', body: '更新测试' } }));
  await button.waitFor();
  const after = await credits.boundingBox(), notice = await button.boundingBox();
  assert.equal(after.x, before.x, 'notice must not shift credits');
  assert.ok(notice.x + notice.width <= after.x, 'notice precedes Bcoin');
  assert.match(await button.getAttribute('title'), /99\.1\.1/);
  await button.focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await dialog.waitFor();
  assert.equal(await dialog.getByRole('button', { name: '关于我们', exact: true }).getAttribute('aria-current'), 'true');
  await dialog.getByRole('button', { name: '下载更新', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await button.evaluate(element => element === document.activeElement), true);
  for (const [phase, label] of [['downloading', '正在下载更新'], ['ready', '更新已就绪'], ['installing', '正在安装更新'], ['installed', '重启完成更新']]) {
    await page.evaluate(phase => window.updater.setState({ phase }), phase);
    assert.match(await button.getAttribute('aria-label'), new RegExp(label));
  }
  await page.evaluate(() => window.updater.setState({ phase: 'available', error: '下载未完成，请重试。' }));
  assert.equal(await button.isVisible(), true, 'failed download retains the entry');
  await mkdir('.tmp/topbar-update', { recursive: true });
  for (const theme of ['light', 'dark']) for (const width of [1280, 900]) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.setViewportSize({ width, height: 840 });
    await page.waitForTimeout(220);
    const bounds = await button.boundingBox(), balance = await credits.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= balance.x && balance.x + balance.width <= width);
    await page.screenshot({ path: `.tmp/topbar-update/${theme}-${width}.png` });
  }
  await page.evaluate(() => window.updater.setState({ phase: 'current', update: null }));
  assert.equal(await button.count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS topbar update: reserved space, detected-only notice, keyboard/about/focus, progress/retry, light/dark narrow layouts');
} finally { await browser.close(); await server.close(); }
