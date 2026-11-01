import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
import { createPreviewServer } from './fixtures/audio-library-preview/server.mjs';
import { formatTime } from './fixtures/audio-library-preview/waveform.js';

assert.equal(formatTime(3600), '1:00:00', 'hour-long audio uses the same readable duration as video');
assert.equal(formatTime(3661.5), '1:01:01');
assert.equal(formatTime(61), '1:01');

// Real PCM media and precomputed min/max data; never replace Audio.play().
const output = resolve('.tmp/audio-preview-ui');
const fixtures = resolve(output, 'fixtures');
await mkdir(fixtures, { recursive: true });
const sampleRate = 16000, duration = 12, frames = sampleRate * duration, binSize = 188;
const pcm = Buffer.alloc(44 + frames * 2);
pcm.write('RIFF'); pcm.writeUInt32LE(pcm.length - 8, 4); pcm.write('WAVEfmt ', 8);
pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
pcm.writeUInt32LE(sampleRate, 24); pcm.writeUInt32LE(sampleRate * 2, 28);
pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write('data', 36); pcm.writeUInt32LE(frames * 2, 40);
const peaks = [];
for (let i = 0; i < frames; i++) {
  const amplitude = .02 * (.25 + .75 * Math.pow(Math.sin(i / sampleRate * 1.7), 2));
  const value = Math.sin(i / sampleRate * Math.PI * 440) * amplitude;
  pcm.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  const bin = Math.floor(i / binSize);
  if (!peaks[bin]) peaks[bin] = [0, 0];
  peaks[bin][0] = Math.min(peaks[bin][0], value); peaks[bin][1] = Math.max(peaks[bin][1], value);
}
const names = ['雨后庭院', '远处的列车', '纸张与铅笔', '夜间街道', '午后节拍', '安静的房间'];
const manifest = names.map((name, i) => ({ id: `sound-${i}`, name: `${name}.wav`, duration,
  url: `/audio-fixtures/sound-${i}.wav`, peaksUrl: `/audio-fixtures/sound-${i}.json` }));
