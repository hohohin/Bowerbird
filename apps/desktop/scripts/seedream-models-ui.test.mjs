import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
const { chromium } = await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE || '../../html-renderer/node_modules/playwright/index.mjs');
const server = await createServer({ server: { host: '127.0.0.1', port: 1724, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await mkdir('.tmp/seedream-models', { recursive: true });
async function ready() {
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await page.evaluate(() => {
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'update_settings' && window.failModelSave) throw new Error('private C:\\secret\\model.json');
      if (command === 'begin_generation_diagnostic') return new Promise(resolve => { window.releaseDiagnostic = () => resolve('model-test'); });
      if (command === 'codex_create_image') { window.submittedModel = args; throw '模拟生成已取消'; }
      if (command === 'finish_generation_diagnostic') return null;
      return original(command, args);
    };
    window.store.setState({ activeGenProvider: 'jimeng', codexHealth: { ok: true }, dreaminaHealth: { ok: true },
      cloudAuth: { logged_in: true, cloud_available: true },
      cloudEntitlement: { plan: 'pro', policy: { can_use_byo: true }, balances: { daily: 0, sub: 0, topup: 100 } } });
    window.notices = [];
    window.addEventListener('bowerbird://notify', event => window.notices.push(event.detail.message));
  });
  await page.locator('.composer-glass').getByRole('button', { name: '展开创作描述' }).click();
}
const trigger = page.locator('.composer-glass .provider-choice');
const menu = page.getByRole('dialog', { name: '图像模型', exact: true });
const option = key => menu.locator(`[data-model-key="${key}"]`);
const group = menu.locator('[data-model-group="即梦"]');
const versions = ['dreamina-web55', 'dreamina-web50pro', 'dreamina-web50flash', 'dreamina-web50lite', 'dreamina-web47', 'dreamina-web40'];
async function openJimeng() {
  await trigger.click();
  assert.equal(await option('dreamina-web55').count(), 0);
  await group.click();
}
try {
  await page.goto('http://127.0.0.1:1724/scripts/fixtures/canvas-reference/preview.html?source-library');
  await ready();
  await page.evaluate(() => window.store.setState({ dreaminaHealth: null }));
  for (const key of versions) {
    await openJimeng();
    assert.equal(await menu.locator('[data-source="personal"] [data-model-key]').count(), versions.length);
    await option(key).click();
    assert.equal(await page.evaluate(() => window.store.getState().activeGenProvider), key);
    assert.doesNotMatch(await trigger.innerText(), /网页|CLI/);
  }
  await openJimeng();
  await menu.locator('[data-source="personal"]').getByRole('button', {name:'设为默认：Seedream 5.0 Pro',exact:true}).click();
  assert.equal(await page.evaluate(() => localStorage.getItem('bowerbird.defaultProvider')), 'dreamina-web50pro');
  await page.keyboard.press('Escape');
  await group.waitFor();
  assert.equal(await option('dreamina-web55').count(), 0);
  await page.keyboard.press('Escape');
  await page.reload(); await ready();
  assert.equal(await page.evaluate(() => window.store.getState().defaultProvider), 'dreamina-web50pro');
  await openJimeng();
  await page.evaluate(() => window.store.setState({cloudEntitlement:{...window.store.getState().cloudEntitlement,policy:{can_use_byo:false}}}));
  for (const key of versions) assert.equal(await option(key).isDisabled(), true);
  await page.evaluate(() => window.store.setState({cloudEntitlement:{...window.store.getState().cloudEntitlement,policy:{can_use_byo:true,max_parallel_jobs:2}}}));
  await option('dreamina-web55').click();
  await page.evaluate(() => { window.generationTest = window.store.getState().startGeneration('模型快照测试', [], '1:1', 'dreamina-web55'); });
  await page.waitForFunction(() => !!window.releaseDiagnostic);
  await page.evaluate(() => {
    window.store.setState({ settings: { ...window.store.getState().settings, dreamina_model_version: '5.0' } });
    window.releaseDiagnostic();
  });
  await page.evaluate(() => window.generationTest);
  const submitted = await page.evaluate(() => window.submittedModel);
  assert.equal(submitted.provider, 'dreamina-web55'); assert.equal(submitted.dreaminaModelVersion, null);
  await page.evaluate(() => {
    const state = window.store.getState(); const id = state.activeJobId;
    window.store.setState({ genJobs: { ...state.genJobs, [id]: { ...state.genJobs[id], sessionId: 'fake-session' } } });
    window.releaseDiagnostic = null;
    window.generationTest = window.store.getState().sendGenRevise(id, '续轮模型测试', 'dreamina-web50pro');
  });
  await page.waitForFunction(() => !!window.releaseDiagnostic);
  await page.evaluate(() => window.releaseDiagnostic()); await page.evaluate(() => window.generationTest);
  assert.equal(await page.evaluate(() => window.submittedModel.provider), 'dreamina-web50pro', 'follow-up uses the newly selected version');
  await page.evaluate(() => {
    const state = window.store.getState();
    window.store.setState({ cloudEntitlement: { ...state.cloudEntitlement, generation_services: [
      { service: 'image_seedream55', label: 'Seedream 5.5', credits: 20 },
      { service: 'image_seedream55_1k', label: 'Seedream 5.5 1K', credits: 10 },
      { service: 'image_seedream55_15k', label: 'Seedream 5.5 1.5K', credits: 10 },
      { service: 'image_hd', label: 'Seedream 5.0 Pro', credits: 20 },
      { service: 'image_lite', label: 'Seedream 5.0 Lite', credits: 8 },
    ] } });
  });
  await trigger.click();
  for (const key of ['image_seedream55', 'image_seedream55_1k', 'image_seedream55_15k', 'image_hd', 'image_lite']) {
    assert.equal(await option(`bowerbird-cloud-${key}`).isDisabled(), false);
  }
  await option('bowerbird-cloud-image_seedream55').click();
  assert.equal(await page.evaluate(() => window.store.getState().activeGenProvider), 'bowerbird-cloud-image_seedream55');
  await page.evaluate(async () => {
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => command === 'cloud_sync_entitlement'
      ? window.store.getState().cloudEntitlement : original(command, args);
    window.store.setState({ defaultProvider: 'jimeng' });
    await window.store.getState().syncCloudEntitlement();
  });
  assert.equal(await page.evaluate(() => window.store.getState().activeGenProvider), 'jimeng', 'saved available default is preserved');
  await page.evaluate(async () => {
    const state = window.store.getState();
    window.store.setState({ cloudEntitlement: { ...state.cloudEntitlement, policy: { can_use_byo: false } } });
    await window.store.getState().syncCloudEntitlement();
  });
  assert.equal(await page.evaluate(() => window.store.getState().activeGenProvider), 'bowerbird-cloud-image_seedream55', 'Cloud fallback uses active 5.5');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await trigger.click(); await menu.screenshot({ path: `.tmp/seedream-models/${theme}.png` }); await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 900, height: 600 }); await trigger.click();
  const bounds = await menu.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 900 && bounds.y >= 0);
  assert.deepEqual(errors, []);
  console.log('PASS: Seedream versions, selected/default state, persistence, submenu, Pro gates, request/follow-up snapshots, themes and narrow layout');
} finally { await browser.close(); await server.close(); }
