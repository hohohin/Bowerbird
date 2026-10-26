import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

// Render the real settings panel with the existing synthetic IPC fixture. No native app or payment API runs.
const server = await createServer({ server: { host: '127.0.0.1', port: 1816, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
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
  await page.goto('http://127.0.0.1:1816/scripts/fixtures/redemption/preview.html');
  await page.getByRole('button', { name: '账号管理', exact: true }).click();
  const plan = page.getByRole('region', { name: 'Plan', exact: true });
  const recharge = page.getByRole('region', { name: 'Bcoin 充值', exact: true });
  const output = recharge.getByLabel('充值到账 Bcoin', { exact: true });
  const custom = recharge.getByRole('radio', { name: /自定义/ });
  const customInput = recharge.getByLabel('自定义充值金额（元）', { exact: true });
  const amountRadio = amount => recharge.getByRole('radio', { name: new RegExp(`^充值 [¥￥]\\s*${amount}(?:\\D|$)`) });
  const displayedBcoin = async () => (await output.innerText()).replace(/[\s,，]/g, '');
  const assertAmount = async amount => {
    assert.equal(await amountRadio(amount).isChecked(), true);
    assert.match(await displayedBcoin(), new RegExp(`^${amount * 20}(?:Bcoin)?$`, 'i'));
  };
  const assertComparison = async section => {
    const table = section.getByRole('table', { name: 'Free 与 Pro 功能对比', exact: true });
    await table.waitFor();
    assert.equal(await table.getByRole('columnheader', { name: /^Free/ }).count(), 1);
    assert.equal(await table.getByRole('columnheader', { name: /^Pro/ }).count(), 1);
    const readCells = async name => table.getByRole('row').filter({ hasText: name }).getByRole('cell').evaluateAll(cells => cells.map(cell =>
      (cell.getAttribute('aria-label') || cell.textContent || '').trim().replace(/\s+/g, ' ')));
    assert.deepEqual(await readCells('素材管理与普通画布'), ['支持', '支持']);
    const cloud = await readCells(/Cloud\s*服务/);
    assert.equal(cloud.length, 2);
    for (const value of cloud) assert.match(value, /按量.*Bcoin/);
    for (const feature of ['自有订阅接入', '工作流卡片', '本地生成']) {
      const cells = await readCells(feature);
      assert.equal(cells.length, 2);
      assert.match(cells[0], /^(?:不支持|—|需 Pro)$/);
      assert.equal(cells[1], '支持');
    }
  };
  const assertSingleRechargeRow = async (section, requireScroll = false) => {
    const group = section.getByRole('group', { name: '充值金额', exact: true });
    const scroll = group.locator('.account-billing-topup-options');
    const layout = await scroll.evaluate(el => ({
      overflowX: getComputedStyle(el).overflowX,
      width: el.clientWidth,
      scrollWidth: el.scrollWidth,
      options: Array.from(el.querySelectorAll('label')).map(label => ({
        top: label.getBoundingClientRect().top,
        text: label.innerText.trim(),
      })),
    }));
    assert.equal(layout.options.length, 7);
    assert.equal(layout.options.every(option => Math.abs(option.top - layout.options[0].top) < 1), true, 'all seven recharge options stay on one row');
    assert.deepEqual(layout.options.slice(0, 6).map(option => option.text), ['¥5', '¥10', '¥20', '¥50', '¥100', '¥500']);
    assert.match(layout.options[6].text, /^自定义(?:金额)?$/);
    assert.match(layout.overflowX, /auto|scroll/, 'overflow is handled inside the amount selector');
    if (requireScroll) {
      assert.equal(layout.scrollWidth > layout.width + 1, true, 'narrow settings show an internally scrollable row');
      await scroll.evaluate(el => { el.scrollLeft = 0; });
      const customRadio = group.getByRole('radio', { name: /自定义/ });
      await customRadio.focus();
      await page.keyboard.press('Space');
      assert.equal(await customRadio.isChecked(), true, 'the final offscreen option remains keyboard reachable');
      assert.equal(await scroll.evaluate(el => el.scrollLeft > 0), true);
    }
  };
  await plan.waitFor();
  await recharge.waitFor();
  const baseline = await page.evaluate(() => ({
    userId: window.store.getState().cloudAuth.user_id,
    tier: window.store.getState().cloudEntitlement.tier,
    balances: window.store.getState().cloudEntitlement.balances,
    calls: window.calls.length,
  }));
  const monthly = plan.getByRole('radio', { name: /39/ });
  const yearly = plan.getByRole('radio', { name: /359/ });
  assert.equal(await monthly.count(), 1);
  assert.equal(await yearly.count(), 1);
  assert.match(await plan.innerText(), /自有订阅/);
  assert.match(await plan.innerText(), /工作流/);
  assert.match(await plan.innerText(), /本地生成/);
  assert.match(await plan.innerText(), /不含|不赠/);
  await assertComparison(plan);
  await yearly.click();
  assert.equal(await yearly.isChecked(), true);
  assert.equal(await monthly.isChecked(), false);
  await yearly.focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await monthly.isChecked(), true, 'Plan periods support keyboard radio selection');
  assert.equal(await yearly.isChecked(), false);

  assert.equal(await recharge.getByRole('radio').count(), 7);
  await assertSingleRechargeRow(recharge);
  await assertAmount(20);
  for (const amount of [5, 10, 20, 50, 100, 500]) {
    await amountRadio(amount).click();
    await assertAmount(amount);
  }
  await amountRadio(20).click();
  await amountRadio(20).focus();
  await page.keyboard.press('ArrowRight');
  await assertAmount(50);
  await page.keyboard.press('ArrowLeft');
  await assertAmount(20);

  await custom.click();
  await customInput.waitFor();
  for (const amount of [1, 7, 25, 1234]) {
    await customInput.fill(String(amount));
    assert.match(await displayedBcoin(), new RegExp(`^${amount * 20}(?:Bcoin)?$`, 'i'));
  }
  for (const invalid of ['', '0', '-1', '1.5', 'abc', '1e3', '450359962737050', '9007199254740992']) {
    await customInput.fill(invalid);
    assert.doesNotMatch(await displayedBcoin(), /\d/, `invalid amount ${JSON.stringify(invalid)} must not show a chargeable credit amount`);
  }
  await customInput.fill('25');
  assert.match(await displayedBcoin(), /^500(?:Bcoin)?$/i);
  await amountRadio(20).click();
  await assertAmount(20);

  for (const section of [plan, recharge]) {
    const purchase = section.getByRole('button').filter({ hasText: /购买|充值|开通|续购/ });
    assert.equal(await purchase.count(), 1);
    assert.equal(await purchase.isDisabled(), true, 'unavailable payment must stay disabled');
    assert.match(await section.innerText(), /未开放|尚未开放/);
    await purchase.evaluate(button => button.click());
  }
  assert.deepEqual(await page.evaluate(() => ({
    userId: window.store.getState().cloudAuth.user_id,
    tier: window.store.getState().cloudEntitlement.tier,
    balances: window.store.getState().cloudEntitlement.balances,
    calls: window.calls.length,
  })), baseline, 'plan/recharge previews must neither invoke IPC nor mutate account funds');

  for (const tier of ['pro', 'studio', 'free']) {
    await page.evaluate(tier => window.store.setState({ cloudEntitlement: { ...window.free, tier,
      balances: { daily: 0, sub: 0, topup: 400 }, policy: { ...window.free.policy, can_use_byo: tier !== 'free' } } }), tier);
    await plan.getByText(`当前方案 · ${tier === 'free' ? 'Free' : tier === 'pro' ? 'Pro' : 'Studio'}`, { exact: true }).waitFor();
    assert.equal(await recharge.getByRole('radio').count(), 7);
    assert.equal(await page.getByRole('button', { name: '领取一次 7 天 Pro 功能体验' }).count(), tier === 'free' ? 1 : 0);
  }
  for (const offline_state of ['expired', 'invalid']) {
    await page.evaluate(offline_state => window.store.setState({ cloudEntitlement: { ...window.free, offline_state } }), offline_state);
    await plan.getByText('权益需刷新', { exact: true }).waitFor();
    assert.equal(await plan.getByText('当前方案 · Free', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '领取一次 7 天 Pro 功能体验' }).count(), 0);
    assert.match(await recharge.locator('.account-billing-balance-value').innerText(), /^—\s*Bcoin$/);
    await page.getByRole('region', { name: '积分明细', exact: true }).getByText(/积分信息暂不可用/).waitFor();
  }
  await page.evaluate(() => window.store.setState({ cloudEntitlement: null }));
  await plan.getByText('权益暂不可用', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '领取一次 7 天 Pro 功能体验' }).count(), 0);
  await page.getByRole('region', { name: '积分明细', exact: true }).getByText(/积分信息暂不可用/).waitFor();
  await page.evaluate(() => window.store.setState({ cloudEntitlement: { ...window.free, balances: { daily: 0, sub: 0, topup: 400 } } }));
  await mkdir('.tmp/account-billing', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.mouse.move(5, 5);
    await page.evaluate(() => document.activeElement?.blur());
    await plan.evaluate(el => el.scrollIntoView({ block: 'start' }));
    await page.screenshot({ animations: 'disabled', path: `.tmp/account-billing/${theme}-plan.png` });
    await recharge.scrollIntoViewIfNeeded();
    await page.screenshot({ animations: 'disabled', path: `.tmp/account-billing/${theme}-recharge.png` });
    await custom.click();
    await customInput.fill('25');
    await customInput.blur();
    await page.mouse.move(5, 5);
    await customInput.scrollIntoViewIfNeeded();
    await page.screenshot({ animations: 'disabled', path: `.tmp/account-billing/${theme}-custom.png` });
    await amountRadio(20).click();
  }
  await page.setViewportSize({ width: 600, height: 650 });
  await assertSingleRechargeRow(recharge, true);
  await amountRadio(20).click();
  await recharge.locator('.account-billing-topup-options').evaluate(el => { el.scrollLeft = 0; });
  for (const section of [plan, recharge]) {
    await section.scrollIntoViewIfNeeded();
    assert.equal(await section.evaluate(el => el.scrollWidth > el.clientWidth + 1), false, 'billing section must fit a narrow settings panel');
  }
  assert.equal(await page.locator('.app-modal').evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
  await page.mouse.move(5, 5);
  await page.evaluate(() => document.activeElement?.blur());
  await recharge.evaluate(el => el.scrollIntoView({ block: 'start' }));
  await page.screenshot({ animations: 'disabled', path: '.tmp/account-billing/narrow.png' });

  await page.evaluate(() => window.store.setState({ cloudAuth: { ...window.store.getState().cloudAuth, logged_in: false }, cloudEntitlement: null }));
  await page.getByRole('button', { name: '登录 Bowerbird 账号', exact: true }).waitFor();
  await plan.getByText('登录后查看方案', { exact: true }).waitFor();
  assert.match(await recharge.locator('.account-billing-balance-value').innerText(), /^—\s*Bcoin$/);
  assert.equal(await page.getByLabel('兑换 Pro', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '领取一次 7 天 Pro 功能体验' }).count(), 0);
  assert.equal(await page.getByRole('region', { name: '积分明细', exact: true }).count(), 0);

  // The independent account dialog uses the same billing component without the settings sidebar.
  const standaloneEntitlement = await page.evaluate(() => ({ ...window.free, tier: 'pro', offline_state: 'fresh',
    balances: { daily: 0, sub: 0, topup: 400 }, policy: { ...window.free.policy, can_use_byo: true } }));
  await page.setViewportSize({ width: 1100, height: 1100 });
  await page.goto('http://127.0.0.1:1816/scripts/fixtures/onboarding/preview.html');
  await page.waitForFunction(() => window.store && window.lesson);
  await page.evaluate(entitlement => {
    window.lesson.getState().show('closed');
    window.store.setState({ activeProjectId: null, cloudAuth: { logged_in: true, cloud_available: true,
      user_id: 'test-user', display_name: '独立账号测试', email: 'test@example.test', avatar_url: null,
      access_expires_at: null, reason: null }, cloudEntitlement: entitlement, cloudBusy: false,
      cloudError: null, accountOnboardingForceOpen: true });
    document.documentElement.dataset.theme = 'light';
  }, standaloneEntitlement);
  const standalone = page.getByRole('dialog', { name: 'Bowerbird 账号', exact: true });
  const standalonePlan = standalone.getByRole('region', { name: 'Plan', exact: true });
  const standaloneRecharge = standalone.getByRole('region', { name: 'Bcoin 充值', exact: true });
  await standalonePlan.getByText('当前方案 · Pro', { exact: true }).waitFor();
  await assertComparison(standalonePlan);
  await standalonePlan.getByRole('radio', { name: /359/ }).click();
  assert.equal(await standalonePlan.getByRole('radio', { name: /359/ }).isChecked(), true);
  await standaloneRecharge.getByRole('radio', { name: /^充值 ¥500，/ }).click();
  assert.equal((await standaloneRecharge.getByLabel('充值到账 Bcoin', { exact: true }).innerText()).replace(/,/g, ''), '10000');
  await standaloneRecharge.getByRole('radio', { name: /自定义/ }).click();
  await standaloneRecharge.getByLabel('自定义充值金额（元）', { exact: true }).fill('25');
  assert.equal(await standaloneRecharge.getByLabel('充值到账 Bcoin', { exact: true }).innerText(), '500');
  assert.equal(await standalone.getByRole('button', { name: '购买暂未开放', exact: true }).isDisabled(), true);
  assert.equal(await standalone.getByRole('button', { name: '充值暂未开放', exact: true }).isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => window.store.getState().cloudEntitlement.balances), { daily: 0, sub: 0, topup: 400 });
  assert.equal(await page.evaluate(() => window.calls.some(call => /checkout|payment|topup|purchase/.test(call.command))), false);
  for (const width of [1100, 600]) {
    await page.setViewportSize({ width, height: 1100 });
    await assertSingleRechargeRow(standaloneRecharge);
    for (const section of [standalonePlan, standaloneRecharge]) {
      assert.equal(await section.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    }
    assert.equal(await standalone.locator('.app-modal').evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
  }
  await page.setViewportSize({ width: 1100, height: 1100 });
  await standaloneRecharge.getByRole('radio', { name: /^充值 ¥20，/ }).click();
  await page.mouse.move(5, 5);
  await page.evaluate(() => document.activeElement?.blur());
  await standaloneRecharge.scrollIntoViewIfNeeded();
  await page.screenshot({ animations: 'disabled', path: '.tmp/account-billing/standalone-account.png' });
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(errors, []);
  console.log('PASS: Free/Pro comparison, Plan periods and keyboard navigation, single-row recharge with local scrolling, safe custom previews, no payment/credit mutation, account states, both themes and independent account dialog');
} finally { await browser.close(); await server.close(); }
