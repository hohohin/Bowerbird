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
for (const [name, color, duration = 2, rate = 25] of [['plain', 'lime'], ['generated', 'blue'], ['later', 'red'], ['h3', 'purple'], ['long', 'orange', 250, 1], ['repeat', 'cyan']]) {
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
      { id: 'repeat', name: '同账号第二条视频', source: 'imported' },
    ].map(asset => ({ ext: 'mp4', width: 320, height: 180, duration: 2, ...asset, store_path: `/${path}/${asset.id}.mp4` }));
    const snapshot = window.snapshot();
    const base = snapshot.nodes.find(node => node.id === 'old');
    snapshot.nodes = videos.map((asset, index) => ({ ...base, id: `video-${asset.id}`, assetId: asset.id,
      x: 180 + index % 4 * 260, y: 165 + Math.floor(index / 4) * 180, width: 220, height: 128 }));
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
    window.store.setState({ cloudAuth: { logged_in: true, user_id: 'test-owner', cloud_available: true } });
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
      if (!['generation_history', 'video_analysis_get', 'video_transcript_capabilities', 'video_transcript_get', 'video_transcript_quote', 'video_transcript_start'].includes(command)) {
        return invoke(command, args);
      }
      window.calls.push({ command, args });
      if (command === 'video_analysis_get') return Promise.resolve(args.assetId === 'plain' ? { text: '窗边近景，暖色光线。' } : null);
      if (command === 'video_transcript_capabilities') return window.transcriptCapabilities === 'offline'
        ? Promise.reject(new Error('connection refused')) : Promise.resolve(window.transcriptCapabilities);
      if (command === 'video_transcript_get') return Promise.resolve(transcripts[args.assetId] ?? null);
      if (command === 'video_transcript_quote') {
        const isLong = args.assetId === 'long';
        const noAudio = args.assetId === window.noAudioAsset;
        const quote = { sourceHash: `hash-${args.assetId}`, durationSeconds: isLong ? 250 : 2,
          chargeRequired: !noAudio, noAudio, cloudPending: false };
        if (window.holdQuote) return new Promise(resolve => { window.releaseQuote = () => resolve(quote); });
        return Promise.resolve(quote);
      }
      if (command === 'video_transcript_start') {
        if (args.assetId === 'long') {
          if (args.quote && args.expectedCredits !== window.transcriptCapabilities.credits) {
            if (window.throwStalePrice) return Promise.reject(new Error('视频转录价格已变化，请重新核对报价'));
            transcripts.long = { status: 'interrupted', text: '', utterances: [], priceChanged: true };
            return Promise.resolve(transcripts.long);
          }
          transcripts.long = args.quote ? { status: 'running', text: '', utterances: [] }
            : { status: 'completed', text: '片尾的讲话。', utterances: [{ startMs: 235000, endMs: 236000, text: '片尾的讲话。' }] };
          return Promise.resolve(transcripts.long);
        }
        transcripts[args.assetId] = {
          status: ['plain', 'repeat'].includes(args.assetId) ? 'running' : 'no_speech', text: '', utterances: [],
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
  const workspace = page.getByRole('dialog', { name: '视频分析工作区', exact: true });
  const detail = modal.getByRole('region', { name: '视频详情', exact: true });
  const history = modal.getByRole('region', { name: '独立会话面板' });
  const transcript = workspace.getByRole('region', { name: '转录文稿', exact: true });
  const player = modal.getByRole('region', { name: '视频播放器' });
  const enterTranscript = async () => {
    await modal.getByRole('button', { name: '打开转录文稿', exact: true }).click();
    await workspace.waitFor();
  };
  const capabilityCount = () => page.evaluate(() => window.calls.filter(call => call.command === 'video_transcript_capabilities').length);
  const open = async (id, enter = true) => {
    await page.locator(`[data-canvas-node-id="video-${id}"]`).click();
    await modal.waitFor();
    await detail.waitFor();
    assert.equal(await detail.locator('video').count(), 0);
    assert.equal(await player.count(), 1);
    if (enter) await enterTranscript();
  };
  const close = async () => {
    if (await workspace.isVisible()) {
      await workspace.getByRole('button', { name: '关闭视频分析', exact: true }).click();
      await workspace.waitFor({ state: 'hidden' });
    } else {
      await page.keyboard.press('Escape');
      await modal.waitFor({ state: 'hidden' });
    }
  };
  await open('plain', false);
  assert.equal(await history.count(), 0);
  const previewEntry = detail.getByRole('region', { name: '视频分析', exact: true });
  await previewEntry.getByRole('button', { name: '分析', exact: true }).waitFor();
  await previewEntry.getByText('转录 · 7 Bcoin', { exact: true }).waitFor();
  assert.equal(await modal.getByRole('searchbox', { name: '搜索文稿', exact: true }).count(), 0);
  assert.deepEqual(await page.evaluate(() => window.calls.filter(call => call.command.startsWith('video_transcript')).map(call => call.command)),
    ['video_transcript_capabilities']);
  assert.equal(await page.evaluate(() => window.calls.some(call => call.command === 'video_analysis_get')), false);
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
  await detail.getByRole('region', { name: '视频分析', exact: true }).getByRole('button', { name: '分析', exact: true }).click();
  await workspace.getByRole('region', { name: '转录操作', exact: true }).getByRole('button', { name: '转录 · 7 Bcoin', exact: true }).waitFor();
  const visualDescription = workspace.getByRole('region', { name: '画面描述', exact: true });
  await visualDescription.getByText('窗边近景，暖色光线。', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.calls.filter(call => call.command === 'video_analysis_get').map(call => call.args)), [{ assetId: 'plain' }]);
  await workspace.getByRole('button', { name: '转录文稿', exact: true }).click();
  await visualDescription.waitFor({ state: 'hidden' });
  const quote = transcript.getByRole('button', { name: '转录 · 7 Bcoin', exact: true });
  await quote.waitFor();
  await transcript.getByText('发送至 Bowerbird Cloud', { exact: false }).waitFor();
  assert.equal(await page.evaluate(() => window.calls.some(call => call.command === 'video_transcript_quote' || call.command === 'video_transcript_start')), false);
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === 'video_transcript_capabilities').length), 1);
  await quote.click();
  await transcript.getByText('正在转录，关闭窗口后可回来查看。', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.calls.filter(call => call.command === 'video_transcript_quote')
    .map(call => call.args.assetId)), ['plain']);
  await close();
  await open('plain');
  await transcript.getByText('正在转录，关闭窗口后可回来查看。', { exact: true }).waitFor();
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

  const repeatBoundary = await page.evaluate(() => window.calls.length);
  await open('repeat', false);
  const repeatEntry = detail.getByRole('region', { name: '视频分析', exact: true });
  await repeatEntry.getByText('转录 · 7 Bcoin', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(start => window.calls.slice(start)
    .filter(call => call.command.startsWith('video_transcript')).map(call => call.command), repeatBoundary), ['video_transcript_capabilities']);
  await repeatEntry.getByRole('button', { name: '分析', exact: true }).click();
  const repeatAnalysis = workspace.getByRole('region', { name: '转录操作', exact: true });
  const repeatQuote = repeatAnalysis.getByRole('button', { name: '转录 · 7 Bcoin', exact: true });
  await repeatQuote.waitFor();
  assert.equal(await page.evaluate(start => window.calls.slice(start).some(call =>
    call.command === 'video_transcript_quote' || call.command === 'video_transcript_start'), repeatBoundary), false);
  await repeatQuote.click();
  await repeatAnalysis.getByText('正在转录，关闭窗口后可回来查看。', { exact: true }).waitFor();
  await page.evaluate(() => {
    window.videoTranscripts.repeat = { status: 'completed', text: '同账号第二条文稿。', utterances: [
      { startMs: 100, endMs: 1000, text: '同账号第二条文稿。' },
    ] };
  });
  await repeatAnalysis.getByRole('button', { name: '查看转录文稿', exact: true }).click();
  await transcript.getByText('同账号第二条文稿。', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.calls.filter(call => call.command === 'video_transcript_start').map(call => call.args)), [
    { assetId: 'plain', expectedUserId: 'test-owner', expectedCredits: 7, quote: { sourceHash: 'hash-plain' } },
    { assetId: 'repeat', expectedUserId: 'test-owner', expectedCredits: 7, quote: { sourceHash: 'hash-repeat' } },
  ]);
  await close();
  await open('plain');
  await transcript.getByText('第二句。', { exact: true }).waitFor();
  await close();

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open('generated', false);
  await history.waitFor();
  await history.locator('[data-generation-turn-key="generated"]').getByText('所选视频的原提示词').waitFor();
  await history.locator('[data-generation-turn-key="later"]').getByText('后续视频的提示词').waitFor();
  await page.waitForFunction(() => window.previewTurns.at(-1) === 'generated');
  const center = await player.boundingBox();
  assert.ok((await detail.boundingBox()).x < center.x);
  assert.ok((await history.boundingBox()).x > center.x);
  await enterTranscript();
  await transcript.getByText('此视频没有音轨。', { exact: true }).waitFor();
  await history.waitFor({ state: 'hidden' });
  await workspace.getByRole('button', { name: '返回视频预览', exact: true }).click();
  await history.getByText('所选视频的原提示词').waitFor();
  await modal.getByRole('button', { name: '收起会话面板' }).click();
  await history.waitFor({ state: 'hidden' });
  assert.deepEqual(await player.boundingBox(), center, 'closing either panel preserves the player geometry');
  await modal.getByRole('button', { name: '显示会话' }).click();
  await history.waitFor();
  await close();

  await page.evaluate(() => { window.transcriptCapabilities = { available: false, credits: null, maxDurationMs: 7200000 }; });
  await open('h3', false);
  await history.getByText('本地 H3 原提交提示词').waitFor();
  assert.equal(await page.evaluate(() => window.calls.some(call => call.command === 'generation_history'
    && call.args.assetId === 'h3' && call.args.includeLocalVideo === true)), true);
  await enterTranscript();
  await transcript.getByRole('button', { name: '恢复原任务', exact: true }).click();
  await transcript.getByText('未识别到语音。', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.calls.find(call => call.command === 'video_transcript_start'
    && call.args.assetId === 'h3')?.args), { assetId: 'h3', expectedUserId: 'test-owner', expectedCredits: undefined, quote: undefined });
  await close();

  await open('long', false);
  const previewAnalysis = detail.getByRole('region', { name: '视频分析', exact: true });
  await previewAnalysis.getByText('转录服务暂不可用', { exact: true }).waitFor();
  const unavailableCount = await capabilityCount();
  await page.evaluate(() => { window.transcriptCapabilities = { available: true, credits: 1, maxDurationMs: 7200000 }; });
  await previewAnalysis.getByRole('button', { name: '分析', exact: true }).click();
  const availablePrice = '转录 · 1 Bcoin';
  await workspace.getByRole('region', { name: '转录操作', exact: true }).getByRole('button', { name: availablePrice, exact: true }).waitFor();
  assert.equal(await capabilityCount(), unavailableCount + 1);
  await workspace.getByRole('button', { name: '返回视频预览', exact: true }).click();
  await previewAnalysis.getByText(availablePrice, { exact: true }).waitFor();
  await enterTranscript();
  await transcript.getByRole('button', { name: availablePrice, exact: true }).waitFor();
  assert.equal(await capabilityCount(), unavailableCount + 1);
  assert.equal(await page.evaluate(() => window.calls.some(call => ['video_transcript_quote', 'video_transcript_start'].includes(call.command)
    && call.args.assetId === 'long')), false);
  await close();

  await page.evaluate(() => { window.transcriptCapabilities = { available: false, credits: null, maxDurationMs: 7200000 }; });
  await open('long');
  await transcript.getByText('视频转录服务暂不可用。', { exact: true }).waitFor();
  const beforeManualRefresh = await capabilityCount();
  await transcript.getByRole('button', { name: '刷新服务状态', exact: true }).click();
  await transcript.getByText('视频转录服务暂不可用。', { exact: true }).waitFor();
  assert.equal(await capabilityCount(), beforeManualRefresh + 1);
  await page.evaluate(() => { window.store.setState({ cloudAuth: { logged_in: false, user_id: null, cloud_available: true } }); });
  await transcript.getByText('请先登录 Bowerbird 账号。', { exact: true }).waitFor();
  await page.evaluate(() => {
    window.transcriptCapabilities = 'offline';
    window.store.setState({ cloudAuth: { logged_in: true, user_id: 'test-owner', cloud_available: true } });
  });
  await transcript.getByText('暂时无法连接转录服务。', { exact: true }).waitFor();
  await page.evaluate(() => { window.transcriptCapabilities = { available: true, credits: 7, maxDurationMs: 100000 }; });
  await transcript.getByRole('button', { name: '刷新服务状态', exact: true }).click();
  await transcript.getByText('视频时长超过转录上限，请先裁剪后重试。', { exact: true }).waitFor();
  await close();

  await open('plain');
  await transcript.getByText('第二句。', { exact: true }).waitFor();
  await close();

  await page.evaluate(() => { window.transcriptCapabilities = { available: true, credits: 7, maxDurationMs: 7200000 }; });
  await open('long');
  await quote.waitFor();
  await page.evaluate(() => {
    window.store.setState({ cloudEntitlement: { user_id: 'test-owner', tier: 'free', offline_state: 'fresh',
      balances: { daily: 0, sub: 0, topup: 0 }, policy: {}, recent_transactions: [], generation_services: [] } });
  });
  await transcript.getByText('可用积分不足，请补充积分后继续。', { exact: true }).waitFor();
  assert.equal(await quote.isEnabled(), false);
  await page.evaluate(() => { window.store.setState({ cloudEntitlement: null }); });
  await page.evaluate(() => { window.holdQuote = true; });
  await quote.click();
  await page.waitForFunction(() => window.releaseQuote);
  await close();
  await open('generated');
  await transcript.getByText('此视频没有音轨。', { exact: true }).waitFor();
  await page.evaluate(() => { window.holdQuote = false; window.releaseQuote(); window.releaseQuote = null; });
  await close();
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === 'video_transcript_start' && call.args.assetId === 'long').length), 0);

  await open('long');
  await quote.waitFor();
  await page.evaluate(() => { window.noAudioAsset = 'long'; });
  await quote.click();
  await transcript.getByText('此视频没有音轨。', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === 'video_transcript_start' && call.args.assetId === 'long').length), 0);
  await page.evaluate(() => { window.noAudioAsset = null; });
  await close();

  await open('long');
  await quote.waitFor();
  await page.evaluate(() => { window.holdQuote = true; });
  await quote.click();
  await page.waitForFunction(() => window.releaseQuote);
  await page.evaluate(() => {
    window.store.setState({ cloudAuth: { logged_in: true, user_id: 'other-owner', cloud_available: true } });
    window.holdQuote = false;
    window.releaseQuote();
  });
  await quote.waitFor();
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === 'video_transcript_start' && call.args.assetId === 'long').length), 0);
  await page.evaluate(() => {
    window.store.setState({ cloudAuth: { logged_in: true, user_id: 'test-owner', cloud_available: true } });
  });
  await quote.waitFor();
  await page.evaluate(() => { window.transcriptCapabilities = { available: true, credits: 8, maxDurationMs: 7200000 }; });
  await quote.click();
  await transcript.getByText('转录价格已变化，请确认新价格。', { exact: true }).waitFor();
  const revisedPrice = transcript.getByRole('button', { name: '转录 · 8 Bcoin', exact: true });
  await revisedPrice.waitFor();
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === 'video_transcript_start'
    && call.args.assetId === 'long').length), 1, 'a refreshed price does not auto-submit');
  await page.evaluate(() => {
    window.transcriptCapabilities = { available: true, credits: 9, maxDurationMs: 7200000 };
    window.throwStalePrice = true;
  });
  await revisedPrice.click();
  const finalPrice = transcript.getByRole('button', { name: '转录 · 9 Bcoin', exact: true });
  await finalPrice.waitFor();
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === 'video_transcript_start'
    && call.args.assetId === 'long').length), 2, 'an IPC price error refreshes the visible price without auto-submit');
  await finalPrice.click();
  await transcript.getByText('正在转录，关闭窗口后可回来查看。', { exact: true }).waitFor();
  await page.evaluate(() => {
    window.videoTranscripts.long = { status: 'interrupted', text: '', utterances: [], cloudPending: true };
    window.transcriptCapabilities = { available: false, credits: null, maxDurationMs: 7200000 };
  });
  await transcript.getByRole('button', { name: '恢复原任务', exact: true }).click();
  await transcript.getByText('片尾的讲话。', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.calls.filter(call => call.command === 'video_transcript_start' && call.args.assetId === 'long').map(call => call.args)), [
    { assetId: 'long', expectedUserId: 'test-owner', expectedCredits: 7, quote: { sourceHash: 'hash-long' } },
    { assetId: 'long', expectedUserId: 'test-owner', expectedCredits: 8, quote: { sourceHash: 'hash-long' } },
    { assetId: 'long', expectedUserId: 'test-owner', expectedCredits: 9, quote: { sourceHash: 'hash-long' } },
    { assetId: 'long', expectedUserId: 'test-owner', expectedCredits: undefined, quote: undefined },
  ]);
  await transcript.getByRole('button', { name: '跳转至 3:55.000' }).click();
  await page.waitForFunction(() => Math.abs(document.querySelector('.creation-image-preview video').currentTime - 235) < 0.025);
  await close();

  await page.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const line = { startMs: 350, endMs: 1700, text: '刚刚。' };
    const legacy = { status: 'completed', text: line.text, canRefreshTiming: true, utterances: [line] };
    const enriched = { status: 'completed', text: line.text, utterances: [
      { ...line, words: [
          { startMs: 450, endMs: 600, text: '刚' },
          { startMs: 1250, endMs: 1520, text: '刚' },
      ] },
    ] };
    window.timingCalls = [];
    window.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command.startsWith('video_transcript')) window.timingCalls.push({ command, args });
      if (command === 'video_transcript_get' && args.assetId === 'plain') return Promise.resolve({
        ...legacy, canRefreshTiming: window.store.getState().cloudAuth?.user_id === 'test-owner',
      });
      if (command === 'video_transcript_capabilities') return Promise.resolve({ available: false, reason: 'pilot_exhausted', credits: null });
      if (command === 'video_transcript_refresh_timing') {
        if (window.rejectTimingRefresh) return Promise.reject(new Error('原任务结果暂时无法读取'));
        return new Promise(resolve => { window.releaseTimingRefresh = () => resolve(enriched); });
      }
      return invoke(command, args);
    };
    window.store.setState({ cloudAuth: { logged_in: true, user_id: 'test-owner', cloud_available: true } });
  });
  await open('plain', false);
  const analysisEntry = detail.getByRole('region', { name: '视频分析', exact: true });
  await analysisEntry.getByRole('button', { name: '转录文稿', exact: true }).waitFor();
  await analysisEntry.getByText('试转录名额已使用', { exact: true }).waitFor();
  assert.equal(await detail.getByText('反推', { exact: true }).count(), 0);
  assert.equal(await detail.getByRole('searchbox', { name: '搜索文稿', exact: true }).count(), 0);
  assert.deepEqual(await page.evaluate(() => window.timingCalls.map(call => call.command)), ['video_transcript_capabilities']);
  await analysisEntry.getByRole('button', { name: '分析', exact: true }).click();
  await workspace.getByRole('region', { name: '转录操作', exact: true }).getByText('已完成转录。', { exact: true }).waitFor();
  assert.equal(await workspace.getByRole('searchbox', { name: '搜索文稿', exact: true }).count(), 0);
  await workspace.getByRole('button', { name: '查看转录文稿', exact: true }).click();
  await transcript.getByText('这份文稿只有句级时间，点击句首时间跳转。', { exact: true }).waitFor();
  await transcript.getByText('刚刚。', { exact: true }).waitFor();
  const box = await transcript.boundingBox();
  const videoBox = await workspace.getByRole('region', { name: '视频播放器', exact: true }).boundingBox();
  assert.ok(box.width >= 560 && videoBox.x + videoBox.width <= box.x, 'roomy transcript beside the same workspace video');
  const repair = transcript.getByRole('button', { name: '补齐字级时间', exact: true });
  await repair.waitFor();
  await page.evaluate(() => { window.store.setState({ cloudAuth: { logged_in: true, user_id: 'other-user', cloud_available: true } }); });
  await repair.waitFor({ state: 'hidden' });
  assert.equal(await transcript.getByText('刚刚。', { exact: true }).isVisible(), true);
  await page.evaluate(() => {
    window.rejectTimingRefresh = true;
    window.store.setState({ cloudAuth: { logged_in: true, user_id: 'test-owner', cloud_available: true } });
  });
  await repair.click();
  await transcript.getByRole('alert').waitFor();
  assert.equal(await transcript.getByText('刚刚。', { exact: true }).isVisible(), true);
  await page.evaluate(() => { window.rejectTimingRefresh = false; });
  await repair.click();
  await transcript.getByText('正在补齐字级时间…', { exact: true }).waitFor();
  assert.equal(await transcript.getByText('刚刚。', { exact: true }).count(), 1, 'existing text remains readable during repair');
  assert.deepEqual(await page.evaluate(() => window.timingCalls.filter(({ command }) => command === 'video_transcript_refresh_timing')), [
    { command: 'video_transcript_refresh_timing', args: { assetId: 'plain', expectedUserId: 'test-owner' } },
    { command: 'video_transcript_refresh_timing', args: { assetId: 'plain', expectedUserId: 'test-owner' } },
  ]);
  assert.equal(await page.evaluate(() => window.timingCalls.some(({ command }) => ['video_transcript_quote', 'video_transcript_start'].includes(command))), false);
  await page.evaluate(() => window.releaseTimingRefresh());
  await transcript.getByRole('button', { name: '跳转至 0:00.450 · 刚', exact: true }).click();
  await page.waitForFunction(() => Math.abs(document.querySelector('.is-video-analysis video')?.currentTime - 0.45) < 0.025);
  await transcript.getByRole('button', { name: '跳转至 0:01.250 · 刚', exact: true }).click();
  await page.waitForFunction(() => Math.abs(document.querySelector('.is-video-analysis video')?.currentTime - 1.25) < 0.025);
  await page.screenshot({ path: `${directory}/analysis-workspace.png` });
  await page.setViewportSize({ width: 800, height: 800 });
  await workspace.getByRole('searchbox', { name: '搜索文稿', exact: true }).waitFor();
  const narrowTranscript = await transcript.boundingBox();
  const narrowVideo = await workspace.getByRole('region', { name: '视频播放器', exact: true }).boundingBox();
  assert.ok(narrowTranscript.y > narrowVideo.y && narrowTranscript.width >= 700);
  await workspace.getByRole('button', { name: '返回视频预览', exact: true }).click();
  await modal.waitFor();
  assert.equal(await analysisEntry.getByRole('button', { name: '分析', exact: true }).evaluate(button => document.activeElement === button), true);
  await close();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.evaluate(() => {
    window.videoReferences = [];
    window.addEventListener('bowerbird://board-asset-picked', event => window.videoReferences.push(event.detail));
    window.store.setState({ boardOpen: true });
  });
  await page.locator('.creation-dock').getByRole('button', { name: '视频', exact: true }).click();
  await page.locator('.creation-dock.is-creating[data-video-references="true"]').waitFor();
  await page.locator('[data-canvas-node-id="video-plain"]').dblclick();
  await page.waitForFunction(() => window.videoReferences.length === 1);
  assert.deepEqual(await page.evaluate(() => window.videoReferences), [{ assetId: 'plain', canvasNodeId: 'video-plain', target: 'creation-board' }]);
  assert.equal(await modal.count(), 0);
  await page.goto(server.resolvedUrls.local[0] + entry + '?detail-route');
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await page.evaluate(() => { window.store.getState().openDetail('existing'); });
  await page.locator('.asset-detail:not(.asset-detail-panel-only)').getByText('反推', { exact: true }).first().waitFor();
  assert.equal(await analysisEntry.count(), 0);

  assert.deepEqual(errors, []);
  console.log('PASS: distinct workspace entry modes, two videos at the same account quote, account guards, repair, exact seek and responsive layout');
} finally {
  await browser.close();
  await server.close();
}
