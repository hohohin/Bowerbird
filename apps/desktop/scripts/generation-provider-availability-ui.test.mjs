import assert from 'node:assert/strict';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
import { createServer } from 'vite';

const entry = 'scripts/fixtures/home-navigation-live/preview.html';
const server = await createServer({ cacheDir: '.tmp/generation-provider-vite', optimizeDeps: { entries: [entry] },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 960 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto(`${server.resolvedUrls.local[0]}${entry}?detail-route&source-library&canvas-library`);
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await page.evaluate(async () => {
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { api } = await import('/src/lib/api.ts');
    const signedOut = { ok: false, reason: 'Bowerbird 的即梦未登录，请在设置中登录' };
    window.createCount = 0;
    api.codexCreateImage = async () => { window.createCount++; throw Error('隔离测试意外提交'); };
    api.dreaminaHealth = async () => ({ ok: true, reason: '' }); // successful recheck in Settings
    const store = window.store;
    store.setState({ defaultProvider: 'jimeng', activeGenProvider: 'jimeng', dreaminaHealth: signedOut,
      cloudAuth: { logged_in: true, cloud_available: true }, codexHealth: { ok: true, reason: '' },
      cloudEntitlement: { policy: { can_use_byo: true, max_parallel_jobs: 2 }, balances: { daily: 100, sub: 0, topup: 0 } } });
    const controller = canvasWorkflowController('p');
    await controller.load();
    const draft = { ...newWorkflowNode('generation', 100, 120, store.getState().defaultProvider), id: 'default-image', prompt: '画一只鸟' };
    // Old video cards may have only media set. The effective video channel defaults to Jimeng
    // even if their saved image model is Codex.
    const video = { ...newWorkflowNode('generation', 530, 120, 'codex'), id: 'default-video', prompt: '飞过树梢', generation: { media: 'video' } };
    const codex = { ...newWorkflowNode('generation', 950, 120, 'codex'), id: 'ready-codex', prompt: '画一张图' };
    await controller.edit([draft, video, codex]);
  });
  const card = page.locator('[data-workflow-card="default-image"]');
  const run = card.getByRole('button', { name: '运行此卡片', exact: true });
  await run.waitFor();
  assert.equal(await run.isDisabled(), true);
  assert.match(await card.innerText(), /即梦.*未登录/);
  const videoRun = page.locator('[data-workflow-card="default-video"]').getByRole('button', { name: '运行此卡片' });
  assert.equal(await videoRun.isDisabled(), true);
  assert.equal(await page.locator('[data-workflow-card="ready-codex"]').getByRole('button', { name: '运行此卡片' }).isEnabled(), true);
  const rejected = await page.evaluate(async () => {
    const before = window.store.getState().genJobOrder;
    try { await window.store.getState().startGeneration('测试默认值', []); }
    catch (error) { return { reason: error.message, unchanged: before === window.store.getState().genJobOrder, calls: window.createCount }; }
  });
  assert.match(rejected.reason, /即梦.*未登录/);
  assert.equal(rejected.unchanged, true);
  assert.equal(rejected.calls, 0);
  await card.getByRole('button', { name: '配置自有订阅' }).click();
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  const target = settings.locator('[data-modal-autofocus]');
  assert.match(await target.innerText(), /使用自有即梦订阅/);
  assert.equal(await settings.getByRole('button', { name: '模型设置' }).getAttribute('aria-current'), 'true');
  // An installed binary can be slow or offline. Only a confirmed missing binary starts a download.
  await page.evaluate(async () => {
    const {api} = await import('/src/lib/api.ts');
    window.authCalls = { installs: 0, logins: 0 };
    api.dreaminaInstall = async () => { window.authCalls.installs++; return { ok: true, reason: '' }; };
    api.dreaminaLoginHeadless = async () => { window.authCalls.logins++; return null; };
    api.dreaminaHealth = async () => window.authChecks.shift();
    window.authChecks = [{ ok: false, status: 'unconfirmed', reason: '暂时无法确认即梦自有订阅状态，请检查网络后重新检测。' }];
  });
  const login = target.getByRole('button', { name: '登录授权', exact: true });
  await login.click();
  await target.getByText(/暂时无法确认即梦自有订阅状态/).waitFor();
  assert.deepEqual(await page.evaluate(() => window.authCalls), { installs: 0, logins: 0 });
  await page.evaluate(() => {
    window.readyHealth = { ok: true, status: 'ready', reason: '' };
    window.authChecks = [window.readyHealth];
  });
  await login.click();
  await target.getByText('已就绪，无需授权').waitFor();
  assert.deepEqual(await page.evaluate(() => window.authCalls), { installs: 0, logins: 0 });
  await page.evaluate(() => {
    window.authChecks = [{ ok: false, status: 'missing', reason: '尚未安装。' },
      { ok: false, status: 'login_required', reason: '请登录。' }, window.readyHealth];
  });
  await login.click();
  await page.waitForFunction(() => window.authCalls.logins === 1 && window.authChecks.length === 0);
  assert.deepEqual(await page.evaluate(() => window.authCalls), { installs: 1, logins: 1 });
  await page.evaluate(async () => {
    const {api} = await import('/src/lib/api.ts');
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (cmd, args) => cmd === 'plugin:shell|open'
      ? (window.openedAuthUrl = args.path) : invoke(cmd, args);
    window.authChecks = [{ok: false, status: 'login_required', reason: '请登录。'}];
    api.dreaminaLoginHeadless = async () => ({verification_uri: 'https://example.test/authorize', user_code: 'ABCD-EFGH', device_code: 'fixture-private'});
    api.dreaminaCheckLogin = device => new Promise(resolve => {
      window.finishDeviceCheck = () => resolve(device === 'fixture-private' ? window.readyHealth : null);
    });
  });
  await login.click();
  await target.getByText('ABCD-EFGH', {exact: true}).waitFor();
  assert.equal(await page.evaluate(() => window.openedAuthUrl), 'https://example.test/authorize');
  assert.doesNotMatch(await target.innerText(), /fixture-private/);
  await page.evaluate(() => window.finishDeviceCheck());
  await target.getByText('✓ 授权成功').waitFor();
  assert.equal(await target.getByText('ABCD-EFGH', {exact: true}).count(), 0);
  assert.equal(await page.evaluate(() => window.authCalls.installs), 1);
  await page.evaluate(() => { window.authChecks = [window.readyHealth]; });
  await settings.getByRole('button', { name: '重新检测即梦状态' }).click();
  await page.waitForFunction(() => window.store.getState().dreaminaHealth.ok);
  await page.keyboard.press('Escape');
  await settings.waitFor({ state: 'hidden' });
  assert.equal(await run.isEnabled(), true);
  assert.equal(await videoRun.isEnabled(), true);
  assert.match(await card.locator('.ProseMirror, textarea').first().evaluate(el => el.value ?? el.textContent), /画一只鸟/);
  assert.equal(await page.evaluate(() => window.createCount), 0);
  for (const [health, reason] of [
    [null, /正在检查即梦/],
    [{ ok: false, reason: '未检测到可用的即梦 CLI，请在自有订阅设置中安装。' }, /尚未安装/],
    [{ ok: false, reason: '暂时无法确认即梦自有订阅状态，请检查网络后重新检测。' }, /请检查网络/],
  ]) {
    await page.evaluate(value => window.store.getState().setDreaminaHealth(value), health);
    assert.match(await card.innerText(), reason);
    assert.equal(await run.isDisabled(), true);
  }
  const concurrent = await page.evaluate(async () => {
    const {canStartAnotherJob, countLimitedGenerationJobs} = await import('/src/lib/entitlement.ts');
    const {api} = await import('/src/lib/api.ts');
    const store = window.store;
    const policy = { can_use_byo: true, can_use_cloud: true, max_parallel_jobs: 4 };
    const entitlement = { policy, balances: { daily: 100, sub: 0, topup: 0 } };
    const seed = { running: true, turns: [], lastPrompt: '', lastRefs: [], streaming: '', refAssets: [], dimAssets: [], createdAt: Date.now() };
    const jobs = Object.fromEntries(Array.from({length: 4}, (_, i) => ['codex-' + i, {...seed, id: 'codex-' + i, provider: 'codex', media: 'image'}]));
    jobs.video = {...seed, id: 'video', provider: 'dreamina', media: 'video'};
    store.setState({ cloudAuth: { logged_in: true, cloud_available: true }, cloudEntitlement: entitlement,
      dreaminaHealth: {status: 'ready', ok: true, reason: ''}, genJobs: jobs, genJobOrder: Object.keys(jobs) });
    const received = [];
    const finishes = [];
    api.codexCreateImage = args => new Promise(resolve => {
      received.push(args.media);
      finishes.push(() => resolve(args.jobId));
    });
    const runs = Array.from({length: 6}, () => store.getState().startGeneration('隔离并发验证', [], null, 'jimeng'));
    const atCapacity = countLimitedGenerationJobs(store.getState().genJobs);
    for (const finish of finishes) finish();
    const completed = await Promise.all(runs);
    return {received, atCapacity, accepted: completed.every(job => job.accepted),
      cloud: canStartAnotherJob(entitlement, atCapacity, 'bowerbird-cloud'),
      free: canStartAnotherJob(null, 0, 'jimeng')};
  });
  assert.deepEqual(concurrent, {received: Array(6).fill('image'), atCapacity: 4, accepted: true, cloud: false, free: false});
  assert.deepEqual(errors, []);
  console.log('PASS default card and store block before submission, direct subscription settings, recheck and draft preservation');
} finally {
  await browser.close();
  await server.close();
}