const requests = [], errors = [];
await writeFile(`${fixtures}/manifest.json`, JSON.stringify(manifest));
for (const item of manifest) {
  const silence = item.id === 'sound-5';
  const original = silence ? Buffer.from(pcm) : pcm;
  if (silence) original.fill(0, 44);
  await writeFile(`${fixtures}/${item.id}.wav`, original);
  await writeFile(`${fixtures}/${item.id}.json`, JSON.stringify({ duration, peaks: silence ? peaks.map(() => [0, 0]) : peaks, totalFrames: frames, framesPerPeak: binSize }));
}
const preview = await createPreviewServer({ port: 0, fixturesDir: fixtures });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=document-user-activation-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (request.url().includes('/audio-fixtures/')) requests.push(new URL(request.url()).pathname.replace('/audio-fixtures', '')); });
await page.addInitScript(() => {
  const NativeAudio = window.Audio;
  window.audioConstructorCount = 0;
  window.Audio = function(...args) { window.audioConstructorCount++; return new NativeAudio(...args); };
  window.Audio.prototype = NativeAudio.prototype;
  if (window.AudioContext) window.AudioContext.prototype.decodeAudioData = () => { throw new Error('Waveform must not decode audio in the UI'); };
});
const url = preview.url;
const audio = () => page.locator('audio').evaluate(element => ({ paused: element.paused, time: element.currentTime, src: element.currentSrc, sourceAttribute: element.getAttribute('src') }));
const wave = index => page.locator('.audio-wave').nth(index);
const playButton = index => page.locator('.audio-play').nth(index);
const moveAway = () => page.mouse.move(10, 10);
async function hoverAt(index, ratio) {
  const rect = await wave(index).boundingBox();
  await page.mouse.move(rect.x + rect.width * ratio, rect.y + rect.height / 2);
}
async function clickAt(index, ratio) {
  const rect = await wave(index).boundingBox();
  await page.mouse.click(rect.x + rect.width * ratio, rect.y + rect.height / 2);
}
async function assertHoverAt(index, ratio, expectedTime) {
  const card = page.locator('.audio-card').nth(index);
  const position = await card.evaluate(element => {
    const waveform = element.querySelector('.audio-wave').getBoundingClientRect();
    const cursor = element.querySelector('.wave-hover-cursor');
    return { ratio: (cursor.getBoundingClientRect().x - waveform.x) / waveform.width,
      opacity: Number(getComputedStyle(cursor).opacity), time: element.querySelector('.wave-position').textContent };
  });
  assert.ok(Math.abs(position.ratio - ratio) < .02, 'hover cursor follows the current pointer position');
  assert.ok(position.opacity > 0, 'hover cursor is visibly drawn');
  assert.equal(position.time, expectedTime, 'hover time describes the pointer, independently of playback progress');
}
async function waitPlaying(minimumTime = .05) {
  await page.waitForFunction(time => { const element = document.querySelector('audio'); return element && !element.paused && element.currentTime >= time && document.querySelector('.audio-card[data-playing="true"]'); }, minimumTime);
}
try {
  const origin = new URL(url).origin;
  const rangeResponse = await fetch(`${origin}/audio-fixtures/sound-0.wav`, { headers: { Range: 'bytes=44-143' } });
  assert.equal(rangeResponse.status, 206); assert.equal((await rangeResponse.arrayBuffer()).byteLength, 100);
  assert.equal(rangeResponse.headers.get('content-range'), `bytes 44-143/${pcm.length}`);
  assert.equal((await fetch(`${origin}/audio-fixtures/sound-0.wav`, { headers: { Range: 'bytes=999999999-' } })).status, 416);
  assert.equal((await fetch(`${origin}/audio-fixtures/%2e%2e%5coutside.json`)).status, 403);
  const response = await page.goto(url);
  assert.equal(response.status(), 200, 'isolated audio preview must exist');
  await page.locator('.audio-card canvas').first().waitFor({ timeout: 5000 });
  assert.equal(await page.locator('.audio-card').count(), 6);
  await page.waitForFunction(() => [...document.querySelectorAll('.audio-card')].every(card => card.dataset.waveReady === 'true'));
  assert.equal(requests.filter(value => value.endsWith('.wav')).length, 0, 'passive cards never request original media');
  assert.equal(await page.locator('audio').count(), 1);
  const paintedHeight = async index => page.locator('.audio-card canvas').nth(index).evaluate(canvas => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let first = canvas.height, last = -1;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      if (pixels[(y * canvas.width + x) * 4 + 3] > 20) { first = Math.min(first, y); last = Math.max(last, y); }
    }
    return (last - first + 1) / (canvas.width / canvas.clientWidth);
  });
  assert.ok(await paintedHeight(0) > 80, 'quiet audio remains readable through display-only normalization');
  assert.ok(await paintedHeight(5) <= 3, 'actual silence stays on the baseline');
  assert.equal(await page.locator('audio').evaluate(element => element.volume), 1, 'display normalization never changes playback gain');
  await page.screenshot({ path: `${output}/audio-dark.png` });

  // First grant a real user gesture. Hover must stay silent even when browser
  // policy would allow playback; rejection by autoplay policy is not a pass.
  await page.locator('.audio-topbar').click({ position: { x: 100, y: 30 } });
  await hoverAt(0, .25); await page.waitForTimeout(250);
  assert.equal((await audio()).paused, true, 'hover must not play audio after user activation');
  assert.equal((await audio()).sourceAttribute, null, 'hover must not assign a media source');
  assert.equal((await audio()).time, 0, 'hover must not seek the native player');
  assert.equal(requests.filter(value => value.endsWith('.wav')).length, 0, 'hover must not request original media');
  await assertHoverAt(0, .25, '0:03');
  await hoverAt(0, .75); await assertHoverAt(0, .75, '0:09');
  assert.equal(await page.locator('.audio-preview > .audio-wave').count(), 6);
  assert.equal(await page.locator('.audio-preview > .audio-play').count(), 6, 'play control is a real sibling button');
  assert.equal(await page.locator('button button').count(), 0, 'interactive buttons must not be nested');
  await page.screenshot({ path: `${output}/audio-hover.png` });

  // A user starts with the dedicated play button, then jumps within that same
  // audio. Seeking may legitimately issue Range reads, but must not reload src.
  await page.locator('audio').evaluate(element => {
    window.audioLoadStarts = 0;
    element.addEventListener('loadstart', () => { window.audioLoadStarts++; });
  });
  await playButton(0).click(); await waitPlaying();
  assert.ok((await audio()).time < 1.2, 'initial dedicated playback starts at zero');
  const persistentStartTime = (await audio()).time;
  await moveAway(); await page.waitForTimeout(200);
  assert.equal((await audio()).paused, false, 'button-started playback continues after the pointer leaves');
  assert.ok((await audio()).time > persistentStartTime + .1, 'continuous playback advances the real media clock outside the preview');
  await page.locator('.audio-topbar').click({ position: { x: 100, y: 30 } });
  assert.equal((await audio()).paused, false, 'moving focus outside does not pause button-started playback');
  const beforeVisibility = await audio();
  const loadStartsBeforeVisibility = await page.evaluate(() => window.audioLoadStarts);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert.equal((await audio()).paused, false, 'window blur does not stop continuous button playback');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(200);
  assert.equal((await audio()).paused, false, 'document visibility changes preserve continuous playback');
  assert.equal((await audio()).sourceAttribute, beforeVisibility.sourceAttribute, 'hidden continuous playback retains its original source');
  assert.ok((await audio()).time > beforeVisibility.time + .1, 'the native clock advances while the continuous visibility handler is hidden');
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  assert.equal((await audio()).paused, false);
  assert.equal(await page.evaluate(() => window.audioLoadStarts), loadStartsBeforeVisibility, 'restoring visibility must not reload the continuous source');
  await hoverAt(1, .6); await page.waitForTimeout(100);
  assert.ok((await audio()).src.endsWith('sound-0.wav'), 'hovering another card never replaces continuous playback');
  assert.equal((await audio()).paused, false);
  const sameSourceSeek = {
    loadStartsBefore: await page.evaluate(() => window.audioLoadStarts),
    originalRequestsBefore: requests.filter(value => value.endsWith('.wav')).length,
  };
  assert.ok(sameSourceSeek.loadStartsBefore >= 1, 'the native source genuinely loaded before seeking');
  await clickAt(0, .5); await waitPlaying(5.8);
  sameSourceSeek.loadStartsAfter = await page.evaluate(() => window.audioLoadStarts);
  sameSourceSeek.originalRequestsAfter = requests.filter(value => value.endsWith('.wav')).length;
  assert.equal(sameSourceSeek.loadStartsAfter, sameSourceSeek.loadStartsBefore,
    `same-card seek must reuse the loaded source; native observations: ${JSON.stringify(sameSourceSeek)}`);
  assert.ok((await audio()).time < 7, 'waveform click seeks to its horizontal coordinate');
  await moveAway();
  assert.equal((await audio()).paused, true, 'clicking the same waveform converts continuous playback into temporary audition');
  assert.equal((await audio()).sourceAttribute, null);
  await clickAt(0, .5); await waitPlaying(5.8);
  const started = (await audio()).time; await page.waitForTimeout(200);
  assert.ok((await audio()).time > started + .1, 'native audio clock must advance');
  await hoverAt(0, .8); await assertHoverAt(0, .8, '0:09');
  const afterHover = (await audio()).time;
  assert.ok(afterHover >= started && afterHover < started + 1.5, 'moving the hover cursor during playback must not seek');

  // Dispatch a click with its own coordinate without a preceding pointermove.
  // This pins the browser event contract: a stale hover ratio is insufficient.
  await hoverAt(0, .2);
  const rect = await wave(0).boundingBox();
  await wave(0).dispatchEvent('click', { detail: 1, clientX: rect.x + rect.width * .7, clientY: rect.y + rect.height / 2 });
  await waitPlaying(8.2);
  assert.ok((await audio()).time < 9.2, 'click uses its current coordinate rather than the previous hover coordinate');
  assert.equal(await page.locator('.audio-card[data-playing="true"]').count(), 1);

  // Moving from waveform to its separate play button stays inside the preview.
  await playButton(0).hover();
  assert.equal((await audio()).paused, false, 'moving onto the sibling play button must not stop playback');
  await page.locator('.audio-preview').first().evaluate(element => {
    window.previewBubbleClicks = 0; window.waveClickCount = 0;
    element.addEventListener('click', () => { window.previewBubbleClicks++; });
    element.querySelector('.audio-wave').addEventListener('click', () => { window.waveClickCount++; });
  });
  await playButton(0).click();
  assert.equal((await audio()).paused, true, 'the separate button pauses currently playing audio');
  await playButton(0).click(); await waitPlaying();
  assert.ok((await audio()).time < 1.2, 'the separate play button always starts at zero');
  await playButton(0).click(); await playButton(0).click(); await waitPlaying();
  assert.ok((await audio()).time < 1.2, 'play after pause restarts at zero instead of resuming');
  assert.deepEqual(await page.evaluate(() => [window.previewBubbleClicks, window.waveClickCount]), [0, 0], 'play control stops bubbling and never triggers waveform seek');
  await moveAway();
  assert.equal((await audio()).paused, false, 'the dedicated button keeps playing outside the preview');
  await playButton(1).click(); await waitPlaying();
  assert.ok((await audio()).src.endsWith('sound-1.wav'), 'a new play button replaces the previous continuous source');
  assert.ok((await audio()).time < 1.2, 'replacement button playback starts at zero');
  assert.equal(await page.locator('.audio-card[data-playing="true"]').count(), 1, 'the previous source is no longer marked playing');
  await moveAway(); await page.waitForTimeout(150);
  assert.equal((await audio()).paused, false);
  assert.ok((await audio()).src.endsWith('sound-1.wav'), 'the old source cannot revive after replacement');
  await clickAt(0, .25); await waitPlaying(2.9);
  assert.ok((await audio()).src.endsWith('sound-0.wav'), 'a new waveform audition replaces continuous playback');
  await moveAway();
  assert.equal((await audio()).paused, true, 'leaving a waveform-started audition still stops playback');
  assert.equal((await audio()).sourceAttribute, null);

  // Keyboard chooses a location, then explicitly starts playback there.
  await wave(0).focus(); await page.keyboard.press('Home');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  assert.equal((await audio()).sourceAttribute, null, 'arrow navigation alone must not load or play media');
  await page.keyboard.press('Enter'); await waitPlaying(2.3);
  assert.ok((await audio()).time < 3.1, 'Enter plays the keyboard-selected location');
  await page.keyboard.press('ArrowRight');
  assert.ok((await audio()).time < 2.9, 'arrow selection during playback does not seek until activation');
  await page.keyboard.press('Space'); await waitPlaying(2.9);
  assert.ok((await audio()).time < 3.8, 'Space seeks and plays rather than toggling pause');
  await page.keyboard.press('Escape'); assert.equal((await audio()).paused, true);
  await playButton(0).focus(); await page.keyboard.press('Space'); await waitPlaying();
  assert.ok((await audio()).time < 1.2, 'keyboard play button starts at zero');
  await page.keyboard.press('Enter'); assert.equal((await audio()).paused, true);

  // Delay real source delivery, then abandon that source while a newer one starts.
  let delayedRequests = 0;
  let reportDelayedRequest;
  const delayedRequestStarted = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Expected a real pending media request before switching cards')), 5000);
    reportDelayedRequest = () => { clearTimeout(timeout); resolve(); };
  });
  await page.route('**/sound-2.wav', async route => { delayedRequests++; reportDelayedRequest(); await new Promise(resolve => setTimeout(resolve, 350)); await route.continue().catch(() => {}); });
  await clickAt(2, .4);
  await delayedRequestStarted;
  await clickAt(0, .2); await waitPlaying(2);
  await page.waitForTimeout(450);
  assert.ok((await audio()).src.endsWith('sound-0.wav'), 'delayed old source cannot replace active source');
  assert.ok(delayedRequests > 0, 'race uses an actual pending media request');
  await moveAway(); await page.unroute('**/sound-2.wav');

  // Hold an actual button-started source until after pointer exit. The mode
  // applies while play() is pending, not only after its promise resolves.
  let deliverContinuousSource, reportContinuousRequest;
  const continuousResponseGate = new Promise(resolve => { deliverContinuousSource = resolve; });
  const continuousRequestStarted = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Expected a real pending continuous source')), 5000);
    reportContinuousRequest = () => { clearTimeout(timeout); resolve(); };
  });
  await page.route('**/sound-3.wav', async route => { reportContinuousRequest(); await continuousResponseGate; await route.continue().catch(() => {}); });
  await playButton(3).click(); await continuousRequestStarted;
  await moveAway();
  assert.ok((await audio()).sourceAttribute?.endsWith('sound-3.wav'), 'leaving during pending button playback retains its requested source');
  deliverContinuousSource();
  await waitPlaying();
  const continuousAfterPending = (await audio()).time;
  await page.waitForTimeout(200);
  assert.equal((await audio()).paused, false, 'pending button playback starts after delivery even though the pointer is outside');
  assert.ok((await audio()).time > continuousAfterPending + .1, 'delivered continuous source advances the real clock');
  await playButton(0).click(); await waitPlaying();
  await moveAway(); await page.waitForTimeout(150);
  assert.ok((await audio()).src.endsWith('sound-0.wav'), 'a new play replaces the delivered continuous source without resurrection');
  assert.equal(await page.locator('.audio-card[data-playing="true"]').count(), 1);
  await playButton(0).click();
  assert.equal((await audio()).paused, true);
  await page.unroute('**/sound-3.wav');

  // Real click requests race across cards but retain one native player.
  for (let index = 0; index < 100; index++) await clickAt(index % 2, .3 + (index % 3) * .1);
  await moveAway(); await page.waitForTimeout(350);
  assert.equal((await audio()).paused, true, 'a late play result must not resume after exit');
  assert.equal(await page.evaluate(() => window.audioConstructorCount), 1);
  assert.equal(await page.locator('audio').count(), 1);
  assert.equal((await audio()).sourceAttribute, null, 'late completion cannot retain a source after exit');
  const requestsBeforeHover = requests.filter(value => value.endsWith('.wav')).length;
  for (let index = 0; index < 100; index++) await hoverAt(index % 2, .3 + (index % 3) * .1);
  await moveAway(); await page.waitForTimeout(100);
  assert.equal(requests.filter(value => value.endsWith('.wav')).length, requestsBeforeHover, '100 hover transitions never read an original');

  await clickAt(0, .2); await waitPlaying(2);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert.equal((await audio()).paused, true, 'window blur stops audition');
  await moveAway(); await clickAt(0, .2); await waitPlaying(2);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal((await audio()).paused, true, 'hidden document stops audition');
  await page.evaluate(() => { delete document.hidden; });
  await moveAway(); await clickAt(0, .2); await waitPlaying(2);
  await page.evaluate(() => document.querySelector('.audio-card').remove());
  await page.waitForFunction(() => document.querySelector('audio').paused);

  await page.goto(`${url}?count=1200`);
  await page.locator('.audio-card canvas').first().waitFor();
  assert.ok(await page.locator('.audio-card').count() <= 24, 'mount only viewport plus overscan');
  await wave(0).focus(); await page.keyboard.press('Space'); await waitPlaying();
  await page.locator('.audio-scroll').evaluate(element => { element.scrollTop = 25000; });
  await page.waitForFunction(() => document.querySelector('audio').paused);
  await page.waitForFunction(() => Number(document.querySelector('.audio-card')?.dataset.index) > 200);
  assert.ok(await page.locator('.audio-card').count() <= 24);
  await page.locator('.audio-scroll').evaluate(element => { element.scrollTop = 0; });
  await page.locator('.audio-card[data-index="0"] .audio-play').waitFor();
  await playButton(0).click(); await waitPlaying();
  await moveAway();
  const beforeUnmount = await audio();
  await page.locator('.audio-scroll').evaluate(element => { element.scrollTop = 25000; });
  await page.waitForFunction(() => !document.querySelector('.audio-card[data-index="0"]'));
  await page.waitForTimeout(200);
  assert.equal((await audio()).paused, false, 'virtual unmount must not stop button-started playback');
  assert.equal((await audio()).src, beforeUnmount.src, 'virtual unmount retains the current original source');
  assert.ok((await audio()).time > beforeUnmount.time + .1, 'offscreen playback keeps advancing');
  await page.locator('.audio-scroll').evaluate(element => { element.scrollTop = 0; });
  const restoredPlayButton = page.locator('.audio-card[data-index="0"] .audio-play');
  await restoredPlayButton.waitFor();
  assert.equal(await restoredPlayButton.getAttribute('aria-pressed'), 'true', 'returning to the card restores its pause state');
  assert.match(await restoredPlayButton.getAttribute('aria-label'), /^暂停 /);
  assert.equal(await page.locator('.audio-card[data-playing="true"]').count(), 1);
  assert.equal(await page.evaluate(() => window.audioConstructorCount), 1, 'virtual remount does not create a second player');
  await restoredPlayButton.click();
  assert.equal((await audio()).paused, true, 'the remounted pause button controls the existing playback');
  const scrollMetrics = await page.evaluate(async () => {
    const scroller = document.querySelector('.audio-scroll');
    const intervals = [], longTasks = [];
    const observer = new PerformanceObserver(list => { for (const task of list.getEntries()) longTasks.push(task.duration); });
    observer.observe({ type: 'longtask', buffered: false });
    let previous = performance.now(), started = previous, maximumMounted = 0;
    await new Promise(resolve => {
      function frame(now) {
        intervals.push(now - previous); previous = now;
        scroller.scrollTop = ((now - started) / 2500) * (scroller.scrollHeight - scroller.clientHeight);
        maximumMounted = Math.max(maximumMounted, document.querySelectorAll('.audio-card').length);
        if (now - started < 2500) requestAnimationFrame(frame); else resolve();
      }
      requestAnimationFrame(frame);
    });
    observer.disconnect();
    const sorted = intervals.slice(1).sort((a, b) => a - b);
    return { measuredMs: previous - started, frames: intervals.length, medianIntervalMs: sorted[Math.floor(sorted.length / 2)],
      p95IntervalMs: sorted[Math.floor(sorted.length * .95)], maximumIntervalMs: Math.max(...sorted), maximumMounted,
      longTaskCount: longTasks.length, longestTaskMs: Math.max(0, ...longTasks) };
  });
  assert.ok(scrollMetrics.maximumMounted <= 24, 'mounting stays bounded throughout scrolling');
  await page.locator('.audio-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.waitForFunction(() => !!document.querySelector('[data-index="1199"]'));
  assert.ok(requests.filter(value => value.endsWith('.json') && value !== '/manifest.json').length <= 12, 'shared peak cache avoids repeated reads for duplicate fixtures');
  await page.getByRole('button', { name: '切换为浅色' }).click();
  await page.screenshot({ path: `${output}/audio-light.png` });
  assert.deepEqual(errors, []);
  await writeFile(`${output}/results.json`, JSON.stringify({ passed: true, browser: await browser.version(), viewport: { width: 1280, height: 820 },
    interaction: 'hover-pointer-only; temporary waveform audition; persistent zero-start button playback across pointer/focus/virtual unmount',
    source: { format: 'PCM WAV', duration, sampleRate, channels: 1 }, sameSourceSeek,
    clickSwitches: 100, hoverSwitches: 100, hoverOriginalRequests: 0, delayedRequests,
    continuousPendingSourcePassed: true, continuousBlurVisibilityPassed: true,
    playersCreated: await page.evaluate(() => window.audioConstructorCount),
    stressCount: 1200, distinctSources: 6, scrollMetrics,
    measurementScope: 'Synthetic 1200-card browser list reusing six WAV fixtures; rAF intervals are not native FPS or indexing measurements',
    mountedAtEnd: await page.locator('.audio-card').count(), mediaRequests: requests.filter(value => value.endsWith('.wav')).length }, null, 2));
  console.log('PASS: persistent button playback across leave/focus/virtual unmount, temporary waveform audition, unique replacement, pause-state restoration, silent hover, real clock, stale-source cancellation, singleton/cache/no frontend decode');
} finally { await browser.close(); await preview.close(); }
