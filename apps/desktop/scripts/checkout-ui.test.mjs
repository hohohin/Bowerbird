import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ server: { host: '127.0.0.1', port: 1817, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
  const errors = [], external = [];
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  await page.goto('http://127.0.0.1:1817/scripts/fixtures/checkout/preview.html');
  assert.equal(await page.getByRole('button', { name: '购买暂未开放' }).isDisabled(), true);
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.command === 'cloud_create_checkout').length), 0);
  await page.evaluate(() => { window.enabled = true; window.remount(); });
  const buy = page.getByRole('button', { name: '微信支付', exact: true });
  await buy.waitFor();
  await page.waitForFunction(() => !document.querySelector('button[aria-describedby$="plan-payment"]')?.disabled);
  await page.evaluate(() => { window.mode = 'query-error'; window.remount(); });
  await page.getByRole('button', { name: '重试查询订单' }).waitFor();
  assert.equal(await buy.isDisabled(), true, 'unknown previous order must block a new key');
  await buy.evaluate(button => button.click());
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.command === 'cloud_create_checkout').length), 0);
  await page.evaluate(() => { window.mode = 'success'; });
  await page.getByRole('button', { name: '重试查询订单' }).click();
  await page.waitForFunction(() => !document.querySelector('button[aria-describedby$="plan-payment"]')?.disabled);
  await page.evaluate(() => { window.mode = 'hold'; });
  await buy.evaluate(button => { button.click(); button.click(); });
  await page.waitForFunction(() => !!window.release);
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.command === 'cloud_create_checkout').length), 1);
  await page.evaluate(() => { window.mode = 'success'; window.release(); });
  const dialog = page.getByRole('dialog', { name: '微信支付', exact: true });
  await dialog.getByRole('img', { name: '微信付款二维码' }).waitFor();
  assert.match(await dialog.innerText(), /user-a/);
  assert.match(await dialog.innerText(), /¥39\.00/);
  await dialog.getByRole('button', { name: '关闭', exact: true }).last().click();
  await page.evaluate(() => window.remount());
  await page.getByRole('button', { name: '查看待支付订单' }).click();
  await dialog.getByRole('img', { name: '微信付款二维码' }).waitFor();
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.command === 'cloud_create_checkout').length), 1, 'reopening recovers accepted order');
  await page.evaluate(() => { window.mode = 'query-error'; });
  await dialog.getByRole('button', { name: '查询支付结果' }).click();
  await dialog.getByRole('alert').waitFor();
  assert.doesNotMatch(await dialog.innerText(), /private\.example|query failed/);
  await page.evaluate(() => { window.mode = 'success'; });
  await page.evaluate(() => { Object.values(window.orders)[0].expires_at = new Date(Date.now() - 1000).toISOString(); });
  await dialog.getByRole('button', { name: '查询支付结果' }).click();
  await dialog.getByText('支付时间已到，正在核对结果', { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('img', { name: '微信付款二维码' }).count(), 0);
  assert.equal(await dialog.getByText('订单已关闭', { exact: true }).count(), 0, 'local timer cannot declare closure');
  await page.evaluate(() => { Object.values(window.orders)[0].status = 'paid'; });
  await dialog.getByRole('button', { name: '查询支付结果' }).click();
  await dialog.getByText('支付成功', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.command === 'cloud_sync_entitlement').length), 1);
  await dialog.getByRole('button', { name: '完成' }).click();

  // Lost create response: retry keeps the original business idempotency key.
  await page.evaluate(() => { window.mode = 'lost'; });
  await buy.click();
  await dialog.getByRole('button', { name: '重试原请求' }).waitFor();
  const lostKey = await page.evaluate(() => window.calls.filter(c => c.command === 'cloud_create_checkout').at(-1).args.request.idempotency_key);
  await page.evaluate(() => { window.mode = 'success'; });
  await dialog.getByRole('button', { name: '重试原请求' }).click();
  await dialog.getByRole('img', { name: '微信付款二维码' }).waitFor();
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.command === 'cloud_create_checkout').at(-1).args.request.idempotency_key), lostKey);
  await page.evaluate(() => { Object.values(window.orders).filter(o => o.status === 'pending').forEach(o => { o.status = 'closed'; }); });
  await dialog.getByRole('button', { name: '查询支付结果' }).click();
  await dialog.getByText('订单已关闭', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '关闭', exact: true }).last().click();

  await page.getByRole('radio', { name: '自定义充值金额', exact: true }).check();
  await page.getByLabel('自定义充值金额（元）', { exact: true }).fill('1234');
  await page.getByRole('button', { name: '微信充值', exact: true }).click();
  await dialog.getByRole('img', { name: '微信付款二维码' }).waitFor();
  assert.match(await dialog.innerText(), /¥1234\.00/);
  assert.match(await dialog.innerText(), /24,680 Bcoin/);
  const lastRequest = await page.evaluate(() => window.calls.filter(c => c.command === 'cloud_create_checkout').at(-1).args.request);
  assert.equal(lastRequest.custom_amount_yuan, 1234);
  assert.equal(lastRequest.amount_minor, undefined);
  assert.equal(lastRequest.credits, undefined);
  await mkdir('.tmp/checkout', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await page.screenshot({ path: `.tmp/checkout/${theme}.png` });
  }
  await page.setViewportSize({ width: 375, height: 700 });
  assert.equal(await dialog.locator('.app-modal').evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
  await page.screenshot({ path: '.tmp/checkout/narrow.png' });

  // Account switch removes the QR immediately, and a late create cannot repopulate it.
  await page.evaluate(() => window.switchAccount('user-b'));
  await dialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => !document.querySelector('button[aria-describedby$="plan-payment"]')?.disabled);
  await page.evaluate(() => { window.mode = 'hold'; });
  await buy.click();
  await page.waitForFunction(() => !!window.release);
  await page.evaluate(() => window.switchAccount('user-c'));
  await page.evaluate(() => { window.mode = 'success'; window.release(); });
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('img', { name: '微信付款二维码' }).count(), 0);
  assert.equal(await page.evaluate(() => window.store.getState().cloudEntitlement.user_id), 'user-c');

  // Real standalone account panel, without unrelated canvas fixture dependencies.
  await page.goto('http://127.0.0.1:1817/scripts/fixtures/checkout/preview.html?standalone');
  await page.evaluate(() => { window.enabled = true; window.store.setState({ accountOnboardingForceOpen: true }); window.remount(); });
  const account = page.getByRole('dialog', { name: 'Bowerbird 账号', exact: true });
  await account.getByRole('button', { name: '微信支付', exact: true }).click();
  await dialog.getByRole('img', { name: '微信付款二维码' }).waitFor();
  await dialog.getByRole('button', { name: '查询支付结果' }).focus();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await account.isVisible(), true, 'Escape closes only the payment dialog');
  assert.equal(await account.getByRole('table', { name: 'Free 与 Pro 功能对比' }).count(), 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log('PASS checkout capability, double submit, quote, QR, restore, expiry, paid, unknown retry, custom amount, account isolation and responsive layouts');
} finally { await browser.close(); await server.close(); }
