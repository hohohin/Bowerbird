import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 1653, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:1653/scripts/fixtures/redemption/preview.html');
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await page.evaluate(() => {
    const ipc = window.__TAURI_INTERNALS__, original = ipc.invoke;
    window.codexLoggedIn = true;
    window.logoutMode = 'error';
    window.codexCalls = [];
    ipc.invoke = async (command, args) => {
      if (!['codex_health', 'codex_logout', 'codex_login'].includes(command)) return original(command, args);
      window.codexCalls.push(command);
      if (command === 'codex_logout') {
        if (window.logoutMode === 'error') throw Error('模拟退出失败');
        if (window.logoutMode === 'hold') await new Promise(resolve => { window.releaseLogout = resolve; });
        window.codexLoggedIn = false;
      }
      if (command === 'codex_login') window.codexLoggedIn = true;
      return { ok: window.codexLoggedIn, reason: window.codexLoggedIn ? '' : 'Codex 未登录' };
    };
  });
  const logout = () => page.getByRole('button', { name: '退出登录', exact: true });
  const login = () => page.getByRole('button', { name: '登录授权', exact: true }).first();
  const refresh = () => page.getByRole('button', { name: '重新检测 codex 状态' });
  await refresh().click();
  await page.getByText('✓ 已登录', { exact: true }).waitFor();
  await logout().click();
  await page.getByText('Error: 模拟退出失败', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.store.getState().codexHealth.ok), true, 'failure retains login state');

  await page.evaluate(() => { window.logoutMode = 'hold'; });
  await logout().click();
  await page.getByRole('button', { name: '退出中…', exact: true }).waitFor();
  assert.equal(await login().isDisabled(), true);
  assert.equal(await refresh().isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '退出中…', exact: true }).isDisabled(), true);
  await page.evaluate(() => window.releaseLogout());
  await page.getByText('已退出登录，可以重新授权或更换账号', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.store.getState().codexHealth.ok), false);
  await refresh().click();
  assert.equal(await page.evaluate(() => window.store.getState().codexHealth.ok), false);
  await login().click();
  await page.getByText('✓ 授权成功', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.codexCalls.filter(c => c === 'codex_login').length), 1);
  assert.equal(await page.evaluate(() => window.calls.some(c => c.command === 'codex_install')), false);

  // A broken/stale health check must not hide the recovery entry.
  await page.evaluate(() => {
    window.codexLoggedIn = false; window.logoutMode = 'success';
    window.store.setState({ codexHealth: { ok: false, reason: '登录状态异常' } });
  });
  await logout().click();
  await page.getByText('已退出登录，可以重新授权或更换账号', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.codexCalls.filter(c => c === 'codex_logout').length), 3);
  assert.deepEqual(errors, []);
  console.log('PASS Codex logout: failure/retry, pending controls, cleared state, relogin and stale-auth recovery');
} finally {
  await browser.close();
  await server.close();
}
