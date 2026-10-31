import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const directory = '.tmp/video-library';
await mkdir(directory, { recursive: true });
execFileSync(process.env.BOWERBIRD_FFMPEG_BINARY || resolve('../../.tmp/video-integration/tools/local/ffmpeg.exe'),
  ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=lime:s=180x320:r=25:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', `${directory}/portrait.mp4`]);
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: `${directory}/vite`, server: { host: '127.0.0.1', port: 1667, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:1667/scripts/fixtures/canvas-reference/preview.html?strict&detail-route');
  await page.evaluate(() => sessionStorage.setItem('reference-drafts', JSON.stringify([{ id: 'clip', name: '竖屏视频', ext: 'mp4', width: 180, height: 320,
    store_path: '/.tmp/video-library/portrait.mp4', duration: 2, file_mtime: 1, source: 'imported' }])));
  await page.reload();
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await page.evaluate(() => window.store.getState().openDetail('clip'));
  const detail = page.locator('.asset-detail');
  await detail.waitFor();
  assert.equal(await detail.getByRole('region', { name: '视频播放器' }).count(), 1, 'detail must use the shared player');
  const save = detail.getByRole('button', { name: '保存该帧到素材库', exact: true });
  await save.waitFor();
  await page.waitForFunction(() => document.querySelector('.asset-detail video')?.readyState >= 2);
  await save.click();
  await page.waitForFunction(() => window.calls.some(call => call.command === 'import_image_bytes' && call.args.source === 'video-frame'));
  const imports = await page.evaluate(() => window.calls.filter(call => call.command === 'import_image_bytes' && call.args.source === 'video-frame'));
  assert.equal(imports.length, 1);
  assert.equal(imports[0].args.projectId, 'p');
  assert.deepEqual(imports[0].args.videoFrame, { sourcePath: '/.tmp/video-library/portrait.mp4', time: 0 });
  assert.ok(imports[0].args.dataUrl.startsWith('data:image/png;base64,'));
  const dimensions = await page.evaluate(async dataUrl => {
    const image = new Image(); image.src = dataUrl; await image.decode(); return [image.naturalWidth, image.naturalHeight];
  }, imports[0].args.dataUrl);
  assert.deepEqual(dimensions, [180, 320]);
  const addToCanvas = detail.getByRole('button', { name: '添加该帧到画板', exact: true });
  assert.equal(await addToCanvas.isEnabled(), true, 'library save does not disable canvas placement');
  await addToCanvas.click();
  await page.waitForFunction(() => window.calls.some(call => call.command === 'project_canvas_node_create' && call.args.value?.assetId?.startsWith('frame')));
  await page.screenshot({ path: `${directory}/detail.png` });
  await detail.getByRole('button', { name: '返回', exact: true }).click();
  assert.equal(await page.locator('.asset-detail video').count(), 0);
  await page.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (command !== 'video_collection') return invoke(command, args);
      window.calls.push({ command, args });
      if (args.action === 'list') return [{ id: 'collection', kind: 'direct', state: 'ready', projectId: 'p', sourceUrl: 'https://media.example/clip.mp4', reference: { id: 'reference', name: '采集测试视频', duration: 2 } }];
      if (args.action === 'save') return (await invoke('get_assets_by_ids', { assetIds: ['clip'] }))[0];
      throw new Error(`unexpected collection action: ${args.action}`);
    };
    window.failNodeSave = true;
  });
  await page.getByRole('button', { name: '展开画板素材库', exact: true }).click();
  const library = page.getByRole('complementary', { name: '画板素材库' });
  const entry = library.getByRole('button', { name: '采集视频', exact: true });
  if (!await entry.isVisible()) await library.getByRole('button', { name: '更多素材库控件', exact: true }).click();
  await entry.click();
  const collection = page.getByRole('dialog', { name: '采集视频', exact: true });
  await collection.getByRole('button', { name: '添加到画板', exact: true }).click();
  await collection.getByRole('alert').waitFor();
  assert.equal(await collection.isVisible(), true, 'failed canvas save must retain the collection dialog');
  await page.evaluate(() => { window.failNodeSave = false; });
  await collection.getByRole('button', { name: '添加到画板', exact: true }).click();
  await collection.waitFor({ state: 'detached' });
  const delivery = await page.evaluate(() => ({
    saves: window.calls.filter(call => call.command === 'video_collection' && call.args.action === 'save').length,
    writes: window.calls.filter(call => call.command === 'project_canvas_node_create' && call.args.value.assetId === 'clip').map(call => call.args.value),
    nodes: window.snapshot().nodes.filter(node => node.assetId === 'clip')
  }));
  assert.equal(delivery.saves, 1, 'retry canvas delivery without reingesting');
  assert.equal(delivery.nodes.length, 1);
  assert.equal(new Set(delivery.writes.map(node => node.id)).size, 1, 'retry keeps the original canvas node identity');
  assert.ok(delivery.writes.every(node => node.projectId === 'p'));
  assert.deepEqual(errors, []);
  console.log('video library: shared detail player, original pixels, frozen project and source timestamp passed');
} finally { await browser.close(); await server.close(); }
