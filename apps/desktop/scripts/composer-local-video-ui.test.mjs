import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
await mkdir('.tmp/composer-local-video', { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 1726, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(15000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:1726/scripts/fixtures/canvas-reference/preview.html?source-library');
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const originalAssets = await invoke('get_assets_by_ids', { assetIds: ['a', 'b', 'c', 'existing'] });
    const assets = originalAssets.map(asset => ({ ...asset, ext: 'png', store_path: '/mock/' + asset.id + '.png' }));
    const imageSources = Object.fromEntries(originalAssets.map(asset => ['/mock/' + asset.id + '.png', asset.store_path]));
    const convert = window.__TAURI_INTERNALS__.convertFileSrc;
    window.__TAURI_INTERNALS__.convertFileSrc = path => imageSources[path] || convert(path);
    window.environmentPhase = 'missing'; window.localCalls = []; window.environmentCalls = [];
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'get_assets_by_ids') return (await invoke(command, args)).map(asset => assets.find(value => value.id === asset.id) || asset);
      if (command === 'dreamina_video_models') return ['seedance2.5', 'seedance2.0', 'seedance2.0mini'].map(model_version => ({ model_version, resolutions: ['720p', '1080p'], min_duration: 4, max_duration: 30 }));
      if (command === 'dreamina_credit_balance') return 100;
      if (command === 'comfy_video_environment') {
        window.environmentCalls.push(args);
        if (args.action === 'install') window.environmentPhase = 'ready';
        return { phase: window.environmentPhase, message: window.environmentPhase === 'ready' ? '环境已就绪' : '本机环境尚未设置好', endpoint: 'http://127.0.0.1:8199', directory: 'D:/Mock-Comfy', canInstall: true, installed: window.environmentPhase === 'ready', existing: [], downloadBytes: 100, requiredBytes: 200, completedBytes: 0, totalBytes: 100 };
      }
      if (command === 'comfy_video') { window.localCalls.push(args); return { status: args.action === 'start' ? 'queued' : 'unknown', message: '合成任务，等待恢复' }; }
      return invoke(command, args);
    };
    window.store.setState({ assets, promptedAssets: assets, codexHealth: { ok: true }, dreaminaHealth: { ok: true }, cloudAuth: { user_id: 'local-tester', logged_in: true, cloud_available: true }, cloudEntitlement: { user_id: 'local-tester', tier: 'pro', offline_state: 'fresh', balances: { daily: 0, sub: 0, topup: 0 }, policy: { can_use_byo: true, can_use_cloud: true } } });
  });
  const dock = page.locator('.composer-glass'), editor = dock.locator('.ProseMirror');
  await dock.getByRole('button', { name: '展开创作描述', exact: true }).click();
  await editor.fill('镜头缓慢推进，保持主体稳定。');
  await page.keyboard.press('End');
  for (const assetId of ['a', 'b', 'c']) {
    await page.evaluate(assetId => window.dispatchEvent(new CustomEvent('bowerbird://board-asset-picked', { detail: { assetId } })), assetId);
    await editor.locator(`[data-asset-id="${assetId}"]`).waitFor();
  }
  await dock.getByRole('button', { name: '视频', exact: true }).click();
  await dock.locator('.model-select-trigger').click();
  const menu = page.getByRole('dialog', { name: '视频模型', exact: true });
  assert.equal(await menu.locator('.model-select-column').count(), 2);
  await menu.locator('[data-model-key="local:h3"]').click();
  const preview = page.getByRole('dialog', { name: '首尾帧预览', exact: true });
  await preview.waitFor();
  assert.deepEqual(await preview.locator('img').evaluateAll(nodes => nodes.map(node => node.alt)), ['首帧：合成参考 a', '尾帧：合成参考 b']);
  assert.ok((await preview.getByRole('status').innerText()).includes('其余 1 个参考素材'));
  assert.equal(await editor.locator('button').count(), 0, 'image references have no delete buttons');
  const environment = dock.locator('.composer-environment');
  await environment.getByText('环境未就绪，点击配置', { exact: true }).waitFor();
  assert.equal(await dock.locator('.generation-send-button').isDisabled(), true);
  assert.equal(await dock.locator('.composer-toolbar .composer-environment').count(), 1);
  await editor.focus(); await page.keyboard.press('Control+Enter');
  assert.equal(await page.evaluate(() => window.localCalls.length), 0, 'shortcut cannot bypass unavailable environment');
  async function assertSingleRow() {
    const result = await dock.locator('.composer-toolbar').evaluate(toolbar => {
      const rect = toolbar.getBoundingClientRect();
      const controls = [...toolbar.querySelectorAll('.composer-video-fields > *, .composer-environment, .composer-frames-trigger, .composer-add-material, .composer-help, .composer-send')].map(el => el.getBoundingClientRect()).filter(r => r.width && r.height);
      return { height: rect.height, inside: controls.every(r => r.x >= rect.x && r.right <= rect.right + 1), centers: controls.map(r => r.y + r.height / 2), overlap: controls.some((r, i) => controls.some((s, j) => i < j && r.x < s.right - 1 && s.x < r.right - 1)) };
    });
    assert.ok(result.height < 62 && result.inside && !result.overlap, JSON.stringify(result));
    assert.ok(result.centers.every(center => Math.abs(center - result.centers[0]) < 1), 'all controls share one footer row');
  }
  for (const width of [1600, 1240, 900]) {
    await page.setViewportSize({ width, height: 800 });
    await assertSingleRow();
    await dock.screenshot({ path: `.tmp/composer-local-video/unavailable-${width}.png` });
  }
  await page.setViewportSize({ width: 1600, height: 1000 });
  await environment.click();
  const config = page.getByRole('dialog', { name: '本地部署工作流环境设置', exact: true });
  await config.getByRole('button', { name: '安装', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.composer-glass .generation-send-button').disabled);
  assert.equal(await config.isVisible(), false);
  assert.equal(await dock.locator('.composer-heading').isVisible(), true, 'configuration focus keeps composer expanded');
  await assertSingleRow();
  await editor.focus(); await page.keyboard.press('End');
  for (let i = 0; i < 3 && await editor.locator('[data-asset-id="c"]').count(); i++) await page.keyboard.press('Backspace');
  assert.equal(await editor.locator('[data-asset-id="c"]').count(), 0, 'Backspace removes the editor reference');
  assert.equal(await preview.getByRole('status').count(), 0, 'warning follows editor deletion');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('bowerbird://board-asset-picked', { detail: { assetId: 'c' } })));
  await preview.getByRole('status').waitFor();
  await page.evaluate(() => window.store.setState({ cloudEntitlement: { ...window.store.getState().cloudEntitlement, offline_state: 'expired' } }));
  assert.equal(await dock.locator('.generation-send-button').isDisabled(), true, 'expired entitlement blocks local generation');
  await page.evaluate(() => window.store.setState({ cloudEntitlement: { ...window.store.getState().cloudEntitlement, offline_state: 'fresh' } }));
  await page.waitForFunction(() => !document.querySelector('.composer-glass .generation-send-button').disabled);
  // Last-moment environment changes are rechecked before any workflow is created.
  await page.evaluate(() => { window.environmentPhase = 'unavailable'; });
  await dock.locator('.generation-send-button').click();
  await page.waitForFunction(() => document.querySelector('.composer-glass .generation-send-button').disabled);
  assert.equal(await page.evaluate(() => window.localCalls.length), 0);
  await page.evaluate(() => { window.environmentPhase = 'ready'; window.dispatchEvent(new Event('focus')); });
  await page.waitForFunction(() => !document.querySelector('.composer-glass .generation-send-button').disabled);
  await dock.getByLabel('本地视频时长（秒）').fill('6');
  await dock.getByLabel('本地视频比例').selectOption('auto');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.screenshot({ path: `.tmp/composer-local-video/frames-${theme}.png` });
  }
  await dock.locator('.generation-send-button').click();
  await page.waitForFunction(() => window.localCalls.some(call => call.action === 'start'));
  const submitted = await page.evaluate(() => window.localCalls.filter(call => call.action === 'start'));
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].input.firstFrame, 'a'); assert.equal(submitted[0].input.lastFrame, 'b');
  assert.equal(submitted[0].input.seconds, 6); assert.equal(submitted[0].input.ratio, 'auto');
  assert.equal(submitted[0].projectId, 'p');
  await page.waitForFunction(() => !window.store.getState().boardOpen);
  await preview.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.workflow-card.is-comfy-video').count(), 1, 'existing workflow owns progress and recovery');
  const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('workflow-p')).document);
  assert.equal(saved.nodes[0].inputs['first-frame'][0].assetId, 'a');
  assert.equal(saved.nodes[0].inputs['last-frame'][0].assetId, 'b');
  assert.deepEqual(errors, []);
  console.log('PASS composer local H3: two-column menu, first/last mapping, Backspace, status/configuration, shortcut/permission/recheck gates, single row, frozen submission and persistent workflow');
} finally { await browser.close(); await server.close(); }
