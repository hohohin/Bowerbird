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
  await page.getByRole('button', { name: '切换为浅色' }).click();
  await page.screenshot({ path: `${output}/audio-fixtures-light.png` });
  const manifest = await page.evaluate(async () => (await fetch('/audio-fixtures/manifest.json')).json());
  const durations = await page.locator('.audio-duration').allTextContents();
  for (const [index, item] of manifest.entries()) if (item.duration >= 3600) assert.match(durations[index], /^\d+:\d\d:\d\d$/);
  assert.deepEqual(errors, []);
  await writeFile(`${output}/capture.json`, JSON.stringify({ browser: await browser.version(), viewport: { width: 1440, height: 900 },
    files: manifest.map((item, index) => ({ id: item.id, name: item.name, duration: item.duration, displayedDuration: durations[index] })),
    normalization: 'Per-file peak amplitude, display only, not loudness comparison or playback gain' }, null, 2));
  console.log('PASS: six actual fixture waveforms, dark/light captures, hour formatting');
} finally { await browser.close(); await preview?.close(); }
