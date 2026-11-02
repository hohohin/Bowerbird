import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ cacheDir: '.tmp/video-auto-mode/vite', server: { host: '127.0.0.1', port: 17896, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(10000);
try {
  await page.goto('http://127.0.0.1:17896/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await page.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.requests = [];
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'dreamina_video_models') return [{ model_version: 'seedance2.5', resolutions: ['480p', '720p', '1080p'], min_duration: 4, max_duration: 30 }];
      if (command === 'dreamina_credit_balance') return 500;
      return invoke(command, args);
    };
    window.store.setState({ activeGenProvider: 'jimeng', dreaminaHealth: { ok: true }, cloudAuth: { logged_in: true, cloud_available: true }, cloudEntitlement: { policy: { can_use_byo: true, max_parallel_jobs: 4 }, balances: { daily: 1000, sub: 0, topup: 0 } },
      startGeneration: async (...args) => { window.requests.push(args); return { accepted: true, jobId: 'synthetic' }; } });
  });
  const dock = page.locator('.creation-dock');
  await dock.getByRole('button', { name: '展开创作描述', exact: true }).click();
  await dock.getByRole('button', { name: '视频', exact: true }).click();
  const mode = dock.getByRole('combobox', { name: '视频生成模式', exact: true });
  assert.equal(await mode.innerText(), '自动识别');
  async function load(paths, expandComposer = true) {
    const expand = dock.getByRole('button', { name: '展开创作描述', exact: true });
    if (expandComposer && await expand.count()) await expand.click();
    await page.evaluate(paths => {
      const refs = paths.map((path, i) => ({ id: 'auto-'+path, name: path.split('/').pop(), ext: path.split('.').pop(), store_path: path, duration: path.endsWith('.mp4') ? 5 : null }));
      window.dispatchEvent(new CustomEvent('bowerbird://board-load-prompt', { detail: { prompt: refs.map(a => '@'+a.name).join(' ')+' 镜头缓慢推进', refs } }));
    }, paths);
    await page.waitForTimeout(150);
  }
  for (const [paths, kind] of [[[], 'text2video'], [['/mock/a.png'], 'image2video'], [['/mock/a.png','/mock/b.jpg'], 'multimodal2video'], [['/mock/v.mp4'], 'multimodal2video'], [[], 'text2video']]) {
    await load(paths);
    assert.equal(await dock.getByRole('combobox', { name: '视频比例', exact: true }).count(), kind === 'image2video' ? 0 : 1);
    const nextCount = await page.evaluate(() => window.requests.length + 1);
    await dock.locator('.generation-send-button').click();
    await page.waitForFunction(count => window.requests.length === count, nextCount);
    assert.equal(await page.evaluate(() => window.requests.at(-1)?.at(-1)?.videoOptions.kind), kind);
  }
  await load([]);
  await mode.click();
  assert.equal(await page.getByRole('option').count(), 2);
  await page.getByRole('option', { name: '首尾帧', exact: true }).click();
  await load(['/mock/a.png','/mock/b.jpg']);
  const framesCount = await page.evaluate(() => window.requests.length + 1);
  await dock.locator('.generation-send-button').click();
  await page.waitForFunction(count => window.requests.length === count, framesCount);
  assert.equal(await page.evaluate(() => window.requests.at(-1).at(-1).videoOptions.kind), 'frames2video');
  await load(['/mock/a.png']);
  assert.equal(await mode.innerText(), '首尾帧');
  const count = await page.evaluate(() => window.requests.length);
  await dock.locator('.generation-send-button').click();
  assert.equal(await page.evaluate(() => window.requests.length), count, 'invalid explicit frames never silently becomes single-image');
  await mode.click(); await page.getByRole('option', { name: '自动识别', exact: true }).click();
  const autoCount = await page.evaluate(() => window.requests.length + 1);
  await dock.locator('.generation-send-button').click();
  await page.waitForFunction(count => window.requests.length === count, autoCount);
  assert.equal(await page.evaluate(() => window.requests.at(-1).at(-1).videoOptions.kind), 'image2video');
  await load(['/mock/a.mp3']);
  assert.match(await mode.getAttribute('title'), /多参考/);
  const beforeAudio = await page.evaluate(() => window.requests.length);
  assert.equal(await dock.locator('[data-media-kind="audio"]').count(), 1);
  await dock.locator('.generation-send-button').click();
  await page.waitForFunction(count => window.requests.length === count + 1, beforeAudio);
  assert.deepEqual(await page.evaluate(() => window.requests.at(-1)[1].map(a => a.store_path)), ['/mock/a.mp3']);
  await load(['/mock/a.flac']);
  await dock.locator('.generation-send-button').click();
  assert.equal(await page.evaluate(() => window.requests.length), beforeAudio + 1, 'unsupported format is not discarded or submitted');
  await mkdir('.tmp/video-auto-mode', { recursive: true });
  await load(['/mock/a.png', '/mock/b.jpg']);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.setViewportSize({ width: 900, height: 900 });
    const centers = await dock.locator('.composer-toolbar').evaluate(toolbar => [...toolbar.querySelectorAll('.composer-video-fields > *, .composer-add-material, .composer-help, .composer-send')]
      .map(element => element.getBoundingClientRect()).filter(rect => rect.width && rect.height).map(rect => rect.y + rect.height / 2));
    assert.ok(centers.every(center => Math.abs(center - centers[0]) < 1), 'video footer remains one row');
    await dock.screenshot({ path: `.tmp/video-auto-mode/${theme}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => {
    const options = { kind: 'text2video', model_version: 'seedance2.5', duration: 5, video_resolution: '720p' };
    const job = { id: 'video-edit', projectId: 'p', threadId: 't', provider: 'jimeng', sessionId: 'synthetic', media: 'video', videoOptions: options,
      running: false, streaming: '', refAssets: [], lastRefs: [], lastRatio: '16:9', lastPrompt: '原视频',
      turns: [{ id: 1, prompt: '原视频', images: [], media: 'video', videoOptions: options, provider: 'jimeng' }] };
    window.revisions = [];
    window.store.setState({ genJobs: { [job.id]: job }, genJobOrder: [job.id], activeJobId: job.id, activeSessionKind: 'generation', genPanelOpen: true, boardOpen: false, genEditing: null,
      sendGenRevise: async (...args) => { window.revisions.push(args); } });
  });
  const inspector = page.locator('[data-project-inspector="generation"]');
  const edit = inspector.locator('[data-generation-composer="inline"]');
  for (const [paths, kind] of [[['/mock/a.png'], 'image2video'], [['/mock/a.png','/mock/b.jpg'], 'multimodal2video'], [[], 'text2video']]) {
    await inspector.getByRole('button', { name: /^继续创作视频/ }).click();
    await edit.waitFor();
    await load(paths, false);
    const nextCount = await page.evaluate(() => window.revisions.length + 1);
    await edit.getByRole('button', { name: '发送', exact: true }).click();
    await page.waitForFunction(count => window.revisions.length === count, nextCount);
    assert.equal(await page.evaluate(() => window.revisions.at(-1)[3].generation.videoOptions.kind), kind);
  }
  await page.goto('http://127.0.0.1:17896/scripts/fixtures/audio-library/preview.html?reference');
  await page.waitForFunction(() => !!window.mountLibrary);
  for (const connected of [false, true]) {
    await page.evaluate(connected => window.mountLibrary(connected), connected);
    const library = page.locator(connected ? '.connected-collections' : '.categorized-library:not(.connected-collections)');
    const name = library.locator('.audio-file-card[data-asset-id="wav"]').first();
    if (connected) { await name.focus(); await name.press('Enter'); }
    else await name.locator('.audio-file-meta').dblclick();
    await page.waitForFunction(count => window.picks.length === count, connected ? 2 : 1);
    assert.equal(await page.evaluate(() => window.picks.at(-1)), 'wav');
    assert.equal(await page.evaluate(() => window.store.getState().detailAssetId), null);
  }
  console.log('PASS composer/detail modes, audio chips, library audio selection, unsupported format guard, one footer row');
} catch (error) {
  console.error(await page.evaluate(() => ({ text: document.body.innerText.slice(-1200), calls: window.calls?.slice(-5), unexpected: window.unexpected })));
  throw error;
} finally { await browser.close(); await server.close(); }
