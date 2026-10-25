import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ server: { host: '127.0.0.1', port: 1802, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1050, height: 700 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:1802/scripts/fixtures/app-updater/preview.html');
  await page.getByRole('button', { name: '检查更新', exact: true }).waitFor();
  const secret = 'TypeError { request_id: secret-123, url: https://private.test, path: C:\\Private\\file }';
  await page.evaluate(raw => { window.failures = { 'plugin:updater|check': raw }; }, secret);
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '暂时无法检查更新' }).waitFor();
  assert.doesNotMatch(await page.locator('body').innerText(), /secret-123|TypeError|private.test|Private/);

  await page.evaluate(() => { window.failures = {}; });
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await page.getByRole('button', { name: '下载更新', exact: true }).click();
  await page.waitForFunction(() => typeof window.finishDownload === 'function');
  await page.evaluate(() => window.finishDownload());
  await page.getByRole('button', { name: '安装并重启', exact: true }).waitFor();
  await page.evaluate(raw => { window.failures = { 'plugin:updater|install': raw }; }, secret);
  await page.getByRole('button', { name: '安装并重启', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '更新尚未安装' }).waitFor();
  assert.equal(await page.evaluate(() => window.updater.getState().phase), 'ready');
  assert.equal(await page.evaluate(() => window.calls.includes('plugin:process|restart')), false);

  // All three notification entry points must have the same final safety boundary.
  await page.evaluate(raw => window.notifyError(raw, '素材未保存，请重试。'), secret);
  await page.getByRole('status').filter({ hasText: '素材未保存，请重试。' }).waitFor();
  await page.getByRole('button', { name: '关闭通知', exact: true }).click();
  await page.evaluate(raw => window.notify(raw, 'error'), secret);
  await page.getByRole('status').filter({ hasText: '操作未完成，请稍后重试。' }).waitFor();
  await page.getByRole('button', { name: '关闭通知', exact: true }).click();
  await page.evaluate(raw => window.dispatchEvent(new CustomEvent('bowerbird://notify', { detail: { id: 999, tone: 'error', message: raw } })), secret);
  await page.getByRole('status').filter({ hasText: '操作未完成，请稍后重试。' }).waitFor();
  assert.doesNotMatch(await page.locator('body').innerText(), /secret-123|TypeError|private.test|Private/);
  await page.getByRole('button', { name: '关闭通知', exact: true }).click();
  await page.evaluate(() => window.notify('已导入素材 Design_v2.png', 'success'));
  await page.getByRole('status').filter({ hasText: '已导入素材 Design_v2.png' }).waitFor();
  await mkdir('.tmp/user-error', { recursive: true });
  await page.screenshot({ path: '.tmp/user-error/notification-update.png' });
  await page.goto('http://127.0.0.1:1802/scripts/fixtures/project-drop/preview.html');
  await page.waitForFunction(() => !!window.store);
  await page.evaluate(raw => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (command, args) => command === 'remove_assets_from_project' ? Promise.reject(raw) : invoke(command, args);
    window.store.setState({ mode: 'manage', activeProjectId: 'p', selectedIds: new Set(['owned']) });
  }, secret);
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('button', { name: '仅移出当前项目', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '删除未完成，请稍后重试。' }).waitFor();
  assert.doesNotMatch(await page.locator('body').innerText(), /secret-123|TypeError|private.test|Private/);
  assert.equal(await page.evaluate(() => window.store.getState().selectedIds.has('owned')), true, 'failed deletion keeps selection available for retry');
  assert.deepEqual(errors, []);
  console.log('PASS updater, batch deletion and all notification entry points; retry state, selection and user filenames preserved');
} finally { await browser.close(); await server.close(); }
