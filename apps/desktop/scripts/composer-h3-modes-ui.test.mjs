import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

await mkdir('.tmp/h3-modes', { recursive: true });
const server = await createServer({ configFile: false, cacheDir: '.tmp/h3-modes/composer-vite', server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const mode of ['text', 'reference', 'frames']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(15000);
    console.log(`Checking composer ${mode}`);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/canvas-reference/preview.html?source-library`);
    await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
    await page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const originals = await invoke('get_assets_by_ids', { assetIds: ['a', 'b'] });
      const assets = originals.map(asset => ({ ...asset, ext: 'png', store_path: `/mock/${asset.id}.png` }));
      const sources = Object.fromEntries(originals.map(asset => [`/mock/${asset.id}.png`, asset.store_path]));
      const convert = window.__TAURI_INTERNALS__.convertFileSrc;
      window.__TAURI_INTERNALS__.convertFileSrc = path => sources[path] || convert(path);
      window.localCalls = []; window.environmentCalls = [];
      window.__TAURI_INTERNALS__.invoke = async (command, args) => {
        if (command === 'get_assets_by_ids') return args.assetIds.map(id => assets.find(asset => asset.id === id) || { id, ext: 'mp4', store_path: '/mock/result.mp4' });
        if (command === 'dreamina_video_models') return [{ model_version: 'seedance2.5', resolutions: ['720p'], min_duration: 4, max_duration: 30 }];
        if (command === 'dreamina_credit_balance') return 100;
        if (command === 'comfy_video_environment') {
          window.environmentCalls.push(args);
          return { phase: 'ready', mode: args.mode || 'frames', modelsRequired: args.mode === 'reference' ? 4 : 5, message: '环境已就绪', endpoint: 'http://127.0.0.1:8199', directory: 'D:/Mock', installed: true, canInstall: true, existing: [], downloadBytes: 0, requiredBytes: 0, completedBytes: 0, totalBytes: 0 };
        }
        if (command === 'comfy_video') { window.localCalls.push(args); return { status: 'unknown', message: '隔离任务等待恢复' }; }
        return invoke(command, args);
      };
      window.store.setState({ assets, promptedAssets: assets, dreaminaHealth: { ok: true }, cloudAuth: { user_id: 'tester', logged_in: true, cloud_available: true }, cloudEntitlement: { user_id: 'tester', tier: 'pro', offline_state: 'fresh', balances: { daily: 0, sub: 0, topup: 0 }, policy: { can_use_byo: true, can_use_cloud: true } } });
    });
    const dock = page.locator('.composer-glass'), editor = dock.locator('.ProseMirror');
    await dock.getByRole('button', { name: '展开创作描述', exact: true }).click();
    await dock.getByRole('button', { name: '视频', exact: true }).click();
    await editor.fill(mode === 'reference' ? '<Picture 1> 沿着海岸行走' : '海边日落，镜头缓慢推进');
    if (mode !== 'text') {
      await editor.press('End');
      for (const assetId of ['a', 'b']) {
        await page.evaluate(assetId => window.dispatchEvent(new CustomEvent('bowerbird://board-asset-picked', { detail: { assetId } })), assetId);
        await editor.locator(`[data-asset-id="${assetId}"]`).waitFor();
      }
    }
    await dock.locator('.model-select-trigger').click();
    await page.locator('[data-model-key="local:h3"]').click();
    if (mode !== 'frames') {
      await dock.getByLabel('本地视频模式', { exact: true }).click();
      await page.getByRole('option', { name: mode === 'text' ? '文生视频' : '单图', exact: true }).click();
      assert.equal(await dock.getByLabel('本地视频时长（秒）').inputValue(), '5');
      assert.equal(await dock.getByLabel('本地视频分辨率', { exact: true }).innerText(), '768p');
    }
    if (mode === 'text') {
      assert.equal(await page.getByRole('dialog', { name: '首尾帧预览', exact: true }).count(), 0);
      await dock.getByLabel('本地视频比例').click();
      assert.equal(await page.getByRole('option', { name: '自动', exact: true }).count(), 0);
      await page.keyboard.press('Escape');
    }
    if (mode === 'reference') {
      const preview = page.getByRole('dialog', { name: '参考图预览', exact: true });
      assert.equal(await preview.locator('figure').count(), 1);
      assert.ok((await preview.innerText()).includes('<Picture 1>'));
      assert.ok((await preview.getByRole('status').innerText()).includes('其余 1 个参考素材'));
    }
    try { await page.waitForFunction(() => !document.querySelector('.composer-glass .generation-send-button').disabled); }
    catch (error) {
      console.log(await page.evaluate(() => ({ environments: window.environmentCalls, button: document.querySelector('.generation-send-button')?.outerHTML, text: document.querySelector('.composer-glass')?.innerText })));
      throw error;
    }
    for (const width of [1440, 900]) {
      await page.setViewportSize({ width, height: 1000 });
      const fits = await dock.locator('.composer-toolbar').evaluate(el => {
        const bounds = el.getBoundingClientRect();
        const controls = [...el.querySelectorAll('.composer-video-fields > *, .composer-environment, .composer-send')].map(item => item.getBoundingClientRect()).filter(r => r.width && r.height);
        return controls.every(r => r.left >= bounds.left - 1 && r.right <= bounds.right + 1) && !controls.some((r, i) => controls.some((s, j) => i < j && r.left < s.right - 1 && s.left < r.right - 1 && r.top < s.bottom - 1 && s.top < r.bottom - 1));
      });
      if (!fits) { await page.screenshot({ path: `.tmp/h3-modes/overflow-${mode}-${width}.png` }); console.log(await dock.locator('.composer-toolbar').evaluate(el => [...el.querySelectorAll('.composer-video-fields > *, .composer-environment, .composer-send')].map(item => ({label:item.textContent, x:item.getBoundingClientRect().x, width:item.getBoundingClientRect().width})))); }
      assert.ok(fits, `${mode} controls fit ${width}px`);
    }
    await page.screenshot({ path: `.tmp/h3-modes/composer-${mode}.png` });
    await dock.locator('.generation-send-button').click();
    await page.waitForFunction(() => window.localCalls.some(call => call.action === 'start'));
    const result = await page.evaluate(() => ({ calls: window.localCalls.filter(call => call.action === 'start'), environment: window.environmentCalls }));
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].input.mode || 'frames', mode);
    assert.equal(result.calls[0].input.firstFrame, mode === 'text' ? '' : 'a');
    assert.equal(result.calls[0].input.lastFrame, mode === 'frames' ? 'b' : undefined);
    assert.ok(result.environment.some(call => (call.mode || 'frames') === mode));
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('PASS composer H3 three modes: controls, preview, defaults, mode-aware checks, exact input submission and narrow layout');
} finally { await browser.close(); await server.close(); }
