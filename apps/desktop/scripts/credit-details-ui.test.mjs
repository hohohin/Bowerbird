import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

// Real settings component, synthetic account data only. Never call a payment or account service.
const server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
await server.listen();
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 940 } });
  const errors = [];
  const externalRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') return route.continue();
    externalRequests.push(url.origin + url.pathname);
    return route.abort();
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const port = server.httpServer.address().port;
  await page.goto(`http://127.0.0.1:${port}/scripts/fixtures/redemption/preview.html`);
  await page.getByRole('button', { name: '账号管理', exact: true }).click();
  const details = page.getByRole('region', { name: '积分明细', exact: true });
  const records = details.getByRole('list', { name: '最近积分记录', exact: true });
  const transactions = [
    { kind: 'rollback', amount: 10, service: 'video_hd' },
    { kind: 'confirm', amount: 0, service: 'image_hd' },
    { kind: 'confirm', amount: 5, service: 'image_hd' },
    { kind: 'hold', amount: -20, service: 'image_hd' },
    { kind: 'grant', amount: 200, service: null },
    { kind: 'expire', amount: -30, service: null },
    { kind: 'refund', amount: -100, service: null },
  ].map(tx => ({ ...tx, created_at: '2026-11-02T02:00:00Z' }));
  await page.evaluate(recent_transactions => window.store.setState({ cloudEntitlement: {
    ...window.free, balances: { daily: 30, sub: 800, topup: 400 }, recent_transactions,
  } }), transactions);
  await records.waitFor();
  assert.equal(await records.getByRole('listitem').count(), 6);
  const rowText = await records.getByRole('listitem').allTextContents();
  for (const [index, purpose, amount] of [
    [0, '视频生成 · 积分退回', '+10 Bcoin'],
    [1, '图片生成 · 高清 · 积分退回', '+5 Bcoin'],
    [2, '图片生成 · 高清', '−20 Bcoin'],
    [3, '积分到账', '+200 Bcoin'],
    [4, '积分到期', '−30 Bcoin'],
    [5, '订单退款 · 积分收回', '−100 Bcoin'],
  ]) {
    assert.ok(rowText[index].includes(purpose));
    assert.ok(rowText[index].includes(amount));
    assert.match(rowText[index], /2026.*11.*02/);
  }
  assert.match(await details.innerText(), /可用余额\s*1,230\s*Bcoin/);
  assert.match(await details.innerText(), /赠送积分\s*830/);
  assert.match(await details.innerText(), /充值积分\s*400/);
  assert.doesNotMatch(await details.innerText(), /预留|结算|不再次|余额不变|历史每日|如何看懂|hold|confirm|rollback/);
  await mkdir('.tmp/credit-details', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await details.screenshot({ animations: 'disabled', path: `.tmp/credit-details/${theme}.png` });
  }
  await page.setViewportSize({ width: 600, height: 850 });
  assert.equal(await details.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
  await details.screenshot({ animations: 'disabled', path: '.tmp/credit-details/narrow.png' });

  await page.evaluate(() => window.store.setState({ cloudEntitlement: { ...window.free,
    recent_transactions: [{ kind: 'confirm', amount: 0, service: 'image_hd', created_at: '2026-11-02T02:00:00Z' }],
  } }));
  await details.getByText('暂无积分收支', { exact: true }).waitFor();
  assert.equal(await records.count(), 0);
  await page.evaluate(() => window.store.setState({ cloudEntitlement: null }));
  await details.getByText(/积分信息暂不可用/).waitFor();
  assert.doesNotMatch(await details.innerText(), /可用余额\s*0/);
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(errors, []);
  console.log('PASS: credit details show signed balance changes, hide zero bookkeeping, preserve balances, and fit both themes and narrow settings.');
} finally {
  await browser?.close();
  await server.close();
}
