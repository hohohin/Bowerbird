// Production conversation panel, synthetic IPC and a synthetic local MP4 only.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
await mkdir('.tmp/chat-video-ui', {recursive:true});
execFileSync(process.env.BOWERBIRD_FFMPEG_BINARY || resolve('../../.tmp/video-integration/tools/local/ffmpeg.exe'),
  ['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=teal:s=320x180:r=25:d=2','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart','.tmp/chat-video-ui/result.mp4'], {windowsHide:true});
const { chromium } = await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE || '../../html-renderer/node_modules/playwright/index.mjs');
const server = await createServer({ cacheDir: '.tmp/chat-video-ui/vite', server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 960 } });
const failures = []; page.on('pageerror', error => failures.push(error.message));
const url = `http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/local-chat-video/preview.html`;
try {
  await page.goto(url);
  await page.locator('.local-chat-panel').waitFor();
  await page.evaluate(async () => {
    const data = JSON.parse(sessionStorage.getItem('bowerbird-local-chat-fixture-v1'));
    const chat = Object.values(data.conversations)[0];
    chat.messages.push({id:'native-video',turnId:chat.messages[0].turnId,role:'tool',text:'视频已完成',referenceAssetIds:['video-output'],status:'done',createdAt:Date.now(),updatedAt:Date.now()});
    chat.revision++;
    sessionStorage.setItem('bowerbird-local-chat-fixture-v1',JSON.stringify(data));
  });
  await page.reload();
  const result = page.locator('.local-chat-video');
  await result.locator('video').waitFor();
  await page.waitForFunction(() => document.querySelector('.local-chat-video video')?.readyState >= 2);
  assert.equal(await result.getAttribute('data-chat-video-status'), 'done');
  await result.locator('video').evaluate(video => video.play());
  await page.waitForFunction(() => document.querySelector('.local-chat-video video')?.currentTime > 0);
  await result.locator('video').evaluate(video => video.pause());
  await page.reload();
  await result.locator('video').waitFor();
  assert.equal(await result.count(), 1, 'reload preserves one delivered video');
  assert.deepEqual(failures, []);
  console.log('PASS chat video survives reload, plays inline and preserves the conversation');
} catch (error) { console.error(failures, await page.locator('body').innerText()); throw error; } finally { await browser.close(); await server.close(); }
