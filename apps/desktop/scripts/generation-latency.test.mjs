import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-accelerated-video-encode'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(new URL('./fixtures/generation-latency/index.html', import.meta.url).href);
  const field = (panel, name) => page.locator(`#${panel} [data-field="${name}"]`);
  assert.equal(await page.locator('#results tr').count(), 2);
  await page.locator('[name=caseId]').fill('fixture');
  await page.locator('[name=conditions]').fill('fixture inputs');
  for (const client of ['desktop', 'web']) {
    await field(client, 'version').fill('fixture');
    await field(client, 'evidence').fill('fixture recording');
    await field(client, 'submit').fill('5');
    await field(client, 'first').fill(client === 'desktop' ? '30' : '20');
    await field(client, 'original').fill('44');
  }
  assert.equal(await page.locator('#results tr').first().locator('td').last().innerText(), '10.00 秒');
  await field('web', 'original').fill('8');
  assert.match(await page.locator('#feedback').innerText(), /按提交/);
  await field('web', 'original').fill('');
  assert.match(await page.locator('#feedback').innerText(), /缺测/);
  await field('web', 'note').fill('fixture original unavailable');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#save').click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), 'generation-fixture-1.json');
  const report = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.equal(report.difference.firstSeconds, 10);
  assert.equal(report.difference.originalSeconds, null);
  assert.equal(report.conditions.originalEndpoint, '完整原图首次成功打开');

  // Exercise the local-file player with generated WebM frames.
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 64;
    document.body.append(canvas);
    const stream = canvas.captureStream(0);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks = [];
    recorder.ondataavailable = event => chunks.push(event.data);
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.start();
    const context = canvas.getContext('2d');
    for (let i = 0; i < 12; i++) {
      context.fillStyle = i % 2 === 0 ? 'white' : 'black';
      context.fillRect(0, 0, canvas.width, canvas.height);
      stream.getVideoTracks()[0].requestFrame();
      await new Promise(resolve => requestAnimationFrame(resolve));
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    recorder.stop();
    await stopped;
    for (const track of stream.getTracks()) track.stop();
    canvas.remove();
    return [...new Uint8Array(await new Blob(chunks).arrayBuffer())];
  });
  await page.locator('#desktop input[type=file]').setInputFiles({
    name: 'fixture.webm', mimeType: 'video/webm', buffer: Buffer.from(bytes),
  });
  await page.waitForFunction(() => document.querySelector('#desktop video').readyState >= 2);
  assert.equal(await field('desktop', 'first').inputValue(), '');
  await page.locator('#desktop button').first().click();
  assert.equal(Number(await field('desktop', 'submit').inputValue()), 0);
  assert.notEqual(await field('desktop', 'submit').inputValue(), '');
  await page.setViewportSize({ width: 375, height: 812 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  console.log('PASS generation timing records, pairing, missing observations, video marks and phone layout');
} finally {
  await browser.close();
}
