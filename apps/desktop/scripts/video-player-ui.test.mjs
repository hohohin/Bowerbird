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
  '-filter_complex', "[0:v][1:v][2:v]concat=n=3:v=1:a=0,drawbox=color=yellow:t=fill:enable='gte(t,2.96)'", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${directory}/colors.mp4`]);
for (const [name, size] of [['portrait', '720x1280'], ['square', '720x720'], ['wide', '1280x540'], ['short', '320x180']]) {
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=teal:s=${size}:r=25:d=${name === 'short' ? 0.04 : 1}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${directory}/${name}.mp4`]);
}
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
  await page.waitForFunction(() => document.querySelector('.video-player video')?.readyState >= 2, null, { timeout: 5000 });
  const firstFrame = await dialog.locator('video').evaluate(video => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0);
    return { paused: video.paused, time: video.currentTime, pixel: [...ctx.getImageData(160, 90, 1, 1).data] };
  });
  assert.equal(firstFrame.paused, true, 'opening preview must not autoplay');
  assert.equal(firstFrame.time, 0);
  assert.ok(firstFrame.pixel[0] > 220 && firstFrame.pixel[1] < 30 && firstFrame.pixel[2] < 30,
    `first frame must be decoded without clicking play: ${firstFrame.pixel}`);
  assert.equal(await add.isDisabled(), false, 'paused first frame can be added to the canvas');
  // Space works immediately, even while focus remains in the underlying editor.
  await page.evaluate(() => {
    const input = document.createElement('textarea'); input.id = 'background-editor'; document.body.append(input); input.focus();
  });
  await page.keyboard.press('Space');
  await page.waitForFunction(() => !document.querySelector('.video-player video').paused);
  await page.getByRole('button', { name: '暂停', exact: true }).waitFor();
  assert.equal(await page.locator('#background-editor').inputValue(), '', 'modal shortcut must not type into the background');
  await page.locator('#background-editor').evaluate(el => el.remove());
  assert.equal(await add.isDisabled(), true, 'playing video cannot export an unstable frame');
  await slider.focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('.video-player video').paused);
  const fineButton = page.getByRole('button', { name: '细调', exact: true });
  await fineButton.focus();
  await page.keyboard.down('Space');
  await page.waitForFunction(() => !document.querySelector('.video-player video').paused);
  await page.keyboard.down('Space');
  assert.equal(await dialog.locator('video').evaluate(video => video.paused), false, 'held space must not toggle repeatedly');
  await page.keyboard.up('Space');
  assert.equal(await fineButton.getAttribute('aria-pressed'), 'false', 'space must not click the focused toolbar button');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('.video-player video').paused);
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
  await seek(0.2);
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await page.evaluate(() => { window.failNodeSave = true; });
  await page.getByRole('button', { name: '添加尾帧到画板', exact: true }).click();
  await dialog.getByRole('alert').waitFor();
  assert.equal((await imports()).length, 3);
  const tail = await page.evaluate(async () => {
    const call = window.calls.filter(call => call.command === 'import_image_bytes').at(-1);
    const image = new Image(); image.src = call.args.dataUrl; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    const video = document.querySelector('.video-player video');
    return { pixel: [...ctx.getImageData(160, 90, 1, 1).data], width: image.width, height: image.height,
      paused: video.paused, time: video.currentTime, duration: video.duration };
  });
  assert.deepEqual([tail.width, tail.height], [320, 180]);
  assert.ok(tail.pixel[0] > 220 && tail.pixel[1] > 220 && tail.pixel[2] < 30, `expected final yellow frame: ${tail.pixel}`);
  assert.equal(tail.paused, true);
  assert.ok(tail.time < tail.duration && tail.duration - tail.time < 0.002);
  await page.evaluate(() => { window.failNodeSave = false; });
  await page.getByRole('button', { name: '添加尾帧到画板', exact: true }).click();
  await page.getByRole('button', { name: '尾帧已添加', exact: true }).waitFor();
  assert.equal((await imports()).length, 3, 'tail save retry must reuse the imported frame');
  await seek(0.5);
  assert.equal(await page.getByRole('button', { name: '尾帧已添加', exact: true }).isDisabled(), true);
  await page.setViewportSize({ width: 480, height: 800 });
  assert.ok(await page.locator('.video-player').evaluate(el => el.getBoundingClientRect().right <= innerWidth && el.scrollWidth <= el.clientWidth));
  await page.screenshot({ path: `${directory}/player-narrow.png` });
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
  assert.equal(await page.locator('video').count(), 0);
  await page.evaluate(() => window.save()); await page.reload();
  await page.locator(`[data-canvas-node-id="${saved.nodes[0].id}"]`).waitFor();
  assert.equal((await page.evaluate(() => window.snapshot())).nodes.length, 4);
  // Closing/switching projects during an import still persists only to its frozen project.
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.locator('[data-canvas-node-id="clip"]').focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.video-player video')?.readyState >= 2);
  await seek(0.5);
  await page.evaluate(() => { window.holdFrameImport = true; });
  await add.click(); await page.waitForFunction(() => typeof window.releaseFrameImport === 'function');
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    const { useStore } = await import('/src/store.ts');
    useStore.setState({ activeProjectId: 'q', projectRouteRevision: useStore.getState().projectRouteRevision + 1 });
    window.holdFrameImport = false; window.releaseFrameImport();
  });
  await page.waitForFunction(() => window.snapshot().nodes.length === 5);
  assert.equal(await page.locator('video').count(), 0);
  assert.equal(await page.locator('[data-canvas-node-id]').count(), 0, 'late save must not inject an old project node into current UI');
  assert.equal((await page.evaluate(() => window.snapshot())).nodes.at(-1).projectId, 'p');
  // Completed video sessions use the same bare media layout as image results.
  for (const [name, width, height] of [['portrait', 720, 1280], ['square', 720, 720], ['wide', 1280, 540], ['short', 320, 180]]) {
    await page.evaluate(({ name, width, height }) => {
      const snapshot = window.snapshot(), base = snapshot.nodes.find(node => node.kind === 'asset');
      snapshot.nodes = [
        { ...base, id: 'video-session', kind: 'prompt', assetId: null, role: null, width: 260, height: 148,
          payloadJson: JSON.stringify({ schema_version: 1, job_id: 'video-job', turn_key: 'one', text: '测试视频', provider: 'jimeng', status: 'done' }) },
        { ...base, id: 'video-output', assetId: name, role: 'output',
          payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name, width, height }, execution: { job_id: 'video-job', turn_key: 'one' } }) },
      ];
      snapshot.edges = [{ id: 'video-edge', projectId: 'p', threadId: 't', fromNodeId: 'video-session', toNodeId: 'video-output', kind: 'produced', ordinal: 0, createdAt: 1 }];
      sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
      sessionStorage.setItem('reference-drafts', JSON.stringify([{ id: name, name, ext: 'mp4', width, height,
        store_path: `/.tmp/video-player/${name}.mp4`, source: 'imported',
        thumb_path: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="teal"/></svg>`)}` }]));
    }, { name, width, height });
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.reload();
    const card = page.locator('[data-canvas-node-id="video-session"]');
    await card.waitFor();
    await card.locator(`[data-conversation-image="${name}"]`).waitFor();
    assert.equal(await card.locator('.canvas-video-film').count(), 0, 'video sessions have no film edges');
    assert.equal(await card.locator('.canvas-video-badge').count(), 1, 'video sessions share the passive play marker');
    assert.equal(await card.locator('.canvas-prompt-content').count(), 0, 'completed video has no prompt wrapper');
    const appearance = await card.evaluate(el => ({ border: getComputedStyle(el).borderTopWidth, padding: getComputedStyle(el).padding,
      background: getComputedStyle(el).backgroundColor, ratio: el.clientWidth / el.clientHeight }));
    assert.equal(appearance.border, '0px'); assert.equal(appearance.padding, '0px');
    assert.equal(appearance.background, 'rgba(0, 0, 0, 0)');
    assert.ok(Math.abs(appearance.ratio - width / height) < 0.01);
    await page.screenshot({ path: `${directory}/${name}-card.png` });
    await card.locator('.canvas-conversation-images').click();
    await dialog.waitFor();
    await page.waitForFunction(() => document.querySelector('.video-player video')?.readyState >= 2);
    for (const viewport of [{ width: 1500, height: 1000 }, { width: 480, height: 800 }]) {
      await page.setViewportSize(viewport);
      await page.waitForFunction(ratio => {
        const video = document.querySelector('.video-player video'), player = document.querySelector('.video-player');
        const frame = video.getBoundingClientRect(), box = player.getBoundingClientRect();
        return Math.abs(frame.width / frame.height - ratio) < 0.01 && Math.abs(box.width - frame.width - 2) < 2
          && box.top >= 0 && box.bottom <= innerHeight && box.right <= innerWidth && player.scrollWidth <= player.clientWidth;
      }, width / height);
      await page.screenshot({ path: `${directory}/${name}-${viewport.width}.png` });
    }
    if (name === 'short') {
      await page.getByRole('button', { name: '添加尾帧到画板', exact: true }).click();
      await page.getByRole('button', { name: '尾帧已添加', exact: true }).waitFor();
      assert.ok(await dialog.locator('video').evaluate(video => video.paused && video.currentTime > 0 && video.currentTime < 0.04));
    }
    if (name === 'wide') {
      const before = (await imports()).length;
      await page.evaluate(async () => {
        const video = document.querySelector('.video-player video');
        const released = new Promise(resolve => video.addEventListener('emptied', resolve, { once: true }));
        [...document.querySelectorAll('.video-player button')].find(button => button.textContent === '添加尾帧到画板').click();
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await released;
      });
      assert.equal((await imports()).length, before, 'closing during tail seek must not save a stale frame');
    } else await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
  }
  assert.deepEqual(errors, []);
  await writeFile(`${directory}/result.json`, JSON.stringify({ saved, blue, nativeTauri: false }, null, 2));
  console.log('PASS first/last frame pixels, one-frame clip, tail retry/deduplication/close cancellation, Space, video cards, responsive sizing, seek, reload and cleanup');
} finally { await browser.close(); await server.close(); }
