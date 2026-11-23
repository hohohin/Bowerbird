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

async function installMock(available = false) {
  await page.evaluate(available => {
    window.store.setState({ cloudAuth: { logged_in: true, user_id: 'test-owner', cloud_available: true } });
    window.transcriptCalls = [];
    window.visualCalls = [];
    window.videoMediaReads = [];
    window.transcriptCapabilities = { available, credits: available ? 5 : null, maxDurationMs: 7200000 };
    const prior = window.__TAURI_INTERNALS__.invoke;
    const record = (status, extra) => ({ status, text: '', utterances: [], ...extra });
    const menuAsset = scope => ({
      id: `menu-video-${scope}`, name: `转录视频 ${scope}`, ext: 'mp4', source: 'imported',
      width: 320, height: 180, store_path: `/menu-video-${scope}.mp4`, generation_session_id: scope === 'p' ? 'video-session' : null,
    });
    window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (args.filter?.media === 'videos') {
        const scope = args.filter.projectId || 'global';
        if (command === 'catalog_overview') return { ...await prior(command, args), total: 1 };
        if (command === 'catalog_page') return [menuAsset(scope)];
      }
      if (command === 'get_assets_by_ids' && args.assetIds.every(id => id.startsWith('menu-video-'))) {
        return args.assetIds.map(id => menuAsset(id.slice('menu-video-'.length)));
      }
      if (['list_analyses_by_asset', 'list_asset_tags', 'list_asset_collections'].includes(command)) return [];
      if (command === 'external_files_media' && args.path.endsWith('.mp4')) {
        window.videoMediaReads.push(args.path);
        return args.path;
      }
      if (command === 'generation_history' && args.assetId === 'menu-video-p') return {
        session_id: 'video-session', media: 'video', references: [],
        turns: [{ turn_key: 'generated', media: 'video', provider: 'jimeng', prompt: '会话测试', images: ['/menu-video-p.mp4'] }],
      };
      if (command === 'generation_history' && ['menu-video-global', 'video-0'].includes(args.assetId)) return { turns: [], references: [] };
      if (command === 'catalog_graph_page') {
        window.transcriptCalls.push({ command, args });
        const prefix = args.filter.projectId || 'global';
        return { assets: [`${prefix}-saved`, `${prefix}-unavailable`, `${prefix}-noaudio`, `${prefix}-pending`, `${prefix}-long`, `${prefix}-silent`, `${prefix}-held`, `${prefix}-remaining`].map(id => ({ id })), after: null };
      }
      if (command === 'video_transcript_capabilities') {
        window.transcriptCalls.push({ command, args });
        return window.transcriptCapabilities;
      }
      if (command === 'video_analysis_capabilities') return { available: true };
      if (command === 'video_analysis_progress') return null;
      if (command === 'video_text_tags_status') return { available: false, hasTranscript: true, hasDescription: false, credits: null };
      if (command === 'video_analysis_quote') {
        window.visualCalls.push({ command, args });
        if (args.assetId.endsWith('unavailable')) throw new Error('无法确认视频时长');
        const durationSeconds = args.assetId.endsWith('long') ? 7205 : 2;
        return { sourceHash: `visual-${args.assetId}`, durationSeconds, durationMs: durationSeconds * 1000,
          credits: 3, pricingVersion: 2, segmentCount: durationSeconds > 7200 ? 2 : 1,
          chargeRequired: !args.assetId.endsWith('saved'), cloudPending: args.assetId.endsWith('pending') };
      }
      if (command === 'video_analysis_start') {
        window.visualCalls.push({ command, args });
        return { status: 'interrupted', segmentCount: 2, completedSegments: 1, cloudPending: true };
      }
      if (command === 'video_transcript_get') {
        window.transcriptCalls.push({ command, args });
        if (args.assetId === 'menu-video-p') return record('interrupted', { quoteRequired: true });
        if (args.assetId === 'video-0' && window.savedFolderTranscript) return record('completed', { text: '文件夹视频现有文稿' });
        return args.assetId.endsWith('saved') ? record('completed') : null;
      }
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
  }, available);
}

async function openBatch(name = '批量转录视频') {
  const entry = page.getByRole('button', { name, exact: true });
  if (!await entry.isVisible()) {
    const more = page.getByRole('button', { name: '更多素材库控件', exact: true });
    if (await more.isVisible()) await more.click();
  }
  await entry.click();
  const modal = page.getByRole('dialog', { name, exact: true });
  await modal.waitFor();
  return modal;
}

