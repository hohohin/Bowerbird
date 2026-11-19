import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ cacheDir: '.tmp/notification-bell-app-vite', optimizeDeps: { entries: ['scripts/fixtures/library-generation-live/preview.html'] },
  server: { host: '127.0.0.1', port: 18946, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(8000);
page.setDefaultNavigationTimeout(60_000);
const errors = [], remote = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => {
  if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue();
  remote.push(route.request().url()); return route.abort();
});
try {
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/library-generation-live/preview.html?source-library&detail-route&canvas-library`);
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  const bell = page.getByRole('button', { name: /^通知/ });
  await bell.waitFor();
  assert.equal(await bell.count(), 1, 'one topbar bell across the real application');
  const slot = await page.locator('.topbar-update-slot').boundingBox();
  const bellBox = await bell.boundingBox();
  const account = await page.locator('.topbar-account-trigger').boundingBox();
  assert.ok(slot.x + slot.width <= bellBox.x + 1 && bellBox.x + bellBox.width <= account.x + 1, 'bell preserves update slot and sits before Bcoin');
  await page.getByRole('button', { name: '返回主页', exact: true }).click();
  await page.getByRole('navigation', { name: '首页' }).getByRole('button', { name: '素材库' }).click();
  const composer = page.getByRole('region', { name: '素材库创作', exact: true });
  await composer.waitFor();
  assert.equal(await page.locator('.library-home-activity').count(), 0, 'former task block removed from actual library');
  const editor = composer.locator('.ProseMirror');
  await editor.fill('检查顶栏通知的真实生成入口');
  await composer.locator('.composer-send button').click();
  await page.waitForFunction(() => window.generationCalls.length === 1);
  assert.equal(await page.evaluate(() => window.store.getState().activeProjectId), null, 'background generation stays in library');
  await editor.fill('留在素材库继续创作的草稿');
  const expected = await page.evaluate(() => window.completeGeneration(0));
  const latest = page.getByRole('status', { name: '新通知' });
  await latest.waitFor();
  assert.equal(await latest.getByRole('listitem').count(), 1);
  assert.equal(await page.locator('.app-toast').filter({ hasText: '图片生成完成' }).count(), 0, 'completion has no duplicate Toast');
  await latest.getByRole('button', { name: /快速生成.*查看画板/ }).click();
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await page.locator(`[data-canvas-node-id="${expected.promptId}"]`).waitFor();
  await page.waitForFunction(id => window.store.getState().focusedThreadId === id, expected.threadId);
  assert.equal(await page.evaluate(() => window.store.getState().activeProjectId), expected.projectId);
  assert.equal(await latest.count(), 0, 'notification closes before destination is shown');
  assert.equal(await bell.count(), 1, 'canvas keeps the same global task entry');
  await page.getByRole('button', { name: '返回主页', exact: true }).click();
  await page.getByRole('navigation', { name: '首页' }).getByRole('button', { name: '素材库' }).click();
  await composer.waitFor();
  assert.ok((await editor.innerText()).includes('继续创作的草稿'));
  await bell.click();
  const history = page.getByRole('dialog', { name: '通知历史' });
  await history.getByRole('button', { name: /生成 · 快速生成.*检查顶栏通知.*已完成/ }).waitFor();
  const asset = await page.evaluate(() => {
    const ipc = window.__TAURI_INTERNALS__;
    const invoke = ipc.invoke;
    ipc.invoke = (command, args) => command === 'codex_describe_asset'
      ? new Promise(resolve => { window.finishDescribe = () => resolve('analysis'); })
      : invoke(command, args);
    const state = window.store.getState();
    const asset = state.assets[0];
    state.runDescribe(asset.id, '提取画面特征', 'codex');
    return { id: asset.id, name: asset.name };
  });
  await history.getByRole('button', { name: `反推 · ${asset.name} · 反推中，查看素材` }).waitFor();
  await page.evaluate(() => window.finishDescribe());
  await history.getByRole('button', { name: `反推 · ${asset.name} · 已完成，查看素材` }).click();
  assert.equal(await page.evaluate(() => window.store.getState().detailAssetId), asset.id);
  await bell.click();
  await history.getByRole('button', { name: `移除通知：${asset.name}` }).click();
  assert.equal(await history.getByRole('button', { name: /^反推 ·/ }).count(), 0);
  await page.keyboard.press('Escape');
  await page.evaluate(async () => { const { notify } = await import('/src/lib/notify.ts'); notify('已保存', 'success'); notify('文件已被占用，请关闭其他程序后重试', 'error'); });
  await page.locator('.app-toast').filter({ hasText: '已保存' }).waitFor();
  await page.locator('.app-toast').filter({ hasText: '文件已被占用' }).waitFor();
  assert.equal(await page.getByRole('status', { name: '新通知' }).count(), 0, 'generic save/error retain formal Toast behavior');
  assert.deepEqual(errors, []); assert.deepEqual(remote, []);
  console.log('PASS production notification bell: actual App/Toolbar/library, reserved update slot, completion channel, exact canvas route, draft, history and ordinary Toast');
} catch (error) {
  console.log('UI errors', errors);
  console.log((await page.locator('body').innerText()).slice(-1500));
  throw error;
} finally { await browser.close(); await server.close(); }
