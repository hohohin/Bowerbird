import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({cacheDir: '.tmp/dsh-account-settings/vite', server: {host: '127.0.0.1', port: 0, strictPort:false, hmr: false, watch: null}});
await server.listen();
const browser = await chromium.launch({channel:'chrome', headless:true});
try {
  const page = await browser.newPage();
  await page.goto(server.resolvedUrls.local[0] + 'scripts/fixtures/redemption/preview.html?journey');
  await page.waitForFunction(() => !!window.store);
  await page.evaluate(async () => {
    const ipc = window.__TAURI_INTERNALS__, original = ipc.invoke;
    window.account = {state:'notInstalled'};
    window.opens = [];
    window.attempts = 0;
    ipc.invoke = async (command, args) => {
      if (command === 'plugin:shell|open') { window.opens.push(args.path); return; }
      if (command === 'local_chat_dsh_status') return {localAvailable:true, localMode:'auto'};
      if (command !== 'local_chat_dsh_account') return original(command, args);
      if (args.action === 'logout') window.account = {state:'signedOut'};
      if (args.action === 'start') {
        window.attempts++;
        window.account = {state:'pending', attemptId:'test-' + window.attempts, authorizeUrl:window.nextUrl};
      }
      if (args.action === 'cancel') {
        if (args.attemptId !== window.account.attemptId) throw new Error('stale attempt');
        window.account = {state:'cancelled'};
      }
      return {...window.account};
    };
    const {openProviderSettings} = await import('/src/components/creation/ProviderIssueNotice.tsx');
    openProviderSettings('dsh');
  });
  const card = page.getByRole('region', {name:'DeepSeek 账号授权'});
  const login = card.getByRole('button', {name:'登录授权'});
  await card.getByText('未安装', {exact:true}).waitFor();
  assert.equal(await login.isDisabled(), false, 'free users can prepare their own login in Settings');
  await card.getByText('本机 DSH 对话需要 Pro 或 Studio。').waitFor();
  await login.click();
  await card.getByText('等待授权', {exact:true}).waitFor();
  assert.equal(await page.evaluate(() => window.opens.length), 0);
  const official = 'https://platform.deepseek.com/dsh/authorize?state=synthetic';
  await page.evaluate(url => { window.account.authorizeUrl = url; }, official);
  await page.waitForFunction(() => window.opens.length === 1);
  assert.deepEqual(await page.evaluate(() => window.opens), [official]);
  assert.doesNotMatch(await card.innerText(), /synthetic|https:/);
  await card.getByRole('button', {name:'取消授权'}).click();
  await card.getByText('已取消', {exact:true}).waitFor();
  await login.click();
  await page.evaluate(() => { window.account.authorizeUrl = 'https://example.com/dsh/authorize'; });
  await card.getByRole('alert').waitFor();
  assert.equal(await page.evaluate(() => window.opens.length), 1);
  // Reopening a pending native attempt must neither start another attempt nor reopen its URL.
  await page.evaluate(url => { window.account.authorizeUrl = url; }, official);
  await page.getByRole('dialog', {name:'设置'}).getByRole('button', {name:'关闭', exact:true}).click();
  await page.evaluate(async () => (await import('/src/components/creation/ProviderIssueNotice.tsx')).openProviderSettings('dsh'));
  await card.getByRole('button', {name:'打开授权网页'}).waitFor();
  assert.equal(await page.evaluate(() => window.attempts), 2);
  assert.equal(await page.evaluate(() => window.opens.length), 1);
  await card.getByRole('button', {name:'打开授权网页'}).click();
  await page.waitForFunction(() => window.opens.length === 2);
  await page.evaluate(url => { window.account = {state:'expired'}; window.nextUrl = url; }, official);
  await card.getByText('授权已过期', {exact:true}).waitFor();
  await login.click();
  await page.waitForFunction(() => window.attempts === 3 && window.opens.length === 3);
  await page.evaluate(() => { window.account = {state:'verified'}; });
  await card.getByText('✓ 就绪', {exact:true}).waitFor();
  await page.evaluate(() => { window.account = {state:'unverified'}; });
  await card.getByRole('button', {name:'重新检测 DSH 登录状态'}).click();
  await card.getByText('登录状态待确认', {exact:true}).waitFor();
  assert.equal(await card.getByText('✓ 就绪', {exact:true}).count(), 0);
  await card.getByRole('button', {name:'退出登录'}).click();
  await card.getByRole('button', {name:'重新检测 DSH 登录状态'}).click();
  await card.getByText('未登录', {exact:true}).waitFor();
  await card.getByRole('button', {name:'服务连接设置'}).click();
  const setup = page.getByRole('dialog', {name:'DSH 设置'});
  await setup.getByRole('button', {name:'手动配置服务地址'}).click();
  const authLink = setup.getByLabel('登录链接（可选）');
  const originalTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  for (const theme of ['dark', 'light']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await authLink.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
    assert.equal(await authLink.inputValue(), '');
    assert.match(await authLink.evaluate(element => getComputedStyle(element).borderBottomColor), /^rgb\(/);
  }
  await page.evaluate(value => { document.documentElement.dataset.theme = value; }, originalTheme);
  await setup.getByRole('button', {name:'取消', exact:true}).click();
  await login.click();
  await page.waitForFunction(() => window.attempts === 4 && window.opens.length === 4);
  assert.ok(await page.evaluate(url => window.opens.every(link => link === url), official));
  console.log('PASS DSH model settings: eligibility, install/login, browser URL, cancellation, reopen, verified account and recheck');
} finally { await browser.close(); await server.close(); }
