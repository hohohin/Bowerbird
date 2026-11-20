import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({
  cacheDir: '.tmp/video-transcript-batch/vite',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1300, height: 900 }, reducedMotion: 'reduce' });
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
const base = server.resolvedUrls.local[0];
const dialog = () => page.getByRole('dialog', { name: '批量转录视频', exact: true });

async function installMock() {
  await page.evaluate(() => {
    window.store.setState({ cloudAuth: { logged_in: true, user_id: 'test-owner', cloud_available: true } });
    window.transcriptCalls = [];
    window.transcriptCapabilities = { available: false, credits: null, maxDurationMs: 7200000 };
    const prior = window.__TAURI_INTERNALS__.invoke;
    const record = (status, extra) => ({ status, text: '', utterances: [], ...extra });
    window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (command === 'catalog_graph_page') {
        window.transcriptCalls.push({ command, args });
        const prefix = args.filter.projectId || 'global';
        return { assets: [`${prefix}-saved`, `${prefix}-unavailable`, `${prefix}-noaudio`, `${prefix}-pending`, `${prefix}-long`, `${prefix}-silent`, `${prefix}-held`, `${prefix}-remaining`].map(id => ({ id })), after: null };
      }
      if (command === 'video_transcript_capabilities') return window.transcriptCapabilities;
      if (command === 'video_transcript_get') return args.assetId.endsWith('saved') ? record('completed') : null;
      if (command === 'video_transcript_quote') {
        window.transcriptCalls.push({ command, args });
        if (args.assetId.endsWith('unavailable')) throw new Error('无法确认视频时长，请检查原件');
        const noAudio = args.assetId.endsWith('noaudio');
        const isLong = args.assetId.endsWith('long');
        const cloudPending = args.assetId.endsWith('pending');
        return { sourceHash: `hash-${args.assetId}`, durationSeconds: isLong ? 250 : 2,
          chargeRequired: !noAudio && !cloudPending, noAudio, cloudPending };
      }
      if (command === 'video_transcript_start') {
        window.transcriptCalls.push({ command, args });
        if (args.assetId === window.transcriptPriceChangedOn) return record('interrupted', { cloudPending: false, priceChanged: true });
        if (args.assetId.endsWith('silent')) return record('no_speech');
        if (args.assetId.endsWith('held')) return record('interrupted', { cloudPending: true });
        return record('completed');
      }
      return prior(command, args);
    };
    window.mode.getState().setMedia('videos');
  });
}

async function openBatch() {
  const entry = page.getByRole('button', { name: '批量转录视频', exact: true });
  if (!await entry.isVisible()) {
    const more = page.getByRole('button', { name: '更多素材库控件', exact: true });
    if (await more.isVisible()) await more.click();
  }
  await entry.click();
  await dialog().waitFor();
}

try {
  await page.goto(`${base}scripts/fixtures/catalog-paging/preview.html?navigation&home`);
  await page.waitForFunction(() => window.store && window.__TAURI_INTERNALS__?.invoke);
  const navigation = page.getByRole('tablist', { name: '素材视图切换条', exact: true });
  await navigation.getByRole('tab', { name: '全部素材', exact: true }).click();
  await installMock();
  await openBatch();
  await dialog().getByText('视频转录服务暂不可用。', { exact: true }).waitFor();
  assert.equal(await dialog().getByRole('button', { name: '开始转录', exact: true }).isEnabled(), false);
  await page.evaluate(() => { window.transcriptCapabilities = { available: true, credits: 5, maxDurationMs: 7200000 }; });
  await dialog().getByRole('button', { name: '刷新服务状态', exact: true }).click();
  await dialog().getByText('单条 5 Bcoin，本次 4 条音轨，合计 20 Bcoin。', { exact: true }).waitFor();
  await dialog().getByText('本次可处理 4 个视频，跳过 4 个。', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.transcriptCalls.some(call => call.command === 'video_transcript_start')), false);
  await dialog().getByRole('button', { name: '开始转录', exact: true }).click();
  await dialog().getByText(/完成 2.*未完成 1.*未提交 1/).waitFor();
  await dialog().getByText('已完成的视频中，1 个未识别到语音。', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.transcriptCalls.filter(call => call.command === 'video_transcript_start').map(call => call.args)), [
    { assetId: 'global-long', expectedUserId: 'test-owner', expectedCredits: 5, quote: { sourceHash: 'hash-global-long' } },
    { assetId: 'global-silent', expectedUserId: 'test-owner', expectedCredits: 5, quote: { sourceHash: 'hash-global-silent' } },
    { assetId: 'global-held', expectedUserId: 'test-owner', expectedCredits: 5, quote: { sourceHash: 'hash-global-held' } },
  ]);
  await page.evaluate(() => { window.transcriptPriceChangedOn = 'global-long'; window.transcriptCalls = []; });
  await dialog().getByRole('button', { name: '选择新的范围', exact: true }).click();
  await dialog().getByText(/20 Bcoin/).first().waitFor();
  await dialog().getByRole('button', { name: '开始转录', exact: true }).click();
  await dialog().getByText('需要重新核对音轨和费用，剩余视频未提交。', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.transcriptCalls.filter(call => call.command === 'video_transcript_start').map(call => call.args.assetId)), ['global-long']);
  await dialog().getByRole('button', { name: '关闭', exact: true }).click();
  await navigation.getByRole('tab', { name: '项目素材', exact: true }).click();
  await page.getByRole('button', { name: '查看项目素材 项目A', exact: true }).click();
  await openBatch();
  await dialog().getByRole('button', { name: '选择新的范围', exact: true }).click();
  await dialog().getByText('项目内视频 · 项目A', { exact: true }).waitFor();
  await page.waitForFunction(() => window.transcriptCalls.some(call => call.command === 'catalog_graph_page' && call.args.filter.projectId === 'p'));

  await page.goto(`${base}scripts/fixtures/connected-collections/preview.html`);
  await page.waitForFunction(() => window.store && window.__TAURI_INTERNALS__?.invoke);
  await installMock();
  await page.locator('[data-collection-id="second"]').click();
  await openBatch();
  await dialog().getByText('本次可处理 1 个视频，跳过 0 个。', { exact: true }).waitFor();
  assert.equal(await dialog().getByRole('checkbox', { name: '包含子文件夹' }).isChecked(), false);
  assert.ok(await page.evaluate(() => window.requests.some(call => call.command === 'connection_entry_ids' && call.args.folderId === 'second' && call.args.media === 'videos')));
  console.log('PASS: batch scope, full-track quote, disabled when unpriced, and no further submissions on unknown state or a changed price');
} finally {
  await browser.close();
  await server.close();
}
