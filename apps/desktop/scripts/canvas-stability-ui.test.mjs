import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/canvas-stability-ui/vite',
  server: { host: '127.0.0.1', port: 17968, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const url = `http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/canvas-reference/preview.html`;

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  const original = page.locator('[data-canvas-node-id="old"] img');
  await original.waitFor();
  const previousSrc = await original.getAttribute('src');
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const getCanvas = api.projectCanvasGet, getAssets = api.getAssetsByIds;
    const changes = window.refreshes = { reads: 0, result: 0 };
    api.projectCanvasGet = (...args) => { changes.reads++; return getCanvas(...args); };
    api.getAssetsByIds = async ids => {
      if (!ids.includes('existing')) return getAssets(ids);
      const result = ++changes.result;
      const assets = (await getAssets(ids)).map(asset => asset.id === 'existing' ? {
        ...asset, store_path: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${190 + result}" height="150"/>`)}`,
      } : asset);
      if (result === 1) await new Promise(resolve => { window.finishOldRefresh = resolve; });
      return assets;
    };
    for (let i = 0; i < 8; i++) window.emitFixtureEvent('external-files://changed', null);
  });
  await page.waitForFunction(() => typeof window.finishOldRefresh === 'function');
  assert.equal(await page.evaluate(() => window.refreshes.reads), 1, 'a burst performs one snapshot read');
  await page.evaluate(() => window.emitFixtureEvent('external-files://changed', null));
  await page.waitForFunction(src => document.querySelector('[data-canvas-node-id="old"] img')?.getAttribute('src') !== src, previousSrc);
  const currentSrc = await original.getAttribute('src');
  assert.match(decodeURIComponent(currentSrc), /width="192"/);
  await page.evaluate(async () => {
    window.finishOldRefresh();
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  assert.equal(await original.getAttribute('src'), currentSrc, 'an older file refresh cannot replace the current preview');
  assert.deepEqual(await page.evaluate(() => window.refreshes), { reads: 2, result: 2 });
  assert.deepEqual(errors, []);

  const strict = await browser.newPage();
  strict.on('pageerror', error => errors.push(error.message));
  await strict.goto(`${url}?strict`);
  const composer = strict.locator('.creation-editor .ProseMirror');
  await composer.waitFor({ state: 'attached' });
  // Simulate a generation editor being torn down while its insertion is still queued.
  await strict.evaluate(() => {
    const store = window.store;
    store.setState({ genPanelOpen: true, genEditing: 'edit', activeJobId: 'closing-job' });
    store.getState().addAssetToBoardFromDetail('b');
    if (store.getState().pendingBoardAssets.length !== 1) throw new Error('The job did not queue its own asset.');
    store.getState().setGenPanelOpen(false);
    if (store.getState().pendingBoardAssets.length) throw new Error('The closed job left an insertion behind.');
  });
  await strict.evaluate(() => {
    const state = window.store.getState();
    state.addAssetToBoardFromDetail('a');
    state.insertAnnotatedToBoard({ ...state.assets.find(item => item.id === 'existing'), id: 'annotation', source: 'annotation',
      sections: [{ title: '标注', body: '保留标注坐标' }] });
  });
  await composer.locator('[data-asset-id="a"]').waitFor({ state: 'attached' });
  await composer.locator('[data-asset-id="annotation"]').waitFor({ state: 'attached' });
  assert.equal(await composer.locator('[data-asset-id="a"]').count(), 1);
  assert.equal(await composer.locator('[data-asset-id="annotation"][data-media-kind]').count(), 1);
  assert.equal(await composer.locator('[data-asset-id="b"]').count(), 0);
  assert.deepEqual(await strict.evaluate(() => window.store.getState().pendingBoardAssets), []);
  assert.deepEqual(errors, []);
  console.log('PASS file event debouncing and stale refresh rejection, scoped composer insertion and StrictMode consumption');
} finally {
  await browser.close();
  await server.close();
}
