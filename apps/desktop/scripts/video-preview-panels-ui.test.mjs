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
for (const [name, color, duration = 2, rate = 25] of [['plain', 'lime'], ['generated', 'blue'], ['later', 'red'], ['h3', 'purple'], ['long', 'orange', 250, 1]]) {
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=${color}:s=320x180:r=${rate}:d=${duration}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', `${directory}/${name}.mp4`]);
}
const server = await createServer({ cacheDir: `${directory}/vite`, optimizeDeps: { entries: [entry] },
  server: { host: '127.0.0.1', port: 1676, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
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
      { id: 'long', name: '长视频', source: 'imported', duration: 250 },
    ].map(asset => ({ ext: 'mp4', width: 320, height: 180, duration: 2, ...asset, store_path: `/${path}/${asset.id}.mp4` }));
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
    window.store.setState({ cloudAuth: { logged_in: true, user_id: 'test-owner' } });
    window.transcriptCapabilities = { available: true, credits: 7, maxDurationMs: 7200000 };
    const transcripts = {
      generated: { status: 'no_audio', text: '', utterances: [] },
      h3: { status: 'interrupted', text: '', utterances: [], cloudPending: true },
    };
    window.videoTranscripts = transcripts;
    HTMLElement.prototype.scrollIntoView = function (...args) {
      if (this.dataset.generationTurnKey) window.previewTurns.push(this.dataset.generationTurnKey);
      return scrollIntoView.apply(this, args);
    };
    window.__TAURI_INTERNALS__.invoke = (command, args = {}) => {
      if (!['generation_history', 'video_transcript_capabilities', 'video_transcript_get', 'video_transcript_quote', 'video_transcript_start'].includes(command)) {
        return invoke(command, args);
      }
      window.calls.push({ command, args });
      if (command === 'video_transcript_capabilities') return Promise.resolve(window.transcriptCapabilities);
      if (command === 'video_transcript_get') return Promise.resolve(transcripts[args.assetId] ?? null);
      if (command === 'video_transcript_quote') {
        const isLong = args.assetId === 'long';
        return Promise.resolve({ sourceHash: `hash-${args.assetId}`, durationSeconds: isLong ? 250 : 2,
          chargeRequired: true, noAudio: false, cloudPending: false });
      }
      if (command === 'video_transcript_start') {
        if (args.assetId === 'long') {
          transcripts.long = args.quote ? { status: 'running', text: '', utterances: [] }
            : { status: 'completed', text: '片尾的讲话。', utterances: [{ startMs: 235000, endMs: 236000, text: '片尾的讲话。' }] };
          return Promise.resolve(transcripts.long);
        }
        transcripts[args.assetId] = {
          status: args.assetId === 'plain' ? 'running' : 'no_speech', text: '', utterances: [],
        };
        return Promise.resolve(transcripts[args.assetId]);
      }
      const turn = (file, prompt) => ({ turn_key: file, media: 'video', provider: 'jimeng', prompt, images: [`/${path}/${file}.mp4`] });
      const turns = args.assetId === 'generated' ? [turn('generated', '所选视频的原提示词'), turn('later', '后续视频的提示词')]
        : args.assetId === 'h3' && args.includeLocalVideo ? [{ ...turn('h3', '本地 H3 原提交提示词'), provider: 'comfy-h3' }] : [];
      return Promise.resolve({ session_id: args.assetId === 'generated' ? 'video-session' : null, media: 'video', turns, references: [] });
    };
  }, directory);
  const modal = page.getByRole('dialog', { name: '视频与会话预览', exact: true });
  const detail = modal.getByRole('region', { name: '视频详情', exact: true });
  const history = modal.getByRole('region', { name: '独立会话面板' });
  const transcript = modal.getByRole('region', { name: '转录文稿', exact: true });
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
  const quote = transcript.getByRole('button', { name: '核对转录费用', exact: true });
  await quote.waitFor();
  assert.equal(await page.evaluate(() => window.calls.some(call => call.command === 'video_transcript_quote')), false, 'preview alone does not scan the original for a quote');
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
  await quote.click();
  await transcript.getByText('整条音轨 · 0:02 · 7 Bcoin', { exact: true }).waitFor();
  await transcript.getByText('发送至 Bowerbird Cloud', { exact: false }).waitFor();
  assert.equal(await page.evaluate(() => window.calls.some(call => call.command === 'video_transcript_start')), false);
  await transcript.getByRole('button', { name: '获取转录', exact: true }).click();
  await transcript.getByText('正在转录，关闭预览后可回来查看。', { exact: true }).waitFor();
  await close();
  await open('plain');
  await transcript.getByText('正在转录，关闭预览后可回来查看。', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.calls.filter(call => call.command === 'video_transcript_start')
    .map(call => call.args)), [{ assetId: 'plain', expectedUserId: 'test-owner', expectedCredits: 7, quote: { sourceHash: 'hash-plain' } }]);
  await page.evaluate(() => {
    window.videoTranscripts.plain = { status: 'completed', text: '第一句。\n第二句。', utterances: [
      { startMs: 100, endMs: 1000, text: '第一句。' },
      { startMs: 1250, endMs: 1800, text: '第二句。' },
    ] };
  });
  await transcript.getByText('第二句。', { exact: true }).waitFor();
  await transcript.getByRole('searchbox', { name: '搜索文稿' }).fill('第二句');
  assert.equal(await transcript.getByText('第一句。', { exact: true }).count(), 0);
  const jump = transcript.getByRole('button', { name: '跳转至 0:01.250' });
  await jump.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => Math.abs(document.querySelector('.creation-image-preview video').currentTime - 1.25) < 0.025);
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
  await modal.getByRole('button', { name: '转录文稿', exact: true }).click();
  await transcript.getByText('此视频没有音轨。', { exact: true }).waitFor();
  await history.waitFor({ state: 'hidden' });
  await modal.getByRole('button', { name: '会话', exact: true }).click();
  await history.getByText('所选视频的原提示词').waitFor();
  await modal.getByRole('button', { name: '收起会话面板' }).click();
  await history.waitFor({ state: 'hidden' });
  assert.deepEqual(await player.boundingBox(), center, 'closing either panel preserves the player geometry');
  await modal.getByRole('button', { name: '显示会话' }).click();
  await history.waitFor();
  await close();

  await page.evaluate(() => { window.transcriptCapabilities = { available: false, credits: null, maxDurationMs: 7200000 }; });
  await open('h3');
  await history.getByText('本地 H3 原提交提示词').waitFor();
  assert.equal(await page.evaluate(() => window.calls.some(call => call.command === 'generation_history'
    && call.args.assetId === 'h3' && call.args.includeLocalVideo === true)), true);
  await modal.getByRole('button', { name: '转录文稿', exact: true }).click();
  await transcript.getByRole('button', { name: '恢复原任务', exact: true }).click();
  await transcript.getByText('未识别到语音。', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.calls.find(call => call.command === 'video_transcript_start'
    && call.args.assetId === 'h3')?.args), { assetId: 'h3', expectedUserId: 'test-owner', expectedCredits: undefined, quote: undefined });
  await close();

  await open('long');
  await quote.click();
  await transcript.getByText('视频转录服务暂不可用。', { exact: true }).waitFor();
  assert.equal(await transcript.getByRole('button', { name: '获取转录', exact: true }).count(), 0);
  await page.evaluate(() => { window.transcriptCapabilities = { available: true, credits: 7, maxDurationMs: 7200000 }; });
  await transcript.getByRole('button', { name: '刷新服务状态', exact: true }).click();
  await transcript.getByText('整条音轨 · 4:10 · 7 Bcoin', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === 'video_transcript_start' && call.args.assetId === 'long').length), 0);
  await transcript.getByRole('button', { name: '获取转录', exact: true }).click();
  await transcript.getByText('正在转录，关闭预览后可回来查看。', { exact: true }).waitFor();
  await page.evaluate(() => {
    window.videoTranscripts.long = { status: 'interrupted', text: '', utterances: [], cloudPending: true };
    window.transcriptCapabilities = { available: false, credits: null, maxDurationMs: 7200000 };
  });
  await transcript.getByRole('button', { name: '恢复原任务', exact: true }).click();
  await transcript.getByText('片尾的讲话。', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.calls.filter(call => call.command === 'video_transcript_start' && call.args.assetId === 'long').map(call => call.args)), [
    { assetId: 'long', expectedUserId: 'test-owner', expectedCredits: 7, quote: { sourceHash: 'hash-long' } },
    { assetId: 'long', expectedUserId: 'test-owner', expectedCredits: undefined, quote: undefined },
  ]);
  await transcript.getByRole('button', { name: '跳转至 3:55.000' }).click();
  await page.waitForFunction(() => Math.abs(document.querySelector('.creation-image-preview video').currentTime - 235) < 0.025);
  await close();

  assert.deepEqual(errors, []);
  console.log('PASS: shared video preview, short and long full-track quotes, lookup-only recovery when unpriced, timestamp seek and conversation switching');
} finally {
  await browser.close();
  await server.close();
}
