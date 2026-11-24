import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ server: { host: '127.0.0.1', port: 1798, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 600, height: 300 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const focused = locator => locator.evaluate(element => document.activeElement === element);
  const assertTabWrap = async (first, last) => {
    await first.focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await focused(last), true, 'Shift+Tab wraps to the last usable control');
    await page.keyboard.press('Tab');
    assert.equal(await focused(first), true, 'Tab wraps back to the first usable control');
  };
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('http://127.0.0.1:1798/scripts/fixtures/redemption/preview.html');
  assert.equal(await page.getByText('浏览器扩展', { exact: true }).count(), 0);
  await page.getByText('D:/fixture/BowerbirdLibrary', {exact:true}).waitFor();
  assert.equal(await page.getByText('资料文件夹', {exact:true}).count(), 1);
  await page.getByRole('button', { name: '管理资料文件夹…' }).waitFor();
  await page.getByText('当前版本', {exact:true}).waitFor();
  await page.getByRole('button', { name: '检查更新', exact: true }).waitFor();
  assert.equal(await page.getByText(/界面明暗，切换后立即生效/).count(), 0);
  const modalBody = page.locator('.settings-dialog .app-modal-body');
  const scrolling = await modalBody.evaluate(body => {
    const content = body.querySelector('.overscroll-contain');
    return {
      overlay: document.documentElement.classList.contains('industrial-overlay-scrollbars'),
      bodyOverflow: body.scrollHeight - body.clientHeight,
      contentOverflow: content.scrollHeight - content.clientHeight,
      heights: [innerHeight, getComputedStyle(body.parentElement).maxHeight, body.parentElement.clientHeight, body.clientHeight, content.clientHeight],
      layout: [getComputedStyle(body).display, getComputedStyle(content.parentElement).height, getComputedStyle(content).overflowY],
    };
  });
  assert.ok(scrolling.overlay && scrolling.bodyOverflow === 0 && scrolling.contentOverflow > 0, JSON.stringify(scrolling));
  await page.setViewportSize({ width: 1100, height: 850 });
  await page.getByRole('button', { name: '关于我们', exact: true }).click();
  await page.getByRole('button', { name: '前往官网 ↗', exact: true }).waitFor();
  assert.equal(await page.getByText('当前版本', {exact:true}).count(), 0);
  await page.getByRole('button', { name: '系统设置', exact: true }).click();
  await page.getByRole('radio', { name: /夜间模式/ }).click();
  assert.deepEqual(await page.evaluate(() => { const s = window.store.getState().settings; return [s.board_shift_pick, s.hide_project_assets, s.dreamina_model_version]; }), [true, true, '4.7']);
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await page.evaluate(() => window.store.setState({ dreaminaHealth: { ok: true, reason: '' } }));
  assert.equal(await page.getByText('模型版本', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '4.7', exact: true }).count(), 0);
  await page.evaluate(() => { window.shortcutError = 'HotKey already registered: HotKey { mods: Modifiers(0x0), key: F1, id: 160 }'; });
  await page.getByRole('button', { name: '个性化', exact: true }).click();
  assert.equal(await page.getByText(/创作板打开时，Shift/).count(), 0);
  assert.equal(await page.getByText(/在画板的全局素材栏中隐藏项目素材/).count(), 0);
  await page.getByRole('alert').filter({ hasText: '请换一个组合键' }).waitFor();
  assert.doesNotMatch(await page.getByRole('dialog').innerText(), /HotKey|Modifiers|160/);
  await page.getByRole('button', { name: '区域截图快捷键', exact: true }).click();
  await page.keyboard.press('F2');
  await page.getByRole('button', { name: '重试保存' }).waitFor();
  await page.getByRole('alert').filter({ hasText: '请换一个组合键' }).waitFor();
  assert.equal(await page.evaluate(() => window.store.getState().settings.screenshot_shortcuts.capture), 'F1');
  await page.evaluate(() => { window.shortcutError = null; });
  await page.getByRole('button', { name: '重试保存' }).click();
  await page.waitForFunction(() => window.settings.screenshot_shortcuts.capture === 'F2');
  assert.equal(await page.getByRole('button', { name: '立即截图', exact: true }).count(), 0);
  await page.getByRole('switch', { name: '截图自动保存到素材库' }).click();
  await page.waitForFunction(() => window.settings.screenshot_auto_save === false);
  await page.getByRole('button', { name: '账号管理', exact: true }).click();
  await page.getByText('查看会员方案与充值', {exact:true}).click();
  await page.getByRole('region', { name: 'Plan', exact: true }).waitFor();
  await page.getByRole('region', { name: 'Bcoin 充值', exact: true }).waitFor();
  await page.getByRole('button', {name:'查看积分明细'}).click();
  const panel = page.getByRole('region', { name: '积分明细', exact: true });
  await page.getByText('暂无积分收支', { exact: true }).waitFor();
  await panel.getByText('赠送积分', { exact: true }).waitFor();
  await panel.getByText('充值积分', { exact: true }).waitFor();
  assert.equal(await panel.getByText('历史赠送积分', { exact: true }).count(), 0);
  assert.doesNotMatch(await page.getByRole('dialog').innerText(), /每码可兑换/);
  await page.evaluate(() => {
    const rows = [['confirm', 0, 'image_hd'], ['confirm', 5, 'image_hd'], ['hold', -20, 'image_hd'], ['rollback', 10, 'image_layer_edit'], ['refund', -100, null], ['grant', 100, null], ['expire', -30, null], ['adjust', 3, null], ['future_kind', 1, 'future_service']];
    window.store.setState({ cloudEntitlement: { ...window.free, balances: { daily: 0, sub: 10, topup: 400 }, recent_transactions: rows.map(([kind, amount, service], i) => ({ kind, amount, service, created_at: new Date(Date.UTC(2026, 9, 24, 10, 0) - i * 60000).toISOString() })) } });
  });
  assert.equal(await panel.getByText('余额不变', {exact:true}).count(), 0);
  await panel.getByText('图层修改 · 积分退回', {exact:true}).waitFor();
  await panel.getByText('订单退款 · 积分收回', {exact:true}).waitFor();
  await panel.getByText('积分到期', {exact:true}).waitFor();
  assert.doesNotMatch(await panel.innerText(), /hold|confirm|rollback|image_hd|future_kind|future_service/);
  await mkdir('.tmp/settings-presentation', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ animations: 'disabled', path: `.tmp/settings-presentation/${theme}.png` });
  }
  await page.setViewportSize({ width: 600, height: 650 });
  assert.equal(await page.locator('.app-modal').evaluate(el => el.scrollWidth > el.clientWidth), false);
  await page.screenshot({ animations: 'disabled', path: '.tmp/settings-presentation/narrow.png' });
  await page.evaluate(() => window.store.setState({ cloudEntitlement: null }));
  await panel.getByText(/积分信息暂不可用/).waitFor();

  await page.addInitScript(() => localStorage.setItem('bowerbird.defaultUnderstandProvider', 'bowerbird-cloud'));
  await page.goto('http://127.0.0.1:1798/scripts/fixtures/redemption/preview.html?journey');
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  const gear = page.getByRole('button', { name: '设置', exact: true });
  await page.evaluate(() => window.store.setState({ cloudEntitlement: window.pro }));
  await gear.click();
  await dialog.waitFor();
  const closeSettings = dialog.getByRole('button', { name: '关闭', exact: true });
  await page.waitForFunction(() => window.settings.default_understand_provider === 'bowerbird-cloud');
  assert.equal(await page.evaluate(() => localStorage.getItem('bowerbird.defaultUnderstandProvider')), null);
  assert.equal(await dialog.getByRole('button', { name: '系统设置' }).getAttribute('aria-current'), 'true');
  await assertTabWrap(closeSettings, dialog.getByRole('button', { name: '更改索引库位置…' }));
  await closeSettings.evaluate(element => element.blur());
  await page.keyboard.press('Tab');
  assert.equal(await focused(closeSettings), true);
  await page.evaluate(() => {
    const ipc = window.__TAURI_INTERNALS__, invoke = ipc.invoke;
    ipc.invoke = async (command, args) => {
      if (command === 'plugin:dialog|open') return 'D:/fixture/migration-target';
      if (command === 'migrate_library_root') return new Promise((_, reject) => {
        window.failMigration = () => reject(new Error('迁移未完成，请检查保存位置后重试。'));
      });
      return invoke(command, args);
    };
  });
  await dialog.getByRole('button', { name: '管理资料文件夹…', exact: true }).click();
  const fileMove = page.getByRole('dialog', { name: '迁移 BowerbirdLibrary' });
  await fileMove.waitFor();
  assert.equal(await dialog.getByRole('button', { name: '更改索引库位置…' }).isDisabled(), true);
  await fileMove.getByRole('button', { name: '关闭', exact: true }).last().click();
  await dialog.getByRole('button', { name: '更改索引库位置…' }).click();
  await dialog.getByRole('button', { name: '开始迁移', exact: true }).click();
  assert.equal(await dialog.getByRole('button', { name: '管理资料文件夹…', exact: true }).isDisabled(), true);
  await page.evaluate(() => window.failMigration());
  await dialog.getByRole('alert').filter({ hasText: '迁移未完成' }).waitFor();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();

  await page.evaluate(() => window.store.setState({
    cloudEntitlement: { ...window.pro, balances: { daily: 0, sub: 0, topup: 0 } },
  }));
  await page.getByRole('button', { name: '设置，反推模型未就绪' }).click();
  assert.equal(await dialog.getByRole('button', { name: /模型设置/ }).getAttribute('aria-current'), 'true');
  await dialog.getByText(/请连接上方的 ChatGPT 订阅/).waitFor();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();

  await page.locator('.topbar-account-trigger').click();
  const accountLogout = dialog.getByRole('button', { name: '登出账号', exact: true });
  await accountLogout.waitFor();
  await assertTabWrap(closeSettings, accountLogout);
  await dialog.getByRole('button', { name: '管理自有订阅', exact: true }).click();
  await dialog.getByRole('region', { name: 'DeepSeek 账号授权' }).waitFor();
  await dialog.getByRole('button', { name: '积分明细', exact: true }).click();
  await assertTabWrap(closeSettings, dialog.getByRole('button', { name: '关于我们', exact: true }));
  await dialog.getByRole('button', { name: '账号管理', exact: true }).click();
  await page.evaluate(async () => {
    window.store.setState({ cloudEntitlement: { ...window.pro, offline_state: 'expired' } });
    const { openProviderSettings } = await import('/src/components/creation/ProviderIssueNotice.tsx');
    openProviderSettings('jimeng');
  });
  const dreamina = dialog.getByRole('region', { name: '即梦 账号授权' });
  await dreamina.waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '即梦 账号授权');
  assert.equal(await dialog.count(), 1);
  await dialog.getByText('本机 DSH 对话需要 Pro 或 Studio。').waitFor();
  await dialog.getByRole('button', { name: '服务连接设置' }).click();
  const dshSetup = page.getByRole('dialog', { name: 'DSH 设置' });
  assert.equal(await dshSetup.getByRole('button', { name: '一键连接本机 DSH' }).isDisabled(), true);
  await dshSetup.getByRole('button', { name: '取消', exact: true }).click();
  await page.evaluate(() => window.store.setState({ cloudEntitlement: { ...window.pro, user_id: 'other-user' } }));
  await dialog.getByText('本机 DSH 对话需要 Pro 或 Studio。').waitFor();
  await page.evaluate(() => window.store.setState({ cloudEntitlement: window.pro }));
  await dialog.getByText('本机 DSH 对话需要 Pro 或 Studio。').waitFor({ state: 'hidden' });
  assert.ok(await page.evaluate(() => window.calls.some(c => c.command === 'dreamina_health' && c.args.force)));

  await page.evaluate(() => {
    const ipc = window.__TAURI_INTERNALS__, invoke = ipc.invoke;
    ipc.invoke = async (command, args) => {
      if (command === 'get_settings' && window.deferSettings) await new Promise(resolve => { window.finishSettings = resolve; });
      return invoke(command, args);
    };
    window.deferSettings = true;
    window.settings.auto_analyze_prompt = '旧版自定义提示词';
    window.store.setState({ settings: null });
    void window.store.getState().loadSettings();
  });
  const autoAnalyze = dialog.getByRole('switch', { name: '入库时自动反推' });
  assert.equal(await autoAnalyze.isDisabled(), true);
  await page.waitForFunction(() => !!window.finishSettings);
  await page.evaluate(() => { window.deferSettings = false; window.finishSettings(); });
  await autoAnalyze.click();
  const prompt = dialog.getByLabel('自动反推提示词');
  assert.equal(await prompt.inputValue(), '旧版自定义提示词');
  await prompt.fill('保留这个入库提示词');
  await page.evaluate(() => window.store.getState().loadSettings());
  assert.equal(await prompt.inputValue(), '保留这个入库提示词');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => window.settings.auto_analyze_prompt === '保留这个入库提示词');
  await gear.click();
  await dialog.getByRole('button', { name: '模型设置', exact: true }).click();
  await dialog.getByRole('switch', { name: '入库时自动反推' }).click();
  await page.waitForFunction(() => window.settings.auto_analyze_on_ingest === false);
  assert.equal(await page.evaluate(() => window.settings.auto_analyze_prompt), '保留这个入库提示词');

  await page.evaluate(() => {
    const ipc = window.__TAURI_INTERNALS__, invoke = ipc.invoke;
    ipc.invoke = async (command, args) => {
      if (command === 'dreamina_health') {
        window.healthChecks = (window.healthChecks ?? 0) + 1;
        return new Promise(resolve => { window.finishHealth = () => resolve({ ok: true, reason: '', status: 'ready' }); });
      }
      return invoke(command, args);
    };
  });
  const authorize = dreamina.getByRole('button', { name: '登录授权' });
  await authorize.evaluate(button => { button.click(); button.click(); });
  await dreamina.getByRole('button', { name: '取消授权' }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await dialog.getByRole('button', { name: '关闭', exact: true }).isDisabled(), true);
  assert.equal(await dreamina.getByRole('button', { name: '重新检测即梦状态' }).isDisabled(), true);
  assert.equal(await page.evaluate(() => window.healthChecks), 1);
  await page.evaluate(() => window.finishHealth());
  await dreamina.getByRole('button', { name: '退出登录' }).waitFor();
  await dialog.getByRole('button', { name: '账号管理', exact: true }).click();
  await dialog.getByRole('button', { name: '登出账号', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '登出 Bowerbird 账号？' });
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.evaluate(() => window.calls.some(c => c.command === 'cloud_logout')), false);
  await dialog.getByRole('button', { name: '登出账号', exact: true }).click();
  await confirm.getByRole('button', { name: '确认登出' }).click();
  await dialog.getByText('未登录', { exact: true }).first().waitFor();
  await assertTabWrap(closeSettings, dialog.locator('summary'));
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();

  await page.getByRole('button', { name: '截图工具' }).click();
  await page.getByRole('menuitem', { name: '立即截图', exact: true }).click();
  assert.ok(await page.evaluate(() => window.calls.some(c => c.command === 'screenshot_start')));

  await page.goto('http://127.0.0.1:1798/scripts/fixtures/redemption/preview.html?sidebar');
  const sidebarTrigger = page.getByRole('button', { name: 'test@example.test，账号与设置', exact: true });
  const sidebarLogout = page.getByRole('menuitem', { name: '登出', exact: true });
  const logoutCalls = () => page.evaluate(() => window.calls.filter(call => call.command === 'cloud_logout').length);
  await sidebarTrigger.click();
  await sidebarLogout.click();
  await confirm.waitFor();
  assert.equal(await logoutCalls(), 0);
  const cancelLogout = confirm.getByRole('button', { name: '取消', exact: true });
  await page.waitForFunction(() => document.activeElement?.textContent === '取消');
  await page.keyboard.press('Escape');
  await confirm.waitFor({ state: 'hidden' });
  assert.equal(await focused(sidebarTrigger), true);
  assert.equal(await logoutCalls(), 0);

  await sidebarTrigger.click();
  await sidebarLogout.click();
  await cancelLogout.click();
  assert.equal(await logoutCalls(), 0);
  await sidebarTrigger.click();
  await sidebarLogout.click();
  await confirm.waitFor();
  const originalAuth = await page.evaluate(() => window.store.getState().cloudAuth);
  await page.evaluate(auth => window.store.setState({ cloudAuth: { ...auth, user_id: 'different-user' } }), originalAuth);
  await confirm.waitFor({ state: 'hidden' });
  await page.evaluate(auth => window.store.setState({ cloudAuth: auth }), originalAuth);
  assert.equal(await confirm.count(), 0);
  assert.equal(await logoutCalls(), 0);
  await sidebarTrigger.click();
  await sidebarLogout.click();
  await confirm.getByRole('button', { name: '确认登出' }).click();
  await page.getByRole('button', { name: '未登录，账号与设置', exact: true }).waitFor();
  assert.equal(await logoutCalls(), 1);
  assert.deepEqual(errors, []);
  console.log('PASS: settings Tab wrap, shared logout confirmation, subscription navigation and gating, prompt and preference persistence, migrations and screenshot menu');
} finally { await browser.close(); await server.close(); }
