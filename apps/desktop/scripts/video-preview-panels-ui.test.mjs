import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const entry = 'scripts/fixtures/canvas-reference/preview.html';
const directory = '.tmp/video-preview-panels';
await mkdir(directory, { recursive: true });
const ffmpeg = process.env.BOWERBIRD_FFMPEG_BINARY || resolve('../../Windows/.work/.tmp/video-integration/tools/local/ffmpeg.exe');
for (const [name, color] of [['plain', 'lime'], ['generated', 'blue'], ['later', 'red'], ['h3', 'purple']]) {
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=${color}:s=320x180:r=25:d=2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', `${directory}/${name}.mp4`]);
}
const server = await createServer({ cacheDir: `${directory}/vite`, optimizeDeps: { entries: [entry] },
  server: { host: '127.0.0.1', port: 1676, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(server.resolvedUrls.local[0] + entry + '?source-library');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(path => {
    const videos = [
      { id: 'plain', name: '普通视频', source: 'imported' },
      { id: 'generated', name: '生成视频', source: 'generated', generation_session_id: 'video-session' },
      { id: 'h3', name: '本地视频', source: 'comfy-h3' },
    ].map(asset => ({ ...asset, ext: 'mp4', width: 320, height: 180, duration: 2, store_path: `/${path}/${asset.id}.mp4` }));
    const snapshot = window.snapshot();
    const base = snapshot.nodes.find(node => node.id === 'old');
    snapshot.nodes = videos.map((asset, index) => ({ ...base, id: `video-${asset.id}`, assetId: asset.id,
      x: 180 + index * 260, y: 165, width: 220, height: 128 }));
    snapshot.view = { ...snapshot.view, zoom: 1, panX: 0, panY: 0 };
    sessionStorage.setItem('reference-drafts', JSON.stringify(videos));
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
  }, directory);
  await page.reload();
  await page.locator('[data-canvas-node-id="video-plain"]').waitFor();
  await page.evaluate(path => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const scrollIntoView = HTMLElement.prototype.scrollIntoView;
    window.previewTurns = [];
    HTMLElement.prototype.scrollIntoView = function (...args) {
      if (this.dataset.generationTurnKey) window.previewTurns.push(this.dataset.generationTurnKey);
      return scrollIntoView.apply(this, args);
    };
    window.__TAURI_INTERNALS__.invoke = (command, args = {}) => {
      if (command !== 'generation_history') return invoke(command, args);
      window.calls.push({ command, args });
      const turn = (file, prompt) => ({ turn_key: file, media: 'video', provider: 'jimeng', prompt, images: [`/${path}/${file}.mp4`] });
      const turns = args.assetId === 'generated' ? [turn('generated', '所选视频的原提示词'), turn('later', '后续视频的提示词')]
        : args.assetId === 'h3' && args.includeLocalVideo ? [{ ...turn('h3', '本地 H3 原提交提示词'), provider: 'comfy-h3' }] : [];
      return Promise.resolve({ session_id: args.assetId === 'generated' ? 'video-session' : null, media: 'video', turns, references: [] });
    };
  }, directory);
  const modal = page.getByRole('dialog', { name: '视频与会话预览', exact: true });
  const detail = modal.getByRole('region', { name: '视频详情', exact: true });
  const history = modal.getByRole('region', { name: '独立会话面板' });
  const player = modal.getByRole('region', { name: '视频播放器' });
  const open = async id => {
    await page.locator(`[data-canvas-node-id="video-${id}"]`).click();
    await modal.waitFor();
    await detail.waitFor();
    assert.equal(await detail.locator('video').count(), 0);
    assert.equal(await player.count(), 1);
  };
  const close = async () => { await page.keyboard.press('Escape'); await modal.waitFor({ state: 'hidden' }); };
  await open('plain');
  assert.equal(await history.count(), 0);
  await page.waitForFunction(() => document.querySelector('.creation-image-preview video')?.readyState >= 2);
  assert.equal(await player.evaluate(element => element === document.activeElement), true, 'opening focuses the video controls');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => !document.querySelector('.creation-image-preview video').paused);
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('.creation-image-preview video').paused);
  await player.getByRole('button', { name: '全屏', exact: true }).click();
  await page.waitForFunction(() => document.fullscreenElement?.matches('.video-player'));
  await page.keyboard.press('Escape');
  assert.equal(await modal.isVisible(), true, 'Escape from fullscreen keeps the preview open');
  if (await player.getByRole('button', { name: '退出全屏' }).isVisible()) await player.getByRole('button', { name: '退出全屏' }).click();
  const exportFrame = player.getByRole('button', { name: '导出帧' });
  const exportMenu = modal.getByRole('menu', { name: '导出帧' });
  const assertAnchored = () => page.waitForFunction(() => {
    const trigger = document.querySelector('.creation-image-preview button[aria-expanded="true"][aria-haspopup="menu"]');
    const menu = document.querySelector('.creation-image-preview .video-export-popup');
    if (!trigger || !menu) return false;
    const button = trigger.getBoundingClientRect(), popup = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(button.left, innerWidth - popup.width - 8));
    return Math.abs(popup.left - left) <= 1 &&
      (Math.abs(popup.top - button.bottom - 4) <= 1 || Math.abs(button.top - popup.bottom - 4) <= 1) &&
      popup.top >= 7 && popup.bottom <= innerHeight - 7;
  }, null, { timeout: 3000 });
  await exportFrame.click();
  await exportMenu.waitFor();
  await assertAnchored();
  await page.setViewportSize({ width: 1100, height: 700 });
  await assertAnchored();
  await page.keyboard.press('Escape');
  await exportMenu.waitFor({ state: 'hidden' });
  assert.equal(await exportFrame.evaluate(element => document.activeElement === element), true);
  await page.setViewportSize({ width: 1400, height: 900 });
  await exportFrame.click();
  await page.getByRole('menuitem', { name: '添加该帧到画板' }).click();
  await page.waitForFunction(() => window.calls.some(call => call.command === 'import_image_bytes'
    && call.args.videoFrame?.sourcePath.endsWith('/plain.mp4')));
  await page.waitForFunction(() => !document.fullscreenElement && !document.querySelector('.video-export-popup'));
  await close();

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open('generated');
  await history.waitFor();
  await history.locator('[data-generation-turn-key="generated"]').getByText('所选视频的原提示词').waitFor();
  await history.locator('[data-generation-turn-key="later"]').getByText('后续视频的提示词').waitFor();
  await page.waitForFunction(() => window.previewTurns.at(-1) === 'generated');
  const center = await player.boundingBox();
  assert.ok((await detail.boundingBox()).x < center.x);
  assert.ok((await history.boundingBox()).x > center.x);
  await modal.getByRole('button', { name: '收起会话面板' }).click();
  await history.waitFor({ state: 'hidden' });
  assert.deepEqual(await player.boundingBox(), center, 'closing either panel preserves the player geometry');
  await modal.getByRole('button', { name: '显示会话' }).click();
  await history.waitFor();
  await close();

  await open('h3');
  await history.getByText('本地 H3 原提交提示词').waitFor();
  assert.equal(await page.evaluate(() => window.calls.some(call => call.command === 'generation_history'
    && call.args.assetId === 'h3' && call.args.includeLocalVideo === true)), true);
  await close();

  assert.deepEqual(errors, []);
  console.log('PASS: shared video preview layout, plain and generated details, local H3 history, keyboard playback and panel toggle');
} finally {
  await browser.close();
  await server.close();
}
