import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const output = resolve('.tmp/audio-waveform-production');
await mkdir(output, { recursive: true });
const rate = 16000, duration = 12, frames = rate * duration, width = 256;
const pcm = Buffer.alloc(44 + frames * 2);
pcm.write('RIFF'); pcm.writeUInt32LE(pcm.length - 8, 4); pcm.write('WAVEfmt ', 8);
pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
pcm.writeUInt32LE(rate, 24); pcm.writeUInt32LE(rate * 2, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34);
pcm.write('data', 36); pcm.writeUInt32LE(frames * 2, 40);
const peaks = [];
for (let frame = 0; frame < frames; frame++) {
  const value = Math.sin(frame / rate * 440 * Math.PI) * .04 * (.2 + .8 * Math.sin(frame / rate * 1.2) ** 2);
  pcm.writeInt16LE(Math.round(value * 32767), 44 + frame * 2);
  const i = Math.floor(frame / width); peaks[i] ||= [0, 0]; peaks[i][0] = Math.min(peaks[i][0], value); peaks[i][1] = Math.max(peaks[i][1], value);
}
for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) await writeFile(`${output}/${id}.wav`, pcm);
await writeFile(`${output}/peaks.json`, JSON.stringify({ sourceVersion: 'fingerprint-1', duration, sampleRate: rate, channels: 1, peaks, framesPerPeak: width, totalFrames: frames }));
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: `${output}/vite`,
  css: { postcss: { plugins: [] } }, esbuild: { jsx: 'automatic' },
  optimizeDeps: { entries: ['scripts/fixtures/audio-waveform-production/preview.html'], include: ['react', 'react-dom/client', 'react/jsx-runtime'] },
  server: { host: '127.0.0.1', port: 17889, strictPort: true, hmr: false, watch: null },
});
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=document-user-activation-required'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
page.setDefaultTimeout(8000);
const errors = [], originalRequests = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (/\.wav(?:\?|$)/.test(request.url())) originalRequests.push(request.url()); });
await page.addInitScript(() => {
  const NativeAudio = window.Audio; window.audioCreated = 0;
  window.Audio = function(...args) { window.audioCreated++; return new NativeAudio(...args); };
  window.Audio.prototype = NativeAudio.prototype;
  if (window.AudioContext) window.AudioContext.prototype.decodeAudioData = () => { throw new Error('Production waveform must never decode audio in JS'); };
});
const card = id => page.locator(`[data-item="${id}"]`);
const wave = id => card(id).locator('.audio-waveform-wave');
const button = id => card(id).locator('.audio-waveform-play');
const native = () => page.locator('audio[data-audio-preview]').evaluate(audio => ({ paused: audio.paused, time: audio.currentTime, src: audio.getAttribute('src'), currentSrc: audio.currentSrc }));
const away = () => page.mouse.move(10, 20);
async function pointer(id, ratio, click = false) {
  const box = await wave(id).boundingBox();
  await page.mouse[click ? 'click' : 'move'](box.x + box.width * ratio, box.y + box.height / 2);
}
async function playing(id, minimum = .05) {
  await page.waitForFunction(({ id, minimum }) => {
    const audio = document.querySelector('audio[data-audio-preview]');
    return audio && !audio.paused && audio.currentTime >= minimum && document.querySelector(`[data-item="${id}"] .audio-waveform`)?.dataset.playing === 'true';
  }, { id, minimum });
}
async function items(value) { await page.evaluate(value => window.setAudioFixtureItems(value), value); }
try {
  await page.goto('http://127.0.0.1:17889/scripts/fixtures/audio-waveform-production/preview.html');
  await wave('a').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.audio-waveform[data-wave-ready="true"]').length === 6);
  assert.equal(await page.locator('button button').count(), 0);
  assert.equal(originalRequests.length, 0, 'real component only loads peak metadata on passive mount');
  assert.equal(await page.evaluate(() => window.audioCreated), 0, 'no native player is allocated before explicit playback');
  assert.ok(await page.evaluate(() => window.peakMaximum) <= 2, 'native peak work is bounded at two');
  assert.ok(await page.evaluate(() => window.waveformCalls.every(call => !Object.hasOwn(call, 'expectedVersion'))), 'display revision is never sent as a source fingerprint');
  await page.locator('header').click(); await pointer('a', .5); await page.waitForTimeout(150);
  assert.equal(originalRequests.length, 0, 'hover after activation never reads audio');
  assert.equal(await card('a').locator('.audio-waveform-time').textContent(), '0:06');

  await button('a').click(); await playing('a');
  const started = (await native()).time;
  await away(); await page.locator('header').click(); await page.waitForTimeout(200);
  assert.equal((await native()).paused, false); assert.ok((await native()).time > started + .1);
  await pointer('b', .7); assert.ok((await native()).currentSrc.includes('/a.wav'));
  assert.equal(await page.evaluate(() => window.parentClicks), 0, 'preview controls do not activate their card parent');
  await page.locator('audio[data-audio-preview]').evaluate(audio => { window.loadStarts = 0; audio.addEventListener('loadstart', () => window.loadStarts++); });
  await pointer('a', .5, true); await playing('a', 5.8);
  assert.equal(await page.evaluate(() => window.loadStarts), 0, 'same source seek never resets the decoder');
  await pointer('a', .8);
  assert.equal(await card('a').locator('.audio-waveform-time').textContent(), '0:09');
  assert.ok((await native()).time < 7.5, 'hover during playback never seeks');
  await away(); assert.equal((await native()).paused, true, 'waveform activation changes persistent playback to temporary audition');

  await button('a').click(); await playing('a');
  await page.evaluate(() => window.dispatchEvent(new Event('blur'))); assert.equal((await native()).paused, false);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  const hiddenTime = (await native()).time; await page.waitForTimeout(180);
  assert.ok((await native()).time > hiddenTime + .1);
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await items([{ assetId: 'b' }]);
  await page.waitForTimeout(100); assert.equal((await native()).paused, false, 'React unmount preserves deliberate playback');
  await items([{ assetId: 'a' }, { assetId: 'b' }]);
  await button('a').waitFor();
  assert.equal(await button('a').getAttribute('aria-pressed'), 'true', 'remounted production component recovers pause state');
  await button('a').click(); assert.equal((await native()).paused, true);

  // UI list revision / duration refresh is not an actual source change.
  await button('a').click(); await playing('a');
  await items([{ assetId: 'a', version: 'display-2' }]);
  await page.waitForFunction(() => document.querySelector('.audio-waveform')?.dataset.waveReady === 'true');
  assert.equal((await native()).paused, false, 'display revision refresh must not interrupt the same fingerprint');
  assert.equal(await page.evaluate(() => window.durationUpdates.a), 1, 'duration callback cannot drive an endless refresh loop');
  await page.evaluate(() => { window.sourceVersions.a = 'fingerprint-2'; });
  await items([{ assetId: 'a', version: 'display-3', expectedVersion: 'fingerprint-2' }]);
  await page.waitForFunction(() => document.querySelector('audio[data-audio-preview]').paused);
  await page.waitForFunction(() => window.waveformCalls.some(call => call.expectedVersion === 'fingerprint-2'));
  await page.waitForFunction(() => document.querySelector('.audio-waveform')?.dataset.waveReady === 'true');
  await button('a').click(); await playing('a');
  assert.ok((await native()).currentSrc.includes('fingerprint-2'), 'playback URL uses the real source version');
  await page.evaluate(() => window.stopAudioFixture('a')); assert.equal((await native()).paused, true, 'explicit asset removal releases persistent playback');

  // Real IO visibility drives the production IPC queue, including StrictMode.
  await items([]);
  const callsBefore = await page.evaluate(() => window.waveformCalls.length);
  await page.evaluate(() => { window.holdPeaks = true; });
  await items(Array.from({ length: 40 }, (_, i) => ({ assetId: `queued-${i}`, path: '/.tmp/audio-waveform-production/a.wav', top: i < 6 ? Math.floor(i / 3) * 224 : 3000 + i * 224 })));
  await page.waitForFunction(count => window.waveformCalls.length >= count + 2, callsBefore);
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.waveformCalls.length), callsBefore + 2, 'only two visible jobs start, offscreen originals remain untouched');
  await items([]); await page.evaluate(() => { window.holdPeaks = false; window.releaseWaveforms(); });
  await page.waitForFunction(() => window.peakActive === 0);
  assert.equal(await page.evaluate(() => window.waveformCalls.length), callsBefore + 2, 'unmount cancels queued work before it starts');
  await items([{ assetId: 'queued-0', path: '/.tmp/audio-waveform-production/a.wav' }]);
  await page.waitForFunction(() => document.querySelector('.audio-waveform')?.dataset.waveReady === 'true');
  assert.equal(await page.evaluate(() => window.waveformCalls.length), callsBefore + 2, 'completed unsubscribed work remains reusable in the bounded peak cache');

  // A detail surface may reuse its React position for another equal-duration file.
  await items([{ assetId: 'reuse-one', instance: 'detail-slot', path: '/.tmp/audio-waveform-production/a.wav' }]);
  await page.waitForFunction(() => window.durationUpdates['reuse-one'] === 1);
  await items([{ assetId: 'reuse-two', instance: 'detail-slot', path: '/.tmp/audio-waveform-production/a.wav' }]);
  await page.waitForFunction(() => document.querySelector('.audio-waveform')?.dataset.waveReady === 'true');
  assert.equal(await page.evaluate(() => window.durationUpdates['reuse-two']), 1, 'duration delivery is scoped to asset identity, not just the numeric duration');

  await page.evaluate(() => { delete window.resolvedDurations['reuse-two']; });
  await items([{ assetId: 'reuse-two', instance: 'detail-slot', path: '/.tmp/audio-waveform-production/a.wav', version: 'display-refresh' }]);
  await page.waitForFunction(() => document.querySelector('.audio-waveform')?.dataset.waveReady === 'true');
  assert.equal(await page.evaluate(() => window.resolvedDurations['reuse-two']), 12, 'an accepted waveform response restores cleared parent duration after a display revision');

  await page.evaluate(() => { window.waveformFailures = ['retry']; });
  await items([{ assetId: 'retry', path: '/.tmp/audio-waveform-production/a.wav' }]);
  await card('retry').getByRole('button', { name: '重试', exact: true }).waitFor();
  assert.ok(!(await card('retry').textContent()).includes('C:\\private'), 'native waveform diagnostics do not leak into the card');
  await page.evaluate(() => { window.waveformFailures = []; });
  await card('retry').getByRole('button', { name: '重试', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.audio-waveform')?.dataset.waveReady === 'true');
  await items([{ assetId: 'retry', path: '/.tmp/audio-waveform-production/a.wav', interactive: false }]);
  const parentBefore = await page.evaluate(() => window.parentClicks);
  await pointer('retry', .5, true);
  assert.equal(await page.evaluate(() => window.parentClicks), parentBefore + 1, 'selection mode lets the parent card receive pointer clicks');
  assert.equal((await native()).paused, true, 'selection mode never starts a new playback');
  await items([{ assetId: 'retry', path: '/.tmp/audio-waveform-production/a.wav' }]);
  await button('retry').click(); await playing('retry');
  await items([{ assetId: 'retry', path: '/.tmp/audio-waveform-production/a.wav', interactive: false }]);
  assert.equal(await button('retry').isEnabled(), true, 'selection mode keeps the active pause control available');
  const selectedBefore = await page.evaluate(() => window.parentClicks);
  await pointer('retry', .8, true);
  assert.equal(await page.evaluate(() => window.parentClicks), selectedBefore + 1);
  assert.equal((await native()).paused, false, 'selecting the wave area preserves continuous playback');
  assert.ok((await native()).time < 2, 'selection mode never seeks through the wave area');
  await button('retry').click();
  assert.equal((await native()).paused, true, 'the active pause button works while its card is selected');
  assert.equal(await page.evaluate(() => window.parentClicks), selectedBefore + 1, 'pause does not toggle parent selection');
  assert.equal(await button('retry').isDisabled(), true, 'selection mode cannot restart after pausing');

  await items([{ assetId: 'folder', path: 'C:\\Media\\Music\\a.wav' }]);
  await button('folder').click(); await playing('folder');
  await page.evaluate(() => window.stopAudioFolderFixture('c:/media/mus'));
  assert.equal((await native()).paused, false, 'a sibling or partial directory prefix never stops unrelated playback');
  await page.evaluate(() => window.stopAudioFolderFixture('D:/Media/Music'));
  assert.equal((await native()).paused, false, 'an unrelated drive never stops playback');
  await page.evaluate(() => window.stopAudioFolderFixture('\\\\?\\c:\\MEDIA\\music\\'));
  assert.equal((await native()).paused, true, 'Windows directory mutation releases the active descendant using case-insensitive segments');
  await items([{ assetId: 'folder', path: '/.tmp/audio-waveform-production/a.wav', version: 'posix' }]);
  await button('folder').click(); await playing('folder');
  await page.evaluate(() => window.stopAudioFolderFixture('/.tmp/AUDIO-waveform-production'));
  assert.equal((await native()).paused, false, 'non-Windows paths remain case-sensitive');
  await page.evaluate(() => window.stopAudioFolderFixture('/.tmp/audio-waveform-production/a.wav'));
  assert.equal((await native()).paused, true, 'exact source mutation also releases the active file');

  // Hold the original media response, not Audio.play(), so async ownership remains native.
  await items([{ assetId: 'c' }, { assetId: 'd' }, { assetId: 'f' }]);
  await page.waitForFunction(() => document.querySelectorAll('.audio-waveform[data-wave-ready="true"]').length === 3);
  let releasePending, pendingCount = 0;
  const waitForMedia = new Promise(resolve => { releasePending = resolve; });
  const pendingMedia = async route => { pendingCount++; await waitForMedia; await route.continue(); };
  await page.route('**/c.wav?*', pendingMedia);
  await button('c').click();
  await page.waitForFunction(() => document.querySelector('[data-item="c"] .audio-waveform-play')?.getAttribute('aria-pressed') === 'true');
  await away(); await page.waitForTimeout(100);
  assert.ok(pendingCount > 0); assert.ok((await native()).src.includes('/c.wav'));
  releasePending(); await playing('c');
  const pendingTime = (await native()).time; await page.waitForTimeout(150);
  assert.ok((await native()).time > pendingTime + .08, 'continuous playback survives leaving while native play is pending');
  await page.unroute('**/c.wav?*', pendingMedia);

  let releaseStale, staleCount = 0;
  const waitForStale = new Promise(resolve => { releaseStale = resolve; });
  const staleMedia = async route => { staleCount++; await waitForStale; await route.continue(); };
  await page.route('**/d.wav?*', staleMedia);
  await pointer('d', .4, true); await page.waitForTimeout(100);
  assert.ok(staleCount > 0);
  await away(); assert.equal((await native()).paused, true, 'leaving cancels a pending temporary audition');
  await button('f').click(); await playing('f');
  releaseStale(); await page.waitForTimeout(180);
  assert.ok((await native()).currentSrc.includes('/f.wav'));
  assert.equal((await native()).paused, false, 'a replaced pending source cannot revive or stop the new source');
  await page.unroute('**/d.wav?*', staleMedia);
  await button('f').click();

  await items([{ assetId: 'a', version: 'display-3', expectedVersion: 'fingerprint-2' }, { assetId: 'b' }]);
  await page.waitForFunction(() => document.querySelectorAll('.audio-waveform[data-wave-ready="true"]').length === 2);
  for (let i = 0; i < 50; i++) await pointer(i % 2 ? 'a' : 'b', .2 + i % 3 * .1, true);
  await away(); await page.waitForTimeout(100);
  assert.equal((await native()).paused, true);
  assert.equal(await page.evaluate(() => window.audioCreated), 1);
  assert.equal(await page.locator('audio[data-audio-preview]').count(), 1);
  await wave('a').focus(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter'); await playing('a', .5);
  await page.keyboard.press('Escape'); assert.equal((await native()).paused, true);
  await page.screenshot({ path: `${output}/production-audio-dark.png` });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.screenshot({ path: `${output}/production-audio-light.png` });
  assert.deepEqual(errors, []);
  await writeFile(`${output}/results.json`, JSON.stringify({ passed: true, scope: 'Real production React AudioWaveform and shared player; waveform IPC simulated with peaks from the same synthetic WAV',
    browser: await browser.version(), audioCreated: await page.evaluate(() => window.audioCreated), peakMaximum: await page.evaluate(() => window.peakMaximum), originalRequests: originalRequests.length }, null, 2));
  console.log('PASS: production AudioWaveform real media, persistent/temporary controls, source identity, remount/delete, visible two-slot IPC queue/cancellation/cache, singleton, keyboard, no JS decoding');
} finally { await browser.close(); await server.close(); }
