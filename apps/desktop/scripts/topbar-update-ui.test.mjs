import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/topbar-update/vite', optimizeDeps: { entries: ['scripts/fixtures/canvas-reference/preview.html'] }, server: { host: '127.0.0.1', port: 17965, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
page.setDefaultTimeout(6000);
page.setDefaultNavigationTimeout(60_000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
try {
  await page.goto('http://127.0.0.1:17965/scripts/fixtures/canvas-reference/preview.html?source-library&detail-route&canvas-library');
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  const slot = page.locator('.topbar-update-slot');
  const button = slot.getByRole('button');
  const screenshot = page.getByRole('button', { name: '截图工具', exact: true }).locator('svg');
  const credits = page.locator('.app-topbar-credits');
  await page.evaluate(() => window.store.setState({ cloudAuth: { logged_in: true, user_id: 'test-user', display_name: '测试用户' } }));
  await credits.waitFor();
  await page.evaluate(async () => { window.updater = (await import('/src/lib/appUpdater.ts')).useAppUpdater; });
  for (const phase of ['idle', 'checking', 'current']) {
    await page.evaluate(phase => window.updater.setState({ phase, update: null, error: null }), phase);
    assert.equal(await slot.count(), 0, `${phase}: an absent update occupies no space`);
  }
  const before = await credits.boundingBox();
  await page.evaluate(() => window.updater.setState({ phase: 'downloading', downloaded: 62, total: 100, update: { version: '99.1.1', currentVersion: '26.11.202', body: '更新测试' } }));
  await button.waitFor();
  const ring = button.locator('.topbar-update-ring');
  const arc = button.locator('.topbar-update-progress');
  await button.locator('.lucide-download').waitFor();
  assert.equal(await arc.getAttribute('stroke-dasharray'), '62 100');
  assert.match(await button.getAttribute('aria-label'), /62%/);
  await page.evaluate(() => window.updater.setState({ downloaded: 80 }));
  assert.equal(await arc.getAttribute('stroke-dasharray'), '80 100');
  const after = await credits.boundingBox(), notice = await button.boundingBox();
  assert.equal(after.x, before.x, 'notice must not shift credits');
  assert.ok(notice.x + notice.width <= after.x, 'notice precedes Bcoin');
  assert.match(await button.getAttribute('title'), /99\.1\.1/);
  await button.focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await dialog.waitFor();
  assert.equal(await dialog.getByRole('button', { name: '系统设置', exact: true }).getAttribute('aria-current'), 'true');
  assert.equal(await dialog.getByRole('progressbar').getAttribute('value'), '80');
  assert.equal(await dialog.getByRole('button', { name: '正在下载…', exact: true }).isDisabled(), true);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await button.evaluate(element => element === document.activeElement), true);
  await page.evaluate(() => window.updater.setState({ total: null }));
  assert.doesNotMatch(await button.getAttribute('aria-label'), /%/);
  assert.equal(await arc.getAttribute('stroke-dasharray'), '25 100');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await ring.evaluate(element => getComputedStyle(element).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  assert.equal(await ring.evaluate(element => getComputedStyle(element).animationName), 'spin');

  await page.evaluate(() => window.updater.setState({ phase: 'ready' }));
  await button.locator('.lucide-circle-arrow-up').waitFor();
  assert.equal(await ring.count(), 0);
  assert.equal(await dialog.count(), 0, 'verified download never opens the panel');
  await button.click();
  await dialog.getByRole('button', { name: '安装并重启', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.calls.some(call => call.command === 'plugin:updater|install' || call.command === 'plugin:process|restart')), false);
  for (const [phase, label] of [['ready', '更新已就绪'], ['installing', '正在安装更新'], ['installed', '重启完成更新']]) {
    await page.evaluate(phase => window.updater.setState({ phase }), phase);
    assert.match(await button.getAttribute('aria-label'), new RegExp(label));
    if (phase === 'installing') {
      await page.keyboard.press('Escape');
      assert.equal(await dialog.isVisible(), true);
    }
  }
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await page.evaluate(() => window.updater.setState({ phase: 'available', error: '下载未完成，请重试。' }));
  assert.equal(await button.isVisible(), true, 'failed download retains the entry');
  await button.click();
  await dialog.getByRole('button', { name: '重新下载', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await button.blur();
  await mkdir('.tmp/app-updater-background', { recursive: true });
  for (const theme of ['light', 'dark']) for (const width of [1280, 900]) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.setViewportSize({ width, height: 840 });
    const icon = await screenshot.boundingBox();
    assert.deepEqual([icon.width, icon.height], [20, 20], 'the screenshot icon keeps its full size');
    await page.evaluate(() => window.updater.setState({ phase: 'downloading', downloaded: 62, total: 100, error: null }));
    await ring.waitFor();
    const blue = await arc.evaluate(element => getComputedStyle(element).stroke);
    const bounds = await button.boundingBox(), balance = await credits.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= balance.x && balance.x + balance.width <= width);
    await page.screenshot({ path: `.tmp/app-updater-background/${theme}-${width}-downloading.png` });
    await page.evaluate(() => window.updater.setState({ phase: 'ready' }));
    await button.locator('.lucide-circle-arrow-up').waitFor();
    await page.waitForFunction(color => getComputedStyle(document.querySelector('.topbar-update-button')).color === color, blue);
    await page.screenshot({ path: `.tmp/app-updater-background/${theme}-${width}-ready.png` });
  }
  await page.evaluate(() => window.updater.setState({ phase: 'current', update: null }));
  assert.equal(await slot.count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS topbar update: no empty slot, screenshot icon size, download ring, reduced motion, blue install icon, System settings focus and retry, light/dark narrow layouts');
} catch (error) { console.error(error, errors); throw error; } finally { await browser.close(); await server.close(); }
