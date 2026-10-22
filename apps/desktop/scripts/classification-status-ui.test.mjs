import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/classification-status/vite', server: { host: '127.0.0.1', port: 17883, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(10000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
async function holdNextStatus() {
  await page.evaluate(() => { window.releaseSnapshot = null; window.holdSnapshot = true; });
  await page.waitForFunction(() => !!window.releaseSnapshot);
}
async function releaseStatus() {
  await page.evaluate(async () => { window.releaseSnapshot(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
}
try {
  await page.goto('http://127.0.0.1:17883/scripts/fixtures/local-classification/preview.html?labels');
  const automatic = page.getByRole('checkbox', { name: '自动处理新素材', exact: true });
  await automatic.check();
  await page.evaluate(() => {
    const previous = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'local_classification_status' && window.holdSnapshot) {
        window.holdSnapshot = false;
        const snapshot = structuredClone(window.classificationStatus);
        return new Promise(resolve => window.releaseSnapshot = () => resolve(snapshot));
      }
      return previous(command, args);
    };
    Object.assign(window.classificationStatus, { run_id: 'stable-run', busy: true, phase: 'classifying', total: 5, done: 0,
      model: 'jev-test', message: '正在分类', current_asset: window.previewAsset });
    window.emitProgressWithDefaults = () => {
      const payload = { ...structuredClone(window.classificationStatus), enabled: false, supported: false, installed: false,
        vector_supported: false, vector_installed: false, download_total: 0 };
      Object.values(window.listeners).forEach(handler => window.callbacks[handler]?.({ event: 'local-classification://progress', payload }));
    };
    window.emitProgressWithDefaults();
    window.originalDialog = document.querySelector('.classification-panel');
  });
  await page.getByRole('progressbar', { name: '分类进度', exact: true }).waitFor();
  assert.equal(await automatic.isChecked(), true, 'event defaults cannot clear the saved preference');
  await holdNextStatus();
  await page.evaluate(() => { window.classificationStatus.done = 1; window.emitProgressWithDefaults(); });
  await page.waitForFunction(() => document.querySelector('[aria-label="分类进度"]')?.getAttribute('aria-valuenow') === '1');
  await releaseStatus();
  assert.equal(await automatic.isChecked(), true);
  assert.equal(await page.getByRole('progressbar', { name: '分类进度', exact: true }).getAttribute('aria-valuenow'), '1', 'late status does not rewind progress');
  const checkedFrames = await page.evaluate(() => new Promise(resolve => {
    const values = []; let frame = 0;
    function tick() {
      if (frame % 4 === 0) { window.classificationStatus.done = Math.min(4, 1 + frame / 4); window.emitProgressWithDefaults(); }
      values.push(document.querySelector('section[aria-label="新素材自动分类"] input').checked);
      if (++frame < 20) requestAnimationFrame(tick); else resolve(values);
    }
    requestAnimationFrame(tick);
  }));
  assert.ok(checkedFrames.every(Boolean), 'successive completions never uncheck the control');
  assert.equal(await page.evaluate(() => window.originalDialog === document.querySelector('.classification-panel')), true);
  await holdNextStatus();
  await automatic.uncheck();
  await releaseStatus();
  assert.equal(await automatic.isChecked(), false, 'a pre-save poll cannot undo a user toggle');
  await page.evaluate(() => { window.classificationStatus.busy = false; window.classificationStatus.message = ''; });
  await page.waitForFunction(() => !document.querySelector('section[aria-label="新素材自动分类"] input').disabled);
  await automatic.check();
  await page.evaluate(() => { window.classificationStatus.enabled = false; });
  await page.waitForFunction(() => !document.querySelector('section[aria-label="新素材自动分类"] input').checked);
  assert.equal(await automatic.isChecked(), false, 'a genuine backend pause still reaches the UI');

  await page.goto('http://127.0.0.1:17883/scripts/fixtures/canvas-reference/preview.html?source-library');
  await page.waitForFunction(() => document.querySelector('.canvas-workspace')?.getAttribute('aria-busy') === 'false');
  await page.locator('.canvas-stage').focus(); await page.keyboard.press('Tab');
  await page.getByRole('region', { name: '按标签浏览素材', exact: true }).waitFor();
  await page.evaluate(async () => {
    window.catalogMode = (await import('/src/lib/localFileMode.ts')).useLocalFileMode;
    const previous = window.__TAURI_INTERNALS__.invoke;
    window.catalogRevision = 0;
    window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (['material_catalog', 'material_catalog_assets'].includes(command)) {
        if (window.refreshDelay) await new Promise(resolve => setTimeout(resolve, 220));
        if (command === 'material_catalog') return { tags: [{ id: 'stable', name: '分类', description: '', count: 2, projectCount: 2 }], collections: [], prompts: [], tag_asset_ids: { stable: ['stable-0', 'stable-1'] } };
        return Array.from({ length: window.catalogRevision ? 2 : 1 }, (_, i) => ({ id: `stable-${i}`, name: `素材${i}.png`, width: 200, height: 160, ext: 'png', store_path: `/stable-${i}.png`, thumb_path: '/src-tauri/resources/samples/preset-01.webp' }));
      }
      return previous(command, args);
    };
    window.catalogMode.getState().openBrowser();
  });
  await page.locator('.categorized-library').waitFor({ state: 'detached' });
  await page.evaluate(() => window.catalogMode.getState().closeBrowser());
  await page.locator('[data-asset-id="stable-0"]').waitFor();
  const frames = await page.evaluate(() => new Promise(resolve => {
    window.refreshDelay = true;
    const original = document.querySelector('[data-asset-id="stable-0"]');
    const started = performance.now(), samples = [];
    for (let i = 0; i < 3; i++) setTimeout(() => { window.catalogRevision = 1; window.emitAssetsChanged(); }, i * 180);
    function tick() {
      samples.push({ count: document.querySelectorAll('.categorized-library [data-asset-id]').length,
        loading: document.querySelector('.catalog-empty')?.textContent.includes('正在读取'),
        retained: original === document.querySelector('[data-asset-id="stable-0"]') });
      if (performance.now() - started < 1100) requestAnimationFrame(tick); else resolve(samples);
    }
    requestAnimationFrame(tick);
  }));
  assert.ok(frames.length > 10);
  assert.ok(frames.every(frame => frame.count >= 1 && !frame.loading && frame.retained), 'background refresh preserves cards without loading flashes');
  await page.locator('[data-asset-id="stable-1"]').waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: stable automatic setting across raw progress events, stale-poll rejection, real pause updates, no empty frames or card remounts on classification completion');
} catch (error) {
  console.error(await page.evaluate(() => ({ text: document.body.innerText.slice(-1800), mode: window.catalogMode?.getState().mode })), errors);
  throw error;
} finally { await browser.close(); await server.close(); }
