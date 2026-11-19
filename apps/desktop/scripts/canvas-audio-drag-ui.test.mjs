import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const output = '.tmp/canvas-audio-drag';
await mkdir(output, { recursive: true });
const rate = 16000, duration = 12, frames = rate * duration;
const pcm = Buffer.alloc(44 + frames * 2);
pcm.write('RIFF'); pcm.writeUInt32LE(pcm.length - 8, 4); pcm.write('WAVEfmt ', 8);
pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
pcm.writeUInt32LE(rate, 24); pcm.writeUInt32LE(rate * 2, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34);
pcm.write('data', 36); pcm.writeUInt32LE(frames * 2, 40);
for (let i = 0; i < frames; i++) pcm.writeInt16LE(Math.round(Math.sin(i / rate * 440 * Math.PI * 2) * 500), 44 + i * 2);
await writeFile(`${output}/tone.wav`, pcm);
const server = await createServer({ cacheDir: `${output}/vite`, server: { host: '127.0.0.1', port: 17942, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
  let bridge;
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    get: () => bridge,
    set: value => {
      const invoke = value.invoke;
      value.invoke = async (command, args) => {
        if (command !== 'audio_waveform') return invoke(command, args);
        if (sessionStorage.getItem('hold-audio-waveform')) await new Promise(resolve => { window.releaseWaveform = resolve; });
        return { sourceVersion: 'fixture-audio', duration: 12, sampleRate: 16000, channels: 1,
          totalFrames: 192000, framesPerPeak: 1920, peaks: Array.from({ length: 100 }, () => [-.04, .04]) };
      };
      bridge = value;
    },
  });
});
const card = id => page.locator(`[data-canvas-node-id="${id}"]`);
const wave = () => card('audio').locator('.audio-waveform-wave');
const geometry = id => page.evaluate(id => {
  const { x, y } = window.snapshot().nodes.find(node => node.id === id); return { x, y };
}, id);
async function drag(dx, dy, cancel = false) {
  const box = await wave().boundingBox();
  const x = box.x + box.width * .5, y = box.y + box.height * .5;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  if (cancel) await wave().dispatchEvent('pointercancel', { pointerId: 1, bubbles: true });
  await page.mouse.up();
}
try {
  await page.goto('http://127.0.0.1:17942/scripts/fixtures/canvas-reference/preview.html');
  await card('old').waitFor();
  await page.evaluate(() => {
    const snapshot = window.snapshot(), base = snapshot.nodes[0];
    const asset = { id: 'audio-asset', name: '合成音频', ext: 'wav', source: 'imported',
      store_path: `${location.origin}/.tmp/canvas-audio-drag/tone.wav`, width: 0, height: 0 };
    sessionStorage.setItem('reference-drafts', JSON.stringify([asset]));
    snapshot.nodes = [{ ...base, id: 'audio', assetId: asset.id, x: 300, y: 200, width: 300, height: 180,
      payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: asset.name, storePath: asset.store_path } }) },
      { ...base, id: 'image', x: 850, y: 200 }];
    snapshot.edges = []; snapshot.view = { ...snapshot.view, panX: 0, panY: 0, zoom: 1 };
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
    sessionStorage.setItem('hold-audio-waveform', '1');
  });
  await page.reload(); await wave().waitFor();
  const snap = page.getByRole('button', { name: '吸附对齐', exact: true });
  if (await snap.getAttribute('aria-pressed') === 'true') await snap.click();
  const initial = await geometry('audio');
  await drag(100, 70);
  await page.waitForFunction(() => window.snapshot().nodes.find(node => node.id === 'audio').x !== 300);
  assert.deepEqual(await geometry('audio'), { x: initial.x + 100, y: initial.y + 70 }, 'waveform drags before loading');
  await page.evaluate(() => { sessionStorage.removeItem('hold-audio-waveform'); window.releaseWaveform(); });
  await card('audio').locator('[data-wave-ready="true"]').waitFor();
  await drag(80, 50);
  const moved = await geometry('audio');
  assert.deepEqual(moved, { x: initial.x + 180, y: initial.y + 120 });
  assert.equal(await page.locator('audio[data-audio-preview]').count(), 0, 'drag never starts playback');

  await wave().click({ position: { x: 120, y: 80 } });
  await page.waitForFunction(() => { const a = document.querySelector('audio[data-audio-preview]'); return a && !a.paused && a.currentTime > 4; });
  assert.deepEqual(await geometry('audio'), moved, 'click seeks without moving');
  await page.mouse.move(20, 20);
  await page.waitForFunction(() => document.querySelector('audio[data-audio-preview]').paused);
  await card('audio').locator('.audio-waveform-play').click();
  await page.waitForFunction(() => !document.querySelector('audio[data-audio-preview]').paused);
  await drag(-40, 60);
  await page.mouse.move(20, 20);
  assert.equal(await page.locator('audio[data-audio-preview]').evaluate(a => a.paused), false, 'continuous playback survives dragging');
  await card('audio').locator('.audio-waveform-play').click();
  assert.deepEqual(await geometry('audio'), { x: moved.x - 40, y: moved.y + 60 });

  const beforeCancel = await geometry('audio');
  await drag(50, -40, true);
  assert.deepEqual(await geometry('audio'), beforeCancel, 'cancel rolls back movement');
  assert.equal(await page.locator('audio[data-audio-preview]').evaluate(a => a.paused), true);
  await card('audio').locator('.audio-waveform-play').click();
  await page.waitForFunction(() => !document.querySelector('audio[data-audio-preview]').paused);
  await card('audio').locator('.audio-waveform-play').click();

  await wave().click({ modifiers: ['Control'] });
  await card('image').click({ modifiers: ['Control'], position: { x: 60, y: 60 } });
  assert.equal(await page.locator('.canvas-node.is-selected').count(), 2);
  const beforeAudio = await geometry('audio'), beforeImage = await geometry('image');
  await drag(35, 45);
  assert.deepEqual(await geometry('audio'), { x: beforeAudio.x + 35, y: beforeAudio.y + 45 });
  assert.deepEqual(await geometry('image'), { x: beforeImage.x + 35, y: beforeImage.y + 45 });
  assert.equal(await page.locator('audio[data-audio-preview]').evaluate(a => a.paused), true, 'selection does not audition');
  await page.keyboard.press('Control+z');
  await page.waitForFunction(x => window.snapshot().nodes.find(n => n.id === 'audio').x === x, beforeAudio.x);
  assert.deepEqual(await geometry('image'), beforeImage, 'undo restores both cards');
  const beforePan = await card('audio').boundingBox();
  await page.keyboard.down('Space'); await drag(60, 30); await page.keyboard.up('Space');
  const afterPan = await card('audio').boundingBox();
  assert.ok(Math.abs(afterPan.x - beforePan.x - 60) < 1 && Math.abs(afterPan.y - beforePan.y - 30) < 1, 'space drag pans from the waveform');
  assert.deepEqual(await geometry('audio'), beforeAudio, 'pan does not move the card');
  assert.equal(await page.locator('audio[data-audio-preview]').evaluate(a => a.paused), true, 'pan does not audition');
  await page.evaluate(() => sessionStorage.setItem('reference-fixture', JSON.stringify(window.snapshot())));
  await page.reload(); await wave().waitFor();
  assert.deepEqual(await geometry('audio'), beforeAudio, 'saved position survives reload');
  await page.screenshot({ path: `${output}/canvas.png` });
  assert.deepEqual(errors, []);
  console.log('Canvas audio: loading/ready drag, click seek, playback, cancel, multi-select, undo and reload passed.');
} finally {
  await browser.close(); await server.close();
}
