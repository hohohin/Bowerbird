import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ server: { host: '127.0.0.1', port: 1597, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  const preview = 'http://127.0.0.1:1597/scripts/fixtures/canvas-reference/preview.html';
  await page.goto(preview);
  await page.waitForFunction(() => document.querySelector('.canvas-workspace[aria-busy="false"]'));
  await page.evaluate(() => window.store.setState({
    boardOpen: true, activeGenProvider: 'codex',
    cloudAuth: { cloud_available: true, logged_in: true },
    cloudEntitlement: { policy: { can_use_byo: true, max_parallel_jobs: 1 }, balances: { daily: 100, sub: 0, topup: 0 } },
    codexHealth: { ok: false, reason: '未检测到 codex CLI' },
  }));
  const dock = page.locator('.creation-dock');
  const send = dock.getByRole('button', { name: '生成图像', exact: true });
  const tooltip = dock.getByRole('tooltip');
  await dock.locator('.ProseMirror').fill('画一只鸟');
  assert.equal(await send.isDisabled(), true);
  assert.equal(await tooltip.isVisible(), false);
  await send.locator('..').hover();
  await tooltip.waitFor({ state: 'visible' });
  assert.match(await tooltip.innerText(), /ChatGPT\s*自有订阅/);
  assert.match(await tooltip.innerText(), /尚未安装/);
  assert.equal(await dock.getByText('请先登录账号或选择可用引擎', { exact: true }).count(), 0);
  await page.mouse.move(0, 0);
  await send.locator('..').focus();
  assert.equal(await tooltip.isVisible(), true, 'keyboard focus exposes disabled reason');
  assert.equal(await send.getAttribute('aria-describedby'), await tooltip.getAttribute('id'));
  await page.evaluate(() => window.store.setState({ codexHealth: { ok: false, reason: 'Bowerbird 的 Codex 未登录' } }));
  await page.waitForFunction(() => document.querySelector('[role="tooltip"]')?.textContent.includes('自有订阅未登录'));
  await page.evaluate(() => window.store.setState({ codexHealth: { ok: true, reason: '' } }));
  await page.waitForFunction(() => !document.querySelector('.generation-send-button').disabled);
  assert.equal(await tooltip.count(), 0);
  await dock.locator('.ProseMirror').fill('');
  await send.locator('..').hover();
  assert.match(await tooltip.innerText(), /请先输入创作要求/);
  await dock.locator('.ProseMirror').fill('画一只鸟');
  const cases = [
    [{ activeGenProvider: 'jimeng', dreaminaHealth: { ok: false, reason: '即梦未登录' } }, /即梦自有订阅未登录/],
    [{ activeGenProvider: 'bowerbird-cloud', cloudAuth: { cloud_available: false, logged_in: true } }, /未配置 Bowerbird Cloud/],
    [{ cloudAuth: { cloud_available: true, logged_in: false } }, /尚未登录 Bowerbird/],
    [{ cloudAuth: { cloud_available: true, logged_in: true }, cloudEntitlement: { balances: { daily: 0, sub: 0, topup: 0 } } }, /积分不足/],
    [{ activeGenProvider: 'codex', cloudEntitlement: { policy: { can_use_byo: false }, balances: { daily: 100, sub: 0, topup: 0 } } }, /自有订阅需要 Pro/],
    [{ cloudEntitlement: { policy: { can_use_byo: true, max_parallel_jobs: 1 }, balances: { daily: 100, sub: 0, topup: 0 } }, genJobs: { busy: { id: 'busy', running: true } } }, /并行生成上限/],
  ];
  for (const [state, expected] of cases) {
    await page.evaluate(state => window.store.setState(state), state);
    await send.locator('..').hover();
    await tooltip.waitFor({ state: 'visible' });
    assert.equal(await send.isDisabled(), true);
    assert.match(await tooltip.innerText(), expected);
    if (state.activeGenProvider === 'jimeng') {
      await page.mouse.move(0, 0);
      const notice = dock.getByRole('status').filter({ hasText: /即梦自有订阅未登录/ });
      assert.equal(await notice.isVisible(), true);
      await dock.locator('.ProseMirror').press('Control+Enter');
      assert.equal(await page.evaluate(() => Object.keys(window.store.getState().genJobs).length), 0);
      await notice.getByRole('button', { name: '配置自有订阅' }).click();
      assert.equal(await page.evaluate(() => window.store.getState().subscriptionSettingsTarget), 'jimeng');
    }
  }
  await page.goto(preview + '?detail-route');
  await page.waitForFunction(() => document.querySelector('.canvas-workspace[aria-busy="false"]'));
  await page.evaluate(() => window.store.setState({
    activeGenProvider: 'jimeng', boardOpen: true, cloudAuth: { cloud_available: true, logged_in: true },
    cloudEntitlement: { policy: { can_use_byo: true }, balances: { daily: 100, sub: 0, topup: 0 } },
    dreaminaHealth: { ok: false, reason: '即梦未登录' },
  }));
  await dock.getByRole('button', { name: '配置自有订阅' }).click();
  const settings = page.getByRole('dialog').filter({ hasText: '使用自有即梦订阅' });
  await settings.locator('[data-modal-autofocus]').filter({ hasText: '使用自有即梦订阅' }).waitFor();
  await settings.getByRole('button', { name: '关闭', exact: true }).click();
  await settings.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  console.log('PASS: specific CLI/auth/permission/credit/concurrency reasons, hover and keyboard tooltip, recovery and empty prompt');
} finally {
  await browser.close();
  await server.close();
}
