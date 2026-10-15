import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const directory = '.tmp/video-player';
await mkdir(directory, { recursive: true });
const ffmpeg = process.env.BOWERBIRD_FFMPEG_BINARY || resolve('../../.tmp/video-integration/tools/local/ffmpeg.exe');
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=red:s=320x180:r=25:d=1',
  '-f', 'lavfi', '-i', 'color=lime:s=320x180:r=25:d=1', '-f', 'lavfi', '-i', 'color=blue:s=320x180:r=25:d=1',
  '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${directory}/colors.mp4`]);
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: `${directory}/vite`,
  server: { host: '127.0.0.1', port: 1647, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const dialog = page.getByRole('dialog', { name: /媒体预览/ });
const slider = page.getByRole('slider', { name: '视频时间轴' });
const add = page.getByRole('button', { name: '添加该帧到画板', exact: true });
const imports = () => page.evaluate(() => window.calls.filter(call => call.command === 'import_image_bytes' && call.args.source === 'video-frame'));
async function seek(value) {
  await slider.focus();
  await page.keyboard.press('Home');
  // Real mouse drag, fixed central playhead; 720px / 3 seconds.
  const bounds = await slider.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 - value * 240, bounds.y + bounds.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction(() => { const v = document.querySelector('.video-player video'); return v?.paused && !v.seeking; });
}
try {
  await page.goto('http://127.0.0.1:1647/scripts/fixtures/canvas-reference/preview.html?strict');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(() => {
    const snapshot = window.snapshot();
    snapshot.nodes = [{ ...snapshot.nodes[0], id: 'clip', assetId: 'clip', x: 180, y: 120, width: 320, height: 180,
      payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: '彩色视频', width: 320, height: 180 } }) }];
    snapshot.view = { ...snapshot.view, zoom: 1, panX: 0, panY: 0 };
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
    sessionStorage.setItem('reference-drafts', JSON.stringify([{ id: 'clip', name: '彩色视频', ext: 'mp4', width: 320, height: 180,
      store_path: '/.tmp/video-player/colors.mp4', duration: 3, source: 'imported' }]));
  });
  await page.reload();
  await page.locator('[data-canvas-node-id="clip"]').focus(); await page.keyboard.press('Enter');
  await dialog.waitFor();
  assert.equal(await dialog.locator('video').getAttribute('src'), '/.tmp/video-player/colors.mp4',
    'StrictMode effect cleanup/setup must retain the video source');
  assert.equal(await add.isDisabled(), true);
  assert.equal(await dialog.locator('video').getAttribute('preload'), 'none');
  await page.getByRole('button', { name: '播放视频', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.video-player video')?.readyState >= 2);
  assert.equal(await add.isDisabled(), true, 'playing video cannot export an unstable frame');
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await seek(1.5);
  assert.ok(Math.abs(Number(await slider.getAttribute('aria-valuenow')) - 1.5) < 0.05);
  assert.equal(await dialog.count(), 1, 'slider arrow keys must not navigate to another asset');
  await page.getByRole('button', { name: '细调', exact: true }).click();
  await slider.focus(); await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => !document.querySelector('.video-player video').seeking);
  assert.ok(Math.abs(Number(await slider.getAttribute('aria-valuenow')) - 1.51) < 0.05);
  await page.getByRole('button', { name: '细调', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.video-player-film img').length === 12);
  await page.screenshot({ path: `${directory}/player.png` });
  // Failure after import must retry the same asset/node and report success only after persistence.
  await page.evaluate(() => { window.failNodeSave = true; });
  await add.click();
  await dialog.getByRole('alert').waitFor();
  assert.equal((await imports()).length, 1);
  await page.evaluate(() => { window.failNodeSave = false; });
  await add.click();
  await page.getByRole('button', { name: '已添加到画板', exact: true }).waitFor();
  assert.equal((await imports()).length, 1, 'retry must not import a second image');
  const saved = await page.evaluate(async () => {
    const request = window.calls.find(call => call.command === 'import_image_bytes');
    const image = new Image(); image.src = request.args.dataUrl; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    return { dimensions: [image.width, image.height], pixel: [...ctx.getImageData(160, 90, 1, 1).data], project: request.args.projectId,
      nodes: window.snapshot().nodes.filter(node => node.id !== 'clip') };
  });
  assert.deepEqual(saved.dimensions, [320, 180]);
  assert.ok(saved.pixel[1] > 220 && saved.pixel[0] < 30 && saved.pixel[2] < 30, `expected green decoded frame: ${saved.pixel}`);
  assert.equal(saved.project, 'p'); assert.equal(saved.nodes.length, 1);
  assert.ok(saved.nodes[0].x >= 500, 'frame placed beside original video');
  await seek(2.4);
  await page.evaluate(() => { window.holdFrameImport = true; });
  await add.click();
  await page.waitForFunction(() => typeof window.releaseFrameImport === 'function');
  assert.equal(await page.getByRole('button', { name: '正在添加…' }).isDisabled(), true);
  await page.evaluate(() => { window.holdFrameImport = false; window.releaseFrameImport(); });
  await page.getByRole('button', { name: '已添加到画板', exact: true }).waitFor();
  const blue = await page.evaluate(async () => {
    const call = window.calls.filter(call => call.command === 'import_image_bytes').at(-1);
    const image = new Image(); image.src = call.args.dataUrl; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0); return [...ctx.getImageData(160, 90, 1, 1).data];
  });
  assert.ok(blue[2] > 220 && blue[0] < 30 && blue[1] < 30, `expected blue decoded frame: ${blue}`);
  await page.setViewportSize({ width: 480, height: 800 });
  assert.ok(await page.locator('.video-player').evaluate(el => el.getBoundingClientRect().right <= innerWidth && el.scrollWidth <= el.clientWidth));
  await page.screenshot({ path: `${directory}/player-narrow.png` });
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
  assert.equal(await page.locator('video').count(), 0);
  await page.evaluate(() => window.save()); await page.reload();
  await page.locator(`[data-canvas-node-id="${saved.nodes[0].id}"]`).waitFor();
  assert.equal((await page.evaluate(() => window.snapshot())).nodes.length, 3);
  // Closing/switching projects during an import still persists only to its frozen project.
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.locator('[data-canvas-node-id="clip"]').focus(); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '播放视频', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.video-player video')?.readyState >= 2);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await seek(0.5);
  await page.evaluate(() => { window.holdFrameImport = true; });
  await add.click(); await page.waitForFunction(() => typeof window.releaseFrameImport === 'function');
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    const { useStore } = await import('/src/store.ts');
    useStore.setState({ activeProjectId: 'q', projectRouteRevision: useStore.getState().projectRouteRevision + 1 });
    window.holdFrameImport = false; window.releaseFrameImport();
  });
  await page.waitForFunction(() => window.snapshot().nodes.length === 4);
  assert.equal(await page.locator('video').count(), 0);
  assert.equal(await page.locator('[data-canvas-node-id]').count(), 0, 'late save must not inject an old project node into current UI');
  assert.equal((await page.evaluate(() => window.snapshot())).nodes.at(-1).projectId, 'p');
  assert.deepEqual(errors, []);
  await writeFile(`${directory}/result.json`, JSON.stringify({ saved, blue, nativeTauri: false }, null, 2));
  console.log('PASS video filmstrip dragging, keyboard fine seek, real PNG pixels, save failure/retry, duplicate prevention, narrow layout, reload and decoder cleanup');
} finally { await browser.close(); await server.close(); }
