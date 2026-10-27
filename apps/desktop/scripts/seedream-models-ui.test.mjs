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
async function choose(version) {
  await trigger.click();
  await option(version === '5.0Pro' ? 'jimeng' : `jimeng-${version}`).click();
  await page.waitForFunction(version => window.store.getState().settings.dreamina_model_version === version, version);
  assert.equal(await page.evaluate(() => window.store.getState().activeGenProvider), 'jimeng');
  assert.match(await trigger.innerText(), new RegExp(`Seedream ${version.replace('Pro', ' Pro').replaceAll('.', '\\.')}`));
}
try {
  await page.goto('http://127.0.0.1:1724/scripts/fixtures/canvas-reference/preview.html?source-library');
  await ready();
  await trigger.click();
  for (const version of ['5.0Pro', '5.0', '4.7', '4.0']) {
    assert.equal(await option(version === '5.0Pro' ? 'jimeng' : `jimeng-${version}`).count(), 1);
  }
  assert.equal(await option('jimeng').getAttribute('aria-pressed'), 'true', 'old default still selects Pro');
  await page.keyboard.press('Escape');
  for (const version of ['5.0', '4.7', '4.0', '5.0Pro']) await choose(version);
  await choose('4.7');
  await trigger.click();
  assert.equal(await option('jimeng-4.7').getAttribute('aria-pressed'), 'true');
  assert.equal(await option('jimeng').getAttribute('aria-pressed'), 'false');
  await menu.getByRole('button', { name: '设为默认：Seedream 4.0', exact: true }).click();
  await page.waitForFunction(() => window.store.getState().settings.dreamina_model_version === '4.0');
  assert.equal(await page.evaluate(() => localStorage.getItem('bowerbird.defaultProvider')), 'jimeng', 'menu keys never escape to stored provider');
  assert.equal(await option('jimeng-4.0').getAttribute('aria-pressed'), 'true');
  await page.keyboard.press('Escape');
  await page.reload(); await ready();
  assert.match(await trigger.innerText(), /Seedream 4\.0/, 'model persists after reload');
  await page.evaluate(() => window.failModelSave = true);
  await trigger.click(); await option('jimeng-5.0').click();
  await page.waitForFunction(() => window.notices.length > 0);
  assert.match(await trigger.innerText(), /Seedream 4\.0/, 'failed save retains previous model');
  assert.equal(await page.evaluate(() => window.store.getState().settings.dreamina_model_version), '4.0');
  assert.ok(!(await page.evaluate(() => window.notices.join(' '))).includes('secret'));
  await page.evaluate(() => { window.failModelSave = false; window.store.setState({ dreaminaHealth: { ok: false }, codexHealth: { ok: true } }); });
  await trigger.click();
  for (const key of ['jimeng', 'jimeng-5.0', 'jimeng-4.7', 'jimeng-4.0']) assert.equal(await option(key).isDisabled(), true);
  assert.equal(await option('codex').isDisabled(), false, 'Dreamina availability never comes from Codex health');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.store.setState({ dreaminaHealth: { ok: true }, cloudEntitlement: { plan: 'free', policy: { can_use_byo: false }, balances: { topup: 100, daily: 0, sub: 0 } } }));
  await trigger.click();
  for (const key of ['jimeng', 'jimeng-5.0', 'jimeng-4.7', 'jimeng-4.0']) assert.equal(await option(key).isDisabled(), true);
  assert.equal(await option('bowerbird-cloud-image_hd').isDisabled(), false);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.store.setState({ cloudEntitlement: { plan: 'pro', policy: { can_use_byo: true }, balances: { topup: 100, daily: 0, sub: 0 } } }));
  await choose('4.7');
  await page.evaluate(() => { window.generationTest = window.store.getState().startGeneration('模型快照测试', [], '1:1', 'jimeng'); });
  await page.waitForFunction(() => !!window.releaseDiagnostic);
  await page.evaluate(() => {
    window.store.setState({ settings: { ...window.store.getState().settings, dreamina_model_version: '5.0' } });
    window.releaseDiagnostic();
  });
  await page.evaluate(() => window.generationTest);
  const submitted = await page.evaluate(() => window.submittedModel);
  assert.equal(submitted.provider, 'jimeng'); assert.equal(submitted.dreaminaModelVersion, '4.7', 'request snapshot survives later model changes');
  await page.evaluate(() => {
    const state = window.store.getState(); const id = state.activeJobId;
    window.store.setState({ genJobs: { ...state.genJobs, [id]: { ...state.genJobs[id], sessionId: 'fake-session' } } });
    window.releaseDiagnostic = null;
    window.generationTest = window.store.getState().sendGenRevise(id, '续轮模型测试', 'jimeng');
  });
  await page.waitForFunction(() => !!window.releaseDiagnostic);
  await page.evaluate(() => window.releaseDiagnostic()); await page.evaluate(() => window.generationTest);
  assert.equal(await page.evaluate(() => window.submittedModel.dreaminaModelVersion), '5.0', 'follow-up uses the newly selected version');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await trigger.click(); await menu.screenshot({ path: `.tmp/seedream-models/${theme}.png` }); await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 900, height: 600 }); await trigger.click();
  const bounds = await menu.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 900 && bounds.y >= 0);
  assert.deepEqual(errors, []);
  console.log('PASS: Seedream versions, selected/default state, persistence, save failure, health/Pro gates, request/follow-up snapshots, themes and narrow layout');
} finally { await browser.close(); await server.close(); }
