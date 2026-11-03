import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const output = '.tmp/library-creation-parity';
await mkdir(output, { recursive: true });
const server = await createServer({ cacheDir: `${output}/media-vite`, server: { host: '127.0.0.1', port: 18954, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(7000);
const errors = [], remote = [], results = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => {
  if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue();
  remote.push(route.request().url()); return route.abort();
});
try {
  for (const cached of [true, false]) for (const ext of ['txt', 'mp3']) {
    await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/library-creation-parity/preview.html?source-library&detail-route&canvas-library&media-fallback${cached ? '' : '&media-uncached'}`);
    await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
    await page.getByRole('button', { name: '返回主页', exact: true }).click();
    await page.getByRole('region', { name: '素材库创作', exact: true }).locator('.ProseMirror').fill('保留现有媒体入口');
    const assetId = `parity-missing-${ext}`;
    assert.deepEqual(await page.evaluate(id => {
      const state = window.store.getState();
      const asset = [...state.assets, ...state.promptedAssets].find(item => item.id === id);
      return asset && { ext: asset.ext, path: asset.store_path };
    }, assetId), cached ? { ext, path: null } : undefined, 'cached and uncached catalog cases reflect the actual shared asset caches');
    await page.locator(`.library-home [data-asset-id="${assetId}"]`).click();
    await page.waitForTimeout(700);
    results.push(await page.evaluate(({ ext, cached }) => ({ ext, cached,
      imagePreview: document.querySelectorAll('.creation-image-preview').length,
      detail: window.store.getState().detailAssetId,
      picks: window.parityPicks,
      prepared: window.preparedProjects.length,
      generated: window.generationCalls.length,
    }), { ext, cached }));
  }
  await writeFile(`${output}/media-observed.json`, JSON.stringify(results, null, 2));
  assert.deepEqual(results, [true, false].flatMap(cached => [
    { ext: 'txt', cached, imagePreview: 0, detail: 'parity-missing-txt', picks: [], prepared: 0, generated: 0 },
    // Audio's existing creation activation dispatches a reference; this change must leave it intact.
    { ext: 'mp3', cached, imagePreview: 0, detail: null, picks: ['parity-missing-mp3'], prepared: 0, generated: 0 },
  ]), 'cached and uncached extension-only text/audio retain their original activation instead of entering image preview');
  assert.deepEqual(errors, []); assert.deepEqual(remote, []);
  console.log('PASS actual App cached and uncached extension-only text opens original detail, audio keeps its existing reference action, neither opens image preview or submits');
} finally { await browser.close(); await server.close(); }
