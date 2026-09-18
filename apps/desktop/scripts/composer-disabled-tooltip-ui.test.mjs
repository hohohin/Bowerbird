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
  await page.goto('http://127.0.0.1:1597/scripts/fixtures/canvas-reference/preview.html');
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
  assert.match(await tooltip.innerText(), /Codex CLI 未就绪.*未检测到 codex CLI.*设置 → 模型设置/s);
  assert.equal(await dock.getByText('请先登录账号或选择可用引擎', { exact: true }).count(), 0);
  await page.mouse.move(0, 0);
  await send.locator('..').focus();
  assert.equal(await tooltip.isVisible(), true, 'keyboard focus exposes disabled reason');
  assert.equal(await send.getAttribute('aria-describedby'), await tooltip.getAttribute('id'));
  await page.evaluate(() => window.store.setState({ codexHealth: { ok: false, reason: 'Bowerbird 的 Codex 未登录' } }));
  await page.waitForFunction(() => document.querySelector('[role="tooltip"]')?.textContent.includes('Codex 未登录'));
  await page.evaluate(() => window.store.setState({ codexHealth: { ok: true, reason: '' } }));
  await page.waitForFunction(() => !document.querySelector('.generation-send-button').disabled);
  assert.equal(await tooltip.count(), 0);
  await dock.locator('.ProseMirror').fill('');
  await send.locator('..').hover();
  assert.match(await tooltip.innerText(), /请先输入创作要求/);
  await dock.locator('.ProseMirror').fill('画一只鸟');
  const cases = [
    [{ activeGenProvider: 'jimeng', dreaminaHealth: { ok: false, reason: '即梦未登录' } }, /即梦 CLI 未就绪.*即梦未登录/s],
    [{ activeGenProvider: 'bowerbird-cloud', cloudAuth: { cloud_available: false, logged_in: true } }, /未配置 Bowerbird Cloud/],
    [{ cloudAuth: { cloud_available: true, logged_in: false } }, /尚未登录 Bowerbird/],
    [{ cloudAuth: { cloud_available: true, logged_in: true }, cloudEntitlement: { balances: { daily: 0, sub: 0, topup: 0 } } }, /积分不足/],
    [{ activeGenProvider: 'codex', cloudEntitlement: { policy: { can_use_byo: false }, balances: { daily: 100, sub: 0, topup: 0 } } }, /自备引擎权限.*升级 Pro/s],
    [{ cloudEntitlement: { policy: { can_use_byo: true, max_parallel_jobs: 1 }, balances: { daily: 100, sub: 0, topup: 0 } }, genJobs: { busy: { id: 'busy', running: true } } }, /并行生成上限/],
  ];
  for (const [state, expected] of cases) {
    await page.evaluate(state => window.store.setState(state), state);
    await send.locator('..').hover();
    await tooltip.waitFor({ state: 'visible' });
    assert.equal(await send.isDisabled(), true);
    assert.match(await tooltip.innerText(), expected);
  }
  assert.deepEqual(errors, []);
  console.log('PASS: specific CLI/auth/permission/credit/concurrency reasons, hover and keyboard tooltip, recovery and empty prompt');
} finally {
  await browser.close();
  await server.close();
}
