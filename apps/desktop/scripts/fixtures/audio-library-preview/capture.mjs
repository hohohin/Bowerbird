import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../../html-renderer/node_modules/playwright/index.mjs';
import { createPreviewServer } from './server.mjs';

const output = fileURLToPath(new URL('../../../.tmp/audio-preview-ui/', import.meta.url));
await mkdir(output, { recursive: true });
const preview = process.env.AUDIO_PREVIEW_URL ? null : await createPreviewServer({ port: 0 });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(process.env.AUDIO_PREVIEW_URL || preview.url);
  await page.waitForFunction(() => document.querySelectorAll('.audio-card[data-wave-ready="true"]').length === 6);
  await page.screenshot({ path: `${output}/audio-fixtures-dark.png` });
  await page.locator('.audio-play').first().click();
  await page.waitForFunction(() => !document.querySelector('audio').paused && document.querySelector('audio').currentTime > .05);
  const continuousStart = await page.locator('audio').evaluate(element => element.currentTime);
  await page.mouse.move(100, 30); await page.waitForTimeout(200);
  assert.equal(await page.locator('audio').evaluate(element => element.paused), false, 'button playback continues with the pointer in the title area');
  assert.ok(await page.locator('audio').evaluate(element => element.currentTime) > continuousStart + .1, 'continuous capture reflects a real advancing media clock');
  await page.screenshot({ path: `${output}/audio-fixtures-continuous-dark.png` });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('audio').evaluate(element => element.paused), true, 'capture explicitly stops its playback');
  const captureHover = async theme => {
    const waveform = page.locator('.audio-wave').nth(1);
    const rect = await waveform.boundingBox();
    await page.mouse.move(rect.x + rect.width * .62, rect.y + rect.height / 2);
    await page.waitForTimeout(150);
    assert.equal(await page.locator('audio').getAttribute('src'), null, 'hover capture never loads original audio');
    assert.equal(await page.locator('audio').evaluate(element => element.paused), true);
    const cursor = page.locator('.audio-card').nth(1).locator('.wave-hover-cursor');
    assert.ok(await cursor.evaluate(element => Number(getComputedStyle(element).opacity) > 0), 'hover cursor is visible in the capture');
    await page.screenshot({ path: `${output}/audio-fixtures-hover-${theme}.png` });
    await page.mouse.move(10, 10);
  };
  await captureHover('dark');
  await page.getByRole('button', { name: '切换为浅色' }).click();
  await page.screenshot({ path: `${output}/audio-fixtures-light.png` });
  await captureHover('light');
  const manifest = await page.evaluate(async () => (await fetch('/audio-fixtures/manifest.json')).json());
  const durations = await page.locator('.audio-duration').allTextContents();
  for (const [index, item] of manifest.entries()) if (item.duration >= 3600) assert.match(durations[index], /^\d+:\d\d:\d\d$/);
  assert.deepEqual(errors, []);
  await writeFile(`${output}/capture.json`, JSON.stringify({ browser: await browser.version(), viewport: { width: 1440, height: 900 },
    files: manifest.map((item, index) => ({ id: item.id, name: item.name, duration: item.duration, displayedDuration: durations[index] })),
    interaction: 'Hover only shows pointer position and time; waveform click temporarily auditions; separate zero-start play button continues outside the preview',
    normalization: 'Per-file peak amplitude, display only, not loudness comparison or playback gain' }, null, 2));
  console.log('PASS: real continuous playback outside preview, explicit stop, six waveform dark/light + silent hover-cursor captures, hour formatting');
} finally { await browser.close(); await preview?.close(); }