const preview = () => page.getByRole('dialog', { name: '视频与生成记录预览', exact: true });
const workspace = () => page.getByRole('dialog', { name: '视频分析工作区', exact: true });
const transcript = () => workspace().getByRole('region', { name: '转录文稿', exact: true });

async function checkTranscriptMenu(card, assetId, label) {
  const before = await page.evaluate(() => window.transcriptCalls.length);
  await card.click({ button: 'right' });
  assert.equal(await page.getByRole('menuitem', { name: '打开视频详情', exact: true }).count(), 0);
  await page.getByRole('menuitem', { name: '转录文稿', exact: true }).click();
  await transcript().getByText(label, { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(start => window.transcriptCalls.slice(start)
    .filter(call => call.command === 'video_transcript_get')
    .map(call => call.args.assetId), before), [assetId]);
  assert.equal(await page.evaluate(start => window.transcriptCalls.slice(start)
    .some(call => ['video_transcript_quote', 'video_transcript_start'].includes(call.command)), before), false);
  await page.keyboard.press('Escape');
  await workspace().waitFor({ state: 'hidden' });
}

async function openSharedPreview(action, path) {
  const before = await page.evaluate(() => window.videoMediaReads.length);
  await action();
  await preview().getByRole('region', { name: '视频详情', exact: true }).waitFor();
  await preview().getByRole('region', { name: '视频播放器', exact: true }).waitFor();
  assert.equal(await preview().count(), 1);
  assert.equal(await page.evaluate(() => window.store.getState().detailAssetId), null);
  assert.deepEqual(await page.evaluate(start => window.videoMediaReads.slice(start), before), [path]);
}

try {
  await page.goto(`${base}scripts/fixtures/catalog-paging/preview.html?navigation&home`);
  await page.waitForFunction(() => window.store && window.__TAURI_INTERNALS__?.invoke);
  const navigation = page.getByRole('complementary', { name: '素材库导航', exact: true });
  await navigation.getByRole('button', { name: '全部素材', exact: true }).click();
  await installMock();
  await page.waitForFunction(() => window.transcriptCalls.some(call => call.command === 'video_transcript_capabilities'));
  const entry = page.getByRole('button', { name: '批量转录视频', exact: true });
  assert.equal(await entry.count(), 0);
  assert.deepEqual(await page.evaluate(() => window.transcriptCalls.map(call => call.command)), ['video_transcript_capabilities']);
  const globalVideo = page.locator('[data-asset-id="menu-video-global"]');
  await globalVideo.click();
  await preview().waitFor();
  assert.equal(await workspace().count(), 0);
  await preview().getByRole('button', { name: '打开转录文稿', exact: true }).click();
  await transcript().getByText('视频转录服务暂不可用。', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await workspace().waitFor({ state: 'hidden' });
  await preview().waitFor();
  await page.keyboard.press('Escape');
  await preview().waitFor({ state: 'hidden' });
  await checkTranscriptMenu(globalVideo, 'menu-video-global', '视频转录服务暂不可用。');
  await page.evaluate(() => { window.transcriptCapabilities = { available: false, credits: null, reason: 'pilot_exhausted', maxDurationMs: 7200000 }; });
  await openSharedPreview(() => globalVideo.dblclick(), '/menu-video-global.mp4');
  const detail = preview().getByRole('region', { name: '视频详情', exact: true });
  const analysisEntry = detail.getByRole('region', { name: '视频分析', exact: true });
  await analysisEntry.getByRole('button', { name: '分析', exact: true }).click();
  await workspace().getByRole('button', { name: '复刻', exact: true }).waitFor();
  assert.equal(await workspace().getByRole('searchbox', { name: '搜索文稿', exact: true }).count(), 0);
  await page.keyboard.press('Escape');
  await workspace().waitFor({ state: 'hidden' });
  await analysisEntry.getByRole('button', { name: '转录文稿', exact: true }).click();
  await transcript().getByText('本次试转录名额已使用。', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await workspace().waitFor({ state: 'hidden' });
  assert.equal(await detail.getByText('反推', { exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => window.transcriptCalls.some(call =>
    ['video_transcript_quote', 'video_transcript_start'].includes(call.command))), false);
  await page.keyboard.press('Escape');
  await preview().waitFor({ state: 'hidden' });
  await page.evaluate(() => {
    window.transcriptCapabilities = { available: true, credits: 5, maxDurationMs: 7200000 };
    window.mode.getState().setMedia('images');
  });
  await page.evaluate(() => window.mode.getState().setMedia('videos'));
  const more = page.getByRole('button', { name: '更多素材库控件', exact: true });
  if (await more.isVisible()) await more.click();
  await entry.waitFor();
  await page.evaluate(() => { window.transcriptCapabilities = { available: false, credits: null, maxDurationMs: 7200000 }; });
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
  const visual = await openBatch('批量画面分析');
  await visual.getByText(/总时长 02:00:13 · 共 6 段/).waitFor();
  await visual.getByText(/预估上限 15 Bcoin/).waitFor();
  await visual.getByText(/已有当前版本的画面描述/).waitFor();
  await visual.getByRole('button', { name: '开始分析', exact: true }).click();
  await visual.getByText(/剩余视频未提交/).waitFor();
  assert.equal(await page.evaluate(() => window.visualCalls.filter(call => call.command === 'video_analysis_start').length), 1);
  await visual.getByRole('button', { name: '关闭', exact: true }).click();
  await navigation.getByRole('button', { name: '项目A', exact: true }).click();
  const projectVisual = await openBatch('批量画面分析');
  await projectVisual.getByRole('button', { name: '选择新的范围', exact: true }).click();
  await projectVisual.getByText('项目内视频 · 项目A', { exact: true }).waitFor();
  await page.waitForFunction(() => window.visualCalls.some(call => call.args.assetId.startsWith('p-')));
  await projectVisual.getByRole('button', { name: '关闭', exact: true }).click();
  await openBatch();
  await dialog().getByRole('button', { name: '选择新的范围', exact: true }).click();
  await dialog().getByText('项目内视频 · 项目A', { exact: true }).waitFor();
  await page.waitForFunction(() => window.transcriptCalls.some(call => call.command === 'catalog_graph_page' && call.args.filter.projectId === 'p'));
  await dialog().getByRole('button', { name: '关闭', exact: true }).click();
  const projectVideo = page.locator('[data-asset-id="menu-video-p"]');
  await checkTranscriptMenu(projectVideo, 'menu-video-p', '转录 · 5 Bcoin');
  await openSharedPreview(() => projectVideo.press('Enter'), '/menu-video-p.mp4');
  await preview().getByRole('region', { name: '生成记录', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await preview().waitFor({ state: 'hidden' });
  await navigation.getByRole('button', { name: '标签模式', exact: true }).click();
  await navigation.getByRole('button', { name: '管理标签', exact: true }).click();
  const tags = page.getByRole('dialog', { name: '管理分类数据', exact: true });
  await tags.getByRole('combobox', { name: '选择视频素材', exact: true }).selectOption('menu-video-global');
  await tags.getByRole('region', { name: '视频文本打标签', exact: true }).getByText('服务暂未开放。', { exact: true }).waitFor();
  await tags.getByRole('button', { name: '关闭', exact: true }).click();

  await page.goto(`${base}scripts/fixtures/connected-collections/preview.html`);
  await page.waitForFunction(() => window.store && window.__TAURI_INTERNALS__?.invoke);
  await installMock(true);
  await page.locator('[data-collection-id="second"]').click();
  const folderVisual = await openBatch('批量画面分析');
  await folderVisual.getByRole('checkbox', { name: '包含子文件夹' }).check();
  await folderVisual.getByText(/本次可处理 1 个视频/).waitFor();
  await folderVisual.getByRole('button', { name: '关闭', exact: true }).click();
  await openBatch();
  await dialog().getByText('本次可处理 1 个视频，跳过 0 个。', { exact: true }).waitFor();
  assert.equal(await dialog().getByRole('checkbox', { name: '包含子文件夹' }).isChecked(), false);
  assert.ok(await page.evaluate(() => window.requests.some(call => call.command === 'connection_entry_ids' && call.args.folderId === 'second' && call.args.media === 'videos')));
  await dialog().getByRole('button', { name: '关闭', exact: true }).click();
  await page.evaluate(() => {
    window.savedFolderTranscript = true;
    window.transcriptCapabilities = { available: false, credits: null, maxDurationMs: 7200000 };
  });
  const connectedVideo = page.locator('[data-connection-entry="video-0"] .folder-media-card');
  await checkTranscriptMenu(connectedVideo, 'video-0', '文件夹视频现有文稿');
  await openSharedPreview(() => connectedVideo.press('Enter'), '/fixture/video-0.mp4');
  await page.keyboard.press('Escape');
  await preview().waitFor({ state: 'hidden' });
  console.log('PASS: video menus open exact transcripts and browse double-click/Enter use one shared preview across global, project and connected views');
  console.log('PASS: batch actions hidden when unpriced, no original scan, scope and full-track quote, no further submissions on unknown state or a changed price');
  console.log('PASS: batch visual analysis totals, existing-result skip, uncertain stop, project/folder scope and classification target');
} finally {
  await browser.close();
  await server.close();
}
