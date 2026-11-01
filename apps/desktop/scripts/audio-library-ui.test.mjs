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
  await page.getByRole('button', { name: '物理删除', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  mutation = await page.evaluate(() => window.mutations.at(-1)); assert.equal(mutation.command, 'delete_asset_with_mode'); assert.equal(mutation.paused, true); assert.equal(mutation.src, null);
  await play.click(); await progressBeyond(.2);
  await page.evaluate(() => window.openMutationDialog('delete-reference'));
  await page.getByRole('button', { name: '移除引用', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  mutation = await page.evaluate(() => window.mutations.at(-1)); assert.equal(mutation.paused, false, 'removing only an external reference does not mutate the playing original');
  await play.click(); await stopped();
  return page.evaluate(() => window.mutations);
}
async function selection() {
  const card = page.locator('.audio-file-card[data-asset-id="wav"]');
  await wave('wav').locator('.audio-waveform-play').click(); await progressBeyond(.2);
  const before = await playerState();
  const plays = await page.evaluate(() => window.audioEvents.filter(event => event.type === 'playing').length);
  await card.locator('.audio-file-meta').click();
  await page.waitForTimeout(120);
  assert.deepEqual(errors, [], 'audio selection must render the real selection mark without a missing preview element');
  assert.equal(await card.evaluate(element => element.classList.contains('is-selected')), true);
  await progressBeyond(before.time + .2);
  assert.equal((await playerState()).currentSrc, before.currentSrc);
  assert.equal(await page.evaluate(() => window.audioEvents.filter(event => event.type === 'playing').length), plays, 'selecting never restarts playback');
  assert.equal(await wave('wav').locator('.audio-waveform-play').isEnabled(), true, 'selected active audio must remain pausable');
  await wave('wav').locator('.audio-waveform-play').click(); await stopped();
  await card.locator('.audio-file-meta').click({ modifiers: ['Control'] });
  assert.equal(await card.evaluate(element => element.classList.contains('is-selected')), false);
  assert.equal(await page.evaluate(() => window.audioEvents.filter(event => event.type === 'playing').length), plays, 'selection changes never restart playback');
  await page.getByRole('button', { name: '取消选择', exact: true }).click();
  await wave('wav').locator('.audio-waveform-play').click(); await progressBeyond(.2);
  await wave('wav').locator('.audio-waveform-play').click(); await stopped();
  return { selectionAndDeselect: true, preservedPlayback: true, selectedPause: true, extraPlayEvents: 0 };
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
    await page.goto(url);
    await page.locator('.library-home').waitFor();
    assert.equal(await page.getByRole('button', { name: '音频', exact: true }).count(), 1, 'formal library must expose audio alongside image and video');
    await page.getByRole('button', { name: '音频', exact: true }).click();
    await wave('wav').waitFor();
    await page.waitForFunction(() => document.querySelector('div[data-audio-preview][data-asset-id="wav"]')?.dataset.waveReady === 'true');
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
    await wave('wav').locator('.audio-waveform-play').click(); await progressBeyond(.2);
    await wave('mp3').locator('.audio-waveform-play').click(); await progressBeyond(.2);
    assert.match((await playerState()).currentSrc, /long-vbr\.mp3/);
    assert.equal(await page.locator('div[data-audio-preview][data-playing="true"]').count(), 1);
    const beforeMediaSwitch = await playerState();
    await page.getByRole('button', { name: '图片', exact: true }).click(); await progressBeyond(beforeMediaSwitch.time + .2);
    assert.equal((await playerState()).currentSrc, beforeMediaSwitch.currentSrc, 'continuous playback persists media/view switches');
    await page.locator('.folder-media-card[data-asset-id="image"]').waitFor();
    assert.equal(await page.locator('div[data-audio-preview]').count(), 0);
    await page.getByRole('button', { name: '视频', exact: true }).click();
    await page.locator('.folder-media-card[data-asset-id="video"]').waitFor();
    assert.equal(await page.locator('div[data-audio-preview]').count(), 0);
    await page.getByRole('button', { name: '音频', exact: true }).click(); await wave('wav').waitFor();
    await wave('mp3').locator('.audio-waveform-play').click(); await stopped();
    result.ui.mutations = await mutations();
    await page.evaluate(() => window.mode.getState().setCatalogView('tags'));
    await page.locator('[data-tag-section="tag-music"]').waitFor();
    assert.equal(await page.locator('[data-tag-section="tag-music"] div[data-audio-preview][data-asset-id="mp3"]').count(), 1, 'manual audio tags retain grouped browsing');
    await page.evaluate(() => window.mode.getState().setCatalogView('collections'));
    await page.locator('[data-collection-id="child"]').waitFor();
    await page.locator('[data-collection-id="child"]').click(); await wave('mp3').waitFor();
    assert.deepEqual(await page.locator('[data-catalog-section]').evaluateAll(elements => elements.map(element => element.dataset.catalogSection)), ['root', 'child', 'next']);
    assert.ok((await page.evaluate(() => window.calls.filter(call => call.command === 'connection_entries'))).every(call => call.args.media === 'audios' && call.args.limit <= 60));
    await page.locator('.catalog-scroller').evaluate(element => { element.scrollTop += 320; }); await wave('flac').waitFor();
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
    await page.waitForTimeout(150);
    await page.screenshot({ path: resolve(output, 'collections-dark.png') });
    await page.evaluate(() => window.store.getState().openDetail('wav'));
    await page.locator('.asset-detail div[data-audio-preview]').waitFor();
    assert.equal(await page.locator('.asset-detail').getByRole('button', { name: /反推/ }).count(), 0);
    await page.getByRole('button', { name: '+ 加类别', exact: true }).click();
    await page.getByPlaceholder('新类别名', { exact: true }).fill('音效');
    await page.getByPlaceholder('新类别名', { exact: true }).press('Enter');
    await page.waitForFunction(() => window.calls.some(call => call.command === 'set_asset_tags' && call.args.source === 'manual'));
    assert.deepEqual(await page.evaluate(() => window.calls.find(call => call.command === 'set_asset_tags').args), { assetId: 'wav', names: ['音效'], source: 'manual' });
    await page.screenshot({ path: resolve(output, 'detail-dark.png') });
    const calls = await page.evaluate(() => window.calls);
    assert.ok(calls.some(call => call.command === 'audio_waveform' && call.args.expectedVersion === 'a'.repeat(64)), 'connected entries verify their source fingerprint');
    assert.equal(calls.filter(call => ['external_files_preview', 'external_files_media'].includes(call.command) && /\.(wav|mp3|flac|m4a|ogg)/i.test(call.args.path)).length, 0);
    assert.equal(calls.filter(call => /describe|classif.*start|generate/.test(call.command)).length, 0);
    assert.ok(mediaRequests.every(request => request.range), 'real audio originals use Range');
    assert.deepEqual(await page.evaluate(() => window.unexpected), []);
    const stressRequests = mediaRequests.length;
    await page.goto(`${url}?stress`);
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
