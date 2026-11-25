import assert from 'node:assert/strict';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = resolve(desktop, '../../.tmp/audio-preview-fixtures');
const output = resolve(desktop, '.tmp/audio-library');
await mkdir(output, { recursive: true });
const mediaRequests = [];
const serveMedia = async (req, res, next) => {
  try {
    const file = decodeURIComponent(new URL(req.url, 'http://local').pathname).slice(1);
    if (basename(file) !== file || !/^(chime\.wav|long-vbr\.mp3|rain\.flac|space\.m4a)(\.peaks\.json)?$/.test(file)) { res.statusCode = 404; res.end(); return; }
    const peaks = { 'chime.wav.peaks.json': 'chime.peaks.json', 'long-vbr.mp3.peaks.json': 'long-mp3.peaks.json', 'rain.flac.peaks.json': 'rain.peaks.json', 'space.m4a.peaks.json': 'space.peaks.json' };
    const path = resolve(fixtures, peaks[file] ?? file), info = await stat(path);
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : file.endsWith('.wav') ? 'audio/wav' : file.endsWith('.mp3') ? 'audio/mpeg' : file.endsWith('.flac') ? 'audio/flac' : 'audio/mp4');
    res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Content-Length', end - start + 1);
    if (range) { res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`); }
    if (!file.endsWith('.json')) mediaRequests.push({ file, range: req.headers.range ?? null });
    const stream = createReadStream(path, { start, end }); res.on('close', () => stream.destroy()); stream.pipe(res);
  } catch (error) { next(error); }
};
const server = await createServer({ root: desktop, configFile: resolve(desktop, 'vite.config.ts'), cacheDir: resolve(output, 'vite'),
  plugins: [{ name: 'synthetic-audio', configureServer(vite) { vite.middlewares.use('/audio-fixtures', serveMedia); } }],
  server: { host: '127.0.0.1', port: 17992, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const errors = [], result = { guards: null, ui: null };
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
  window.audioEvents = []; window.waveClicks = [];
  for (const type of ['loadstart', 'loadedmetadata', 'seeking', 'seeked', 'playing', 'pause', 'emptied']) document.addEventListener(type, event => {
    if (!(event.target instanceof HTMLAudioElement)) return;
    if (type === 'playing') event.target.volume = .03;
    window.audioEvents.push({ type, at: performance.now(), time: event.target.currentTime, src: event.target.currentSrc });
  }, true);
  document.addEventListener('click', event => {
    const wave = event.target instanceof Element && event.target.closest('.audio-waveform-wave');
    if (!wave) return;
    const rect = wave.getBoundingClientRect();
    window.waveClicks.push({ at: performance.now(), x: event.clientX, left: rect.left, width: rect.width });
  }, true);
});
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
const url = 'http://127.0.0.1:17992/scripts/fixtures/audio-library/preview.html';
const wave = id => page.locator(`div[data-audio-preview][data-asset-id="${id}"]`).first();
const playerState = () => page.evaluate(() => { const audio = document.querySelector('audio[data-audio-preview]'); return audio && { src: audio.getAttribute('src'), currentSrc: audio.currentSrc, time: audio.currentTime, paused: audio.paused, seeking: audio.seeking, duration: audio.duration }; });
async function progressBeyond(time) { await page.waitForFunction(time => { const audio = document.querySelector('audio[data-audio-preview]'); return audio && !audio.paused && !audio.seeking && audio.currentTime >= time; }, time, { timeout: 12000 }); }
async function stopped() { await page.waitForFunction(() => { const audio = document.querySelector('audio[data-audio-preview]'); return !audio || audio.paused && !audio.getAttribute('src'); }); }
async function openAudioCatalog() {
  await page.goto(url);
  await page.locator('.library-home').waitFor();
  await page.getByRole('button', { name: '全部素材', exact: true }).click();
  await page.getByRole('group', { name: '素材类型' }).hover();
  const audio = page.getByRole('button', { name: '音频', exact: true });
  await audio.waitFor();
  assert.equal(await audio.count(), 1, 'formal library must expose audio alongside image and video');
  await audio.click();
  await wave('wav').waitFor();
  await page.waitForFunction(() => document.querySelector('div[data-audio-preview][data-asset-id="wav"]')?.dataset.waveReady === 'true');
}
async function playback(id) {
  const root = wave(id), waveform = root.locator('.audio-waveform-wave'), play = root.locator('.audio-waveform-play');
  await root.scrollIntoViewIfNeeded(); await page.waitForFunction(id => document.querySelector(`div[data-audio-preview][data-asset-id="${id}"]`)?.dataset.waveReady === 'true', id);
  const start = await page.evaluate(() => window.audioEvents.length);
  await play.click(); await progressBeyond(.2);
  const fromZero = await playerState(); assert.ok(fromZero.time < 2, `${id} button starts at zero`);
  await page.mouse.move(5, 5); await progressBeyond(fromZero.time + .2);
  const persistent = await playerState();
  const other = wave(id === 'wav' ? 'mp3' : 'wav');
  await other.locator('.audio-waveform-wave').hover(); await progressBeyond(persistent.time + .2);
  assert.equal((await playerState()).currentSrc, persistent.currentSrc, 'hovering another card preserves continuous playback');
  const loads = await page.evaluate(() => window.audioEvents.filter(event => event.type === 'loadstart').length);
  const bounds = await waveform.boundingBox();
  await waveform.click({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
  const click = await page.evaluate(() => window.waveClicks.at(-1));
  const target = Math.max(0, Math.min(1, (click.x - click.left) / click.width)) * fromZero.duration;
  assert.ok(Math.abs((click.x - click.left) - click.width / 2) <= 1, 'actual click remains within one CSS pixel of requested midpoint');
  await progressBeyond(target + .2);
  const middle = await playerState(); assert.ok(middle.time < target + 2, `${id} advances from actual midpoint`);
  assert.equal(await page.evaluate(() => window.audioEvents.filter(event => event.type === 'loadstart').length), loads, 'same source click seeks without reloading');
  await page.mouse.move(5, 5); await stopped();
  await play.click(); await progressBeyond(.2); const restart = await playerState(); assert.ok(restart.time < 2);
  await page.mouse.move(5, 5); await progressBeyond(restart.time + .2);
  await play.click(); await stopped();
  assert.equal(await page.locator('audio[data-audio-preview]').count(), 1);
  const events = await page.evaluate(start => window.audioEvents.slice(start), start);
  const playing = events.find(event => event.type === 'playing' && event.at >= click.at);
  return { id, target, observed: middle.time, continuousAfterLeave: persistent.time, sameSourceLoadstarts: 0, clickToPlayingMs: playing ? playing.at - click.at : null, events };
}
async function mutations() {
  const play = wave('wav').locator('.audio-waveform-play');
  await play.click(); await progressBeyond(.2);
  await page.evaluate(() => window.externalFiles.rename('wav', window.assets[0].store_path, 'renamed'));
  let mutation = await page.evaluate(() => window.mutations.at(-1));
  assert.equal(mutation.paused, true, 'original rename must stop playback before IPC'); assert.equal(mutation.src, null);
  await play.click(); await progressBeyond(.2);
  await page.evaluate(() => window.externalFiles.delete('wav', window.assets[0].store_path));
  mutation = await page.evaluate(() => window.mutations.at(-1)); assert.equal(mutation.paused, true); assert.equal(mutation.src, null);
  await play.click(); await progressBeyond(.2);
  await page.evaluate(() => window.openMutationDialog('rename'));
  await page.getByRole('textbox', { name: '素材名称', exact: true }).fill('新的声音');
  await page.getByRole('button', { name: '保存名称', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  mutation = await page.evaluate(() => window.mutations.at(-1)); assert.equal(mutation.command, 'rename_asset'); assert.equal(mutation.paused, true); assert.equal(mutation.src, null);
  await play.click(); await progressBeyond(.2);
  await page.evaluate(() => window.openMutationDialog('delete'));
  await page.getByRole('button', { name: '删除原文件', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  mutation = await page.evaluate(() => window.mutations.at(-1)); assert.equal(mutation.command, 'trash_asset_original'); assert.equal(mutation.paused, true); assert.equal(mutation.src, null);
  const firstMutations = await page.evaluate(() => window.mutations);
  // Restart the fixture because successful deletion hides the original card in this window.
  await openAudioCatalog();
  await play.click(); await progressBeyond(.2);
  await page.evaluate(() => window.openMutationDialog('delete-reference'));
  await page.getByRole('button', { name: '删除原文件', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  mutation = await page.evaluate(() => window.mutations.at(-1)); assert.equal(mutation.command, 'trash_asset_original');
  assert.equal(mutation.paused, true, 'explicitly recycling an external original also stops its player'); assert.equal(mutation.src, null);
  await stopped();
  return [...firstMutations, ...await page.evaluate(() => window.mutations)];
}
async function selection() {
  const card = page.locator('.audio-file-card[data-asset-id="wav"]');
  await wave('wav').locator('.audio-waveform-play').click(); await progressBeyond(.2);
  const before = await playerState();
  const plays = await page.evaluate(() => window.audioEvents.filter(event => event.type === 'playing').length);
  await card.locator('.audio-file-meta').click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  await page.waitForTimeout(120);
  assert.deepEqual(errors, [], 'audio selection must render the real selection mark without a missing preview element');
  assert.equal(await card.evaluate(element => element.classList.contains('is-selected')), true);
  await progressBeyond(before.time + .2);
  assert.equal((await playerState()).currentSrc, before.currentSrc);
  assert.equal(await page.evaluate(() => window.audioEvents.filter(event => event.type === 'playing').length), plays, 'selecting never restarts playback');
  assert.equal(await wave('wav').locator('.audio-waveform-play').isEnabled(), true, 'selected active audio must remain pausable');
  await wave('wav').locator('.audio-waveform-play').click(); await stopped();
  await card.locator('.audio-file-meta').click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  assert.equal(await card.evaluate(element => element.classList.contains('is-selected')), false);
  assert.equal(await page.evaluate(() => window.audioEvents.filter(event => event.type === 'playing').length), plays, 'selection changes never restart playback');
  await page.getByRole('button', { name: '取消选择', exact: true }).click();
  await wave('wav').locator('.audio-waveform-play').click(); await progressBeyond(.2);
  await wave('wav').locator('.audio-waveform-play').click(); await stopped();
  return { selectionAndDeselect: true, preservedPlayback: true, selectedPause: true, extraPlayEvents: 0 };
}
async function audioDetails() {
  const card = page.locator('.audio-file-card[data-asset-id="wav"]');
  const detail = page.getByRole('dialog', { name: '音频详情', exact: true });
  const workspace = page.getByRole('dialog', { name: '音频分析工作区', exact: true });
  await page.evaluate(() => window.store.setState({ cloudAuth: { logged_in: true, user_id: 'audio-test', cloud_available: true } }));
  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      const surface = document.querySelector('.creation-image-preview[aria-label="音频详情"]');
      if (!surface) return;
      observer.disconnect();
      const focus = document.activeElement;
      const opening = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
      window.audioOpeningFocus = {
        ready: !!surface.querySelector('.audio-detail-player'),
        label: focus.getAttribute('aria-label'),
        spacePrevented: !focus.dispatchEvent(opening),
      };
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  await card.locator('.audio-file-meta').click();
  await detail.getByText('转录 · 1 Bcoin', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.audioOpeningFocus),
    { ready: false, label: '关闭预览', spacePrevented: true }, 'Space cannot activate the temporary close-button focus');
  const player = detail.getByRole('region', { name: '音频播放器' });
  assert.ok(await player.evaluate(element => document.activeElement === element), 'opening audio details focuses the mounted player');
  await player.locator('button[aria-label="播放"]:enabled').waitFor();
  await page.keyboard.press('Space');
  await progressBeyond(.2);
  await page.keyboard.press('Space');
  await stopped();
  await detail.getByRole('button', { name: '关闭预览' }).click();
  await detail.waitFor({ state: 'hidden' });
  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      const shortcut = document.querySelector('.creation-image-preview [aria-label="打开转录文稿"]');
      if (!shortcut) return;
      observer.disconnect();
      shortcut.focus();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  await card.locator('.audio-file-meta').click();
  await detail.getByText('转录 · 1 Bcoin', { exact: true }).waitFor();
  assert.ok(await detail.getByRole('button', { name: '打开转录文稿' }).evaluate(element => document.activeElement === element),
    'player mount preserves focus already moved to another control');
  assert.equal(await detail.getByRole('button', { name: '放大图片' }).count(), 0);
  assert.equal(await card.evaluate(element => element.classList.contains('is-selected')), false);
  await detail.getByRole('button', { name: '分析', exact: true }).click();
  await workspace.getByRole('button', { name: '转录 · 1 Bcoin', exact: true }).click();
  await workspace.getByRole('button', { name: '查看转录文稿' }).click();
  await workspace.getByRole('searchbox', { name: '搜索文稿' }).fill('文稿');
  const seek = workspace.getByRole('button', { name: /跳转至 .* · 文稿/ });
  await seek.click();
  await progressBeyond(3.4);
  assert.ok((await playerState()).time < 4.4, 'word click starts playback at the matching timestamp');
  await workspace.getByRole('button', { name: '关闭音频分析' }).click();
  await workspace.waitFor({ state: 'hidden' });
  await card.locator('.audio-file-meta').click({ button: 'right' });
  await page.getByRole('menu').getByText('转录文稿', { exact: true }).click();
  await workspace.getByRole('button', { name: /跳转至 .* · 文稿/ }).waitFor();
  assert.ok(await workspace.getByRole('heading', { name: '音频分析' }).evaluate(element => document.activeElement === element),
    'opening transcript directly keeps focus in the analysis workspace');
  await workspace.getByRole('button', { name: '关闭音频分析' }).click();
  await workspace.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === 'video_analysis_get').length), 0);
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === 'video_transcript_start').length), 1);
  await page.keyboard.press('Escape');
  await stopped();
}
async function audioTrim() {
  await page.goto(`${url}?reference&trim`);
  await page.evaluate(() => { window.transcripts = { wav: { status: 'completed', text: '区间之外',
    utterances: [{ startMs: 6000, endMs: 6700, text: '区间之外', words: [{ startMs: 6000, endMs: 6700, text: '区间之外' }] }] } }; });
  await page.locator('.audio-file-card[data-asset-id="wav"] .audio-file-meta').click();
  const detail = page.getByRole('dialog', { name: '音频详情', exact: true });
  const player = detail.getByRole('region', { name: '音频播放器' });
  const trim = player.getByRole('button', { name: '裁剪音频' });
  const start = player.getByRole('spinbutton', { name: '入点秒数' });
  const end = player.getByRole('spinbutton', { name: '出点秒数' });
  const progress = player.getByRole('slider', { name: '音频进度' });
  await trim.click();
  const duration = Number(await progress.getAttribute('aria-valuemax'));
  await start.fill('2.5');
  await end.fill('4.0');
  await end.press('Space');
  await progressBeyond(2.5);
  assert.ok((await playerState()).time < 3.2, 'Space starts from the in point after editing a timecode');
  await player.getByRole('button', { name: '暂停', exact: true }).click();
  assert.equal(await player.getByRole('button', { name: '试听选区' }).count(), 0);
  const bounds = await progress.boundingBox();
  const moveCursor = seconds => page.mouse.move(bounds.x + bounds.width * seconds / duration, bounds.y + bounds.height / 2);
  const scrubTime = async () => Number(await progress.getAttribute('aria-valuenow'));
  await moveCursor(3.2);
  await page.mouse.down();
  await moveCursor(1);
  assert.equal(await scrubTime(), 2.5);
  await moveCursor(1.15);
  assert.ok(await scrubTime() > 2.5, 'the first inward move releases the in point even over the mask');
  await moveCursor(6);
  assert.equal(await scrubTime(), 4);
  await moveCursor(5.85);
  assert.ok(await scrubTime() < 4, 'the first inward move releases the out point even over the mask');
  await page.mouse.up();
  await progress.press('End');
  assert.equal(Number(await progress.getAttribute('aria-valuenow')), 4, 'keyboard seeking stops at the selected out point');
  await progress.press('Space');
  await progressBeyond(2.5);
  assert.ok((await playerState()).time < 3.2, 'Space restarts from the in point after seeking to the end');
  await player.getByRole('button', { name: '播放', exact: true }).waitFor();
  assert.ok((await playerState()).paused, 'playback pauses at the selected out point');
  await detail.getByRole('button', { name: '打开转录文稿' }).click();
  const workspace = page.getByRole('dialog', { name: '音频分析工作区', exact: true });
  await workspace.getByRole('button', { name: /跳转至 .* · 区间之外/ }).click();
  await workspace.getByRole('button', { name: '返回音频预览' }).click();
  assert.equal(Number(await progress.getAttribute('aria-valuenow')), 4);
  assert.equal(await trim.getAttribute('aria-pressed'), 'true');
  assert.ok((await playerState()).paused, 'word seek outside the range cannot reopen full playback');
  await page.screenshot({ path: resolve(output, 'audio-trim-detail-dark.png'), animations: 'disabled' });
  const save = player.getByRole('button', { name: '另存为新音频' });
  await save.click();
  await page.waitForFunction(() => window.mutations.some(mutation => mutation.command === 'trim_audio' && !mutation.args.overwrite));
  assert.deepEqual(await page.evaluate(() => window.mutations.at(-1).args),
    { sourcePath: '/audio-fixtures/chime.wav', start: 2.5, end: 4, overwrite: false, projectId: 'trim-project' });
  await progress.press('Space');
  await progressBeyond(2.5);
  await player.getByRole('button', { name: '覆盖原音频' }).click();
  await page.getByRole('button', { name: '确认覆盖' }).click();
  await page.waitForFunction(() => window.mutations.some(mutation => mutation.command === 'trim_audio' && mutation.args.overwrite));
  const overwritten = await page.evaluate(() => window.mutations.at(-1));
  assert.equal(overwritten.paused, true);
  assert.equal(overwritten.src, null, 'overwrite releases the original before IPC');
  await player.getByText('已覆盖原音频', { exact: true }).waitFor();
  assert.equal(Number(await progress.getAttribute('aria-valuemax')), 1.5);
  await player.getByRole('button', { name: '播放', exact: true }).click();
  await progressBeyond(.2);
  assert.match((await playerState()).currentSrc, /audioVersion=b{64}$/);
  await player.getByRole('button', { name: '暂停', exact: true }).click();
  await detail.getByRole('button', { name: '打开转录文稿' }).click();
  await workspace.getByText('暂无转录文稿', { exact: true }).waitFor();
  await workspace.getByRole('button', { name: '返回音频预览' }).click();
  await detail.getByRole('button', { name: '关闭预览' }).click();
  await detail.waitFor({ state: 'hidden' });
  await page.locator('.audio-file-card[data-asset-id="mp3"] .audio-file-meta').click();
  await trim.click();
  await start.fill('0.3');
  await start.press('Tab');
  const overwrite = player.getByRole('button', { name: '覆盖原音频' });
  if (await overwrite.isEnabled()) await overwrite.click();
  await player.getByText(/外部.*另存为新音频/).waitFor();
  assert.equal(await page.evaluate(() => window.mutations.filter(mutation => mutation.command === 'trim_audio').length), 2);
}
try {
  if (!process.argv.includes('--ui-only')) {
    await page.goto(`${url}?guards`);
    await page.waitForFunction(() => typeof window.guardResults === 'function');
    result.guards = await page.evaluate(() => window.guardResults());
    await page.evaluate(() => { window.store.setState({ detailAssetId: 'wav' }); window.store.getState().openContextMenu(150, 150, 'wav', { asset: window.assets[0] }); });
    await page.getByRole('menu', { name: '素材操作', exact: true }).waitFor();
    const labels = await page.getByRole('menu').innerText();
    result.guards.menu = labels;
    assert.match(result.guards.add ?? '', /音频/, 'mixed selection must reject before creating a project');
    assert.match(result.guards.place ?? '', /音频/, 'shared canvas place must reject audio');
    assert.deepEqual(result.guards.created, []); assert.equal(result.guards.closed, 0);
    assert.deepEqual(result.guards.placed, ['image', 'video']);
    assert.doesNotMatch(labels, /反推|添加到对话框/);
  }
  if (!process.argv.includes('--guards-only')) {
    await openAudioCatalog();
    if (process.argv.includes('--selection-only')) result.ui = { selection: await selection() };
    else if (process.argv.includes('--mutations-only')) result.ui = { mutations: await mutations() };
    else {
    const beforeHover = mediaRequests.length;
    await wave('wav').locator('.audio-waveform-wave').hover({ position: { x: 30, y: 30 } });
    const beforeCursor = await wave('wav').locator('.audio-waveform-hover').getAttribute('style');
    await wave('wav').locator('.audio-waveform-wave').hover({ position: { x: 130, y: 30 } });
    assert.notEqual(await wave('wav').locator('.audio-waveform-hover').getAttribute('style'), beforeCursor);
    assert.equal(mediaRequests.length, beforeHover, 'hover never requests an original');
    assert.equal(await page.locator('audio').count(), 0, 'hover never creates a player');
    result.ui = { audioEntry: true, hoverMediaRequests: 0, playback: [await playback('wav'), await playback('mp3')] };
    result.ui.selection = await selection();
    await audioDetails();
    await wave('wav').locator('.audio-waveform-play').click(); await progressBeyond(.2);
    await wave('mp3').locator('.audio-waveform-play').click(); await progressBeyond(.2);
    assert.match((await playerState()).currentSrc, /long-vbr\.mp3/);
    assert.equal(await page.locator('div[data-audio-preview][data-playing="true"]').count(), 1);
    const beforeMediaSwitch = await playerState();
    await page.getByRole('group', { name: '素材类型' }).hover();
    await page.getByRole('button', { name: '图片', exact: true }).click(); await progressBeyond(beforeMediaSwitch.time + .2);
    assert.equal((await playerState()).currentSrc, beforeMediaSwitch.currentSrc, 'continuous playback persists media/view switches');
    await page.locator('.folder-media-card[data-asset-id="image"]').waitFor();
    assert.equal(await page.locator('div[data-audio-preview]').count(), 0);
    await page.getByRole('group', { name: '素材类型' }).hover();
    await page.getByRole('button', { name: '视频', exact: true }).click();
    await page.locator('.folder-media-card[data-asset-id="video"]').waitFor();
    assert.equal(await page.locator('div[data-audio-preview]').count(), 0);
    await page.getByRole('group', { name: '素材类型' }).hover();
    await page.getByRole('button', { name: '音频', exact: true }).click(); await wave('wav').waitFor();
    await wave('mp3').locator('.audio-waveform-play').click(); await stopped();
    result.ui.mutations = await mutations();
    await openAudioCatalog();
    await page.getByRole('button', { name: '标签模式', exact: true }).click();
    await page.locator('[data-tag-section="tag-music"]').waitFor();
    assert.equal(await page.locator('[data-tag-section="tag-music"] div[data-audio-preview][data-asset-id="mp3"]').count(), 1, 'manual audio tags retain grouped browsing');
    await page.getByRole('button', { name: '层级模式', exact: true }).click();
    const folderTree = page.getByRole('button', { name: '文件夹', exact: true });
    if (await folderTree.getAttribute('aria-expanded') !== 'true') await folderTree.click();
    const rootFolder = page.getByRole('treeitem', { name: '声音素材' });
    if (await rootFolder.getAttribute('aria-expanded') === 'false') await rootFolder.press('ArrowRight');
    await page.locator('[data-collection-id="child"]').waitFor();
    await page.locator('[data-collection-id="child"]').click(); await wave('mp3').waitFor();
    assert.deepEqual(await page.locator('[data-catalog-section]').evaluateAll(elements => elements.map(element => element.dataset.catalogSection)), ['child']);
    assert.ok((await page.evaluate(() => window.calls.filter(call => call.command === 'connection_entries'))).every(call => call.args.media === 'audios' && call.args.limit <= 60));
    await page.locator('[data-collection-id="next"]').click(); await wave('flac').waitFor();
    result.ui.boundedCards = await page.locator('.folder-media-card').count(); assert.ok(result.ui.boundedCards < 71);
    await page.locator('[data-collection-id="next"]').evaluate(element => {
      const file = new File([new Uint8Array([1, 2, 3])], 'chime.wav', { type: 'audio/wav' });
      Object.defineProperty(file, 'path', { value: '/audio-fixtures/chime.wav' });
      const dataTransfer = new DataTransfer(); dataTransfer.items.add(file);
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    });
    await page.waitForFunction(() => window.calls.some(call => call.command === 'create_material_references'));
    const connection = await page.evaluate(() => ({ imports: window.calls.filter(call => call.command === 'import_files'), refs: window.calls.filter(call => call.command === 'create_material_references'), copies: window.calls.filter(call => call.command === 'import_image_bytes') }));
    assert.deepEqual(connection.imports.at(-1).args.sources, ['/audio-fixtures/chime.wav']);
    assert.equal(connection.refs.at(-1).args.folderId, 'next'); assert.deepEqual(connection.copies, []);
    result.ui.drop = { originalPath: connection.imports.at(-1).args.sources[0], referenceFolder: 'next', byteImports: 0 };
    while (await page.getByRole('button', { name: '关闭通知', exact: true }).count()) await page.getByRole('button', { name: '关闭通知', exact: true }).first().click();
    await page.locator('[data-collection-id="root"]').click();
    await page.waitForFunction(() => document.querySelector('[data-connection-entry="entry-wav"] div[data-audio-preview]')?.dataset.waveReady === 'true');
    const connected = page.locator('[data-connection-entry="entry-wav"] .audio-file-meta');
    await connected.click();
    const connectedDetail = page.getByRole('dialog', { name: '音频详情', exact: true });
    await connectedDetail.getByRole('button', { name: '关闭预览' }).click();
    await connectedDetail.waitFor({ state: 'hidden' });
    await page.waitForTimeout(150);
    await page.screenshot({ path: resolve(output, 'collections-dark.png') });
    await page.evaluate(() => window.store.getState().openDetail('wav'));
    await page.locator('.asset-detail div[data-audio-preview]').waitFor();
    assert.equal(await page.locator('.asset-detail').getByRole('button', { name: /反推/ }).count(), 0);
    await page.getByRole('button', { name: '添加标签', exact: true }).click();
    await page.getByRole('textbox', { name: '搜索或新建标签', exact: true }).fill('音效');
    await page.getByRole('button', { name: '新建并添加“音效”', exact: true }).click();
    await page.getByRole('button', { name: '移除标签 音效', exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.calls.find(call => call.command === 'local_classification_example').args),
      { assetIds: ['wav'], tagId: 'tag-音效', positive: true });
    await page.keyboard.press('Escape');
    await page.screenshot({ path: resolve(output, 'detail-dark.png') });
    const calls = await page.evaluate(() => window.calls);
    assert.ok(calls.some(call => call.command === 'audio_waveform' && call.args.expectedVersion === 'a'.repeat(64)), 'connected entries verify their source fingerprint');
    assert.equal(calls.filter(call => ['external_files_preview', 'external_files_media'].includes(call.command) && /\.(wav|mp3|flac|m4a|ogg)/i.test(call.args.path)).length, 0);
    assert.equal(calls.filter(call => /describe|classif.*start|generate/.test(call.command)).length, 0);
    assert.ok(mediaRequests.every(request => request.range), 'real audio originals use Range');
    assert.deepEqual(await page.evaluate(() => window.unexpected), []);
    const stressRequests = mediaRequests.length;
    await page.goto(`${url}?stress`);
    await page.getByRole('group', { name: '素材类型' }).hover();
    await page.getByRole('button', { name: '音频', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('div[data-audio-preview][data-asset-id="wav"]')?.dataset.waveReady === 'true');
    await page.waitForFunction(() => [...document.querySelectorAll('div[data-audio-preview]')].filter(element => { const rect = element.getBoundingClientRect(); return rect.height > 0 && rect.top < innerHeight && rect.bottom > 0; }).every(element => element.dataset.waveReady === 'true'));
    result.ui.stress = await page.evaluate(() => ({ total: window.assets.length, mounted: document.querySelectorAll('.audio-file-card').length, waveformRequests: window.calls.filter(call => call.command === 'audio_waveform').length, catalogPages: window.calls.filter(call => call.command === 'catalog_page').map(call => call.args.limit) }));
    assert.ok(result.ui.stress.total > 1200); assert.ok(result.ui.stress.mounted <= 120); assert.ok(result.ui.stress.waveformRequests < 100);
    assert.ok(result.ui.stress.catalogPages.every(limit => limit <= 60));
    assert.equal(mediaRequests.length, stressRequests, 'browsing 1200 audio cards never pulls originals');
    await page.screenshot({ path: resolve(output, 'audio-all-dark.png') });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.screenshot({ path: resolve(output, 'audio-all-light.png') });
    await page.goto(`${url}?reference`);
    const projectMeta = page.locator('.audio-file-card[data-asset-id="wav"] .audio-file-meta');
    await projectMeta.click();
    await page.getByRole('dialog', { name: '音频详情', exact: true }).getByRole('button', { name: '关闭预览' }).click();
    await page.getByRole('dialog', { name: '音频详情', exact: true }).waitFor({ state: 'hidden' });
    await projectMeta.dblclick();
    await page.waitForFunction(() => window.picks?.includes('wav'));
    assert.equal(await page.getByRole('dialog', { name: '音频详情', exact: true }).count(), 0);
    await audioTrim();
    result.ui.audioTrim = true;
    }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.unexpected), []);
  console.log(JSON.stringify(result));
} finally {
  const diagnostics = await page.evaluate(() => ({ calls: window.calls, unexpected: window.unexpected, previews: [...document.querySelectorAll('div[data-audio-preview]')].slice(0, 3).map(element => ({ html: element.outerHTML, rect: element.getBoundingClientRect().toJSON() })) })).catch(() => null);
  await page.screenshot({ path: resolve(output, 'last-state.png') }).catch(() => {});
  await writeFile(resolve(output, 'result.json'), JSON.stringify({ ...result, errors, mediaRequests, diagnostics }, null, 2));
  await browser.close(); await server.close();
}
