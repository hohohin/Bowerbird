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
const audio = () => page.locator('audio').evaluate(element => ({ paused: element.paused, time: element.currentTime, src: element.currentSrc }));
const wave = index => page.locator('.audio-wave').nth(index);
const moveAway = () => page.mouse.move(10, 10);
async function hoverAt(index, ratio) {
  const rect = await wave(index).boundingBox();
  await page.mouse.move(rect.x + rect.width * ratio, rect.y + rect.height / 2);
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

  // CDP evaluation explicitly sets userGesture:false: Playwright evaluation can
  // otherwise activate a document and accidentally bypass the autoplay test.
  const blockedPage = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const cdp = await blockedPage.context().newCDPSession(blockedPage);
  const readWithoutGesture = async expression => (await cdp.send('Runtime.evaluate', { expression, userGesture: false, returnByValue: true })).result.value;
  await blockedPage.goto(url);
  for (let i = 0; i < 100 && !await readWithoutGesture("document.querySelector('.audio-card')?.dataset.waveReady === 'true'"); i++) await new Promise(resolve => setTimeout(resolve, 20));
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 140, y: 245 });
  for (let i = 0; i < 100 && !await readWithoutGesture("document.querySelector('.audio-card')?.dataset.blocked === 'true'"); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await readWithoutGesture("document.querySelector('.audio-card').dataset.blocked"), 'true', 'real browser policy must reject gesture-free hover');
  assert.equal(await readWithoutGesture("document.querySelector('audio').paused"), true);
  assert.equal(await blockedPage.locator('.wave-action-label').first().textContent(), '播放');
  await blockedPage.locator('.audio-wave').first().click();
  await blockedPage.waitForFunction(() => !document.querySelector('audio').paused && document.querySelector('audio').currentTime > 0);
  await blockedPage.close();

  // A real gesture enables audible previews under ordinary browser autoplay rules.
  await wave(0).focus(); await page.keyboard.press('Space'); await waitPlaying();
  const started = (await audio()).time; await page.waitForTimeout(250);
  assert.ok((await audio()).time > started + .1, 'real media clock must advance');
  await page.keyboard.press('Space'); assert.equal((await audio()).paused, true);
  await moveAway(); await hoverAt(0, .5); await waitPlaying(5.8);
  assert.ok((await audio()).time < 7, 'hover must seek to pointer time, not begin at zero');
  assert.equal(await page.locator('.audio-card[data-playing="true"]').count(), 1);
  await moveAway(); assert.equal((await audio()).paused, true);

  // Delay real source delivery, then abandon that source while a newer one starts.
  let delayedRequests = 0;
  await page.route('**/sound-1.wav', async route => { delayedRequests++; await new Promise(resolve => setTimeout(resolve, 350)); await route.continue().catch(() => {}); });
  await hoverAt(1, .4);
  await page.waitForFunction(() => document.querySelector('audio').getAttribute('src')?.endsWith('sound-1.wav'));
  await hoverAt(0, .2); await waitPlaying(2);
  await page.waitForTimeout(450);
  assert.ok((await audio()).src.endsWith('sound-0.wav'), 'delayed old source cannot replace active source');
  assert.ok(delayedRequests > 0, 'race uses an actual pending media request');
  await moveAway(); await page.unroute('**/sound-1.wav');

  // Exercise rapid switches using real pointer events, retaining a single native player.
  for (let index = 0; index < 100; index++) await hoverAt(index % 2, .3 + (index % 3) * .1);
  await moveAway(); await page.waitForTimeout(350);
  assert.equal((await audio()).paused, true, 'a late play result must not resume after exit');
  assert.equal(await page.evaluate(() => window.audioConstructorCount), 1);
  assert.equal(await page.locator('audio').count(), 1);

  await hoverAt(0, .2); await waitPlaying(2);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert.equal((await audio()).paused, true, 'window blur stops audition');
  await moveAway(); await hoverAt(0, .2); await waitPlaying(2);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal((await audio()).paused, true, 'hidden document stops audition');
  await page.evaluate(() => { delete document.hidden; });
  await moveAway(); await hoverAt(0, .2); await waitPlaying(2);
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
    source: { format: 'PCM WAV', duration, sampleRate, channels: 1 }, switches: 100, delayedRequests,
    playersCreated: await page.evaluate(() => window.audioConstructorCount),
    stressCount: 1200, distinctSources: 6, scrollMetrics,
    measurementScope: 'Synthetic 1200-card browser list reusing six WAV fixtures; rAF intervals are not native FPS or indexing measurements',
    mountedAtEnd: await page.locator('.audio-card').count(), mediaRequests: requests.filter(value => value.endsWith('.wav')).length }, null, 2));
  console.log('PASS: real audio clock/seek/autoplay fallback, delayed-source race, 100 switches, singleton player, exit/blur/hidden/unmount/scroll stop, 1200-item virtual list, cached peaks, no frontend decode, Range/path boundary');
} finally { await browser.close(); await preview.close(); }
