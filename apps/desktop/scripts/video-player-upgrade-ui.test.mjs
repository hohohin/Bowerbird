import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const directory = '.tmp/video-upgrade/player';
await mkdir(directory, { recursive: true });
const ffmpeg = process.env.BOWERBIRD_FFMPEG_BINARY || resolve('../../.tmp/video-integration/tools/local/ffmpeg.exe');
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=lime:s=180x320:r=25:d=2',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${directory}/portrait.mp4`]);
await writeFile(`${directory}/index.html`, '<html><meta charset="utf-8"><div id="root"></div><script type="module" src="./fixture.tsx"></script></html>');
await writeFile(`${directory}/fixture.tsx`, `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Lightbox } from '/src/components/Lightbox';
import { VideoPlayer } from '/src/components/VideoPlayer';
import '/src/styles.css';
const w = window as any;
w.__TAURI_INTERNALS__ = { convertFileSrc: (path: string) => path, invoke: async () => null };
w.decodes = 0; w.frames = []; w.canvasFrames = [];
const create = document.createElement.bind(document);
document.createElement = ((tag: string, options?: ElementCreationOptions) => {
  const element = create(tag, options);
  if (tag === 'video') element.addEventListener('loadeddata', () => { if (!element.isConnected) w.decodes++; });
  return element;
}) as typeof document.createElement;
function Fixture() {
  const [open, setOpen] = useState(true), [revision, setRevision] = useState('initial'), [index, setIndex] = useState(0);
  const [embedded, setEmbedded] = useState(false);
  w.setRevision = setRevision; w.setEmbedded = setEmbedded;
  const path = '/${directory}/portrait.mp4';
  return <><input aria-label="外部输入"/><button onClick={() => setOpen(true)}>打开视频</button>
    <output aria-label="素材索引">{index}</output>
    {open && (embedded ? <div style={{ width: 420, height: 600 }}><VideoPlayer key={revision} path={path} sourceKey={revision} embedded fitContainer showTrim frameTarget="library" onAddFrame={async frame => { w.frames.push(frame); }}/></div>
      : <Lightbox images={[path, path + '?second']} index={index} onIndexChange={setIndex} onClose={() => setOpen(false)} videoSourceKey={revision} videoFrameTarget="library" onAddVideoFrame={async frame => { w.frames.push(frame); }} onAddFrameToCanvas={async frame => { w.canvasFrames.push(frame); }}/>)}</>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Fixture/></React.StrictMode>);
`);
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: `${directory}/vite`, optimizeDeps: { entries: [`${directory}/index.html`] },
  server: { host: '127.0.0.1', port: 1664, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const video = page.locator('.video-player video');
const ready = () => page.waitForFunction(() => document.querySelector('.video-player video')?.readyState >= 2);
const strip = () => page.waitForFunction(() => document.querySelectorAll('.video-player-film img').length === 12);
try {
  await page.goto(`http://127.0.0.1:1664/${directory}/index.html`); await ready();
  // Actual media properties change, not just labels.
  const volume = page.getByRole('slider', { name: '音量', exact: true });
  assert.equal(await volume.count(), 1, 'volume control must be available');
  await volume.fill('0.35');
  assert.equal(await video.evaluate(v => v.volume), 0.35);
  await page.getByRole('button', { name: '静音', exact: true }).click();
  assert.equal(await video.evaluate(v => v.muted), true);
  await page.getByRole('button', { name: '取消静音', exact: true }).click();
  assert.equal(await video.evaluate(v => v.volume), 0.35);
  await page.getByRole('combobox', { name: '播放速度' }).selectOption('1.5');
  assert.equal(await video.evaluate(v => v.playbackRate), 1.5);
  await page.getByRole('button', { name: '全屏', exact: true }).click();
  await page.waitForFunction(() => document.fullscreenElement?.classList.contains('video-player'));
  await page.getByRole('button', { name: '退出全屏', exact: true }).click();
  await page.waitForFunction(() => !document.fullscreenElement);
  // Arrow keys seek the active player; explicit navigation buttons still change media.
  await page.getByRole('button', { name: '播放', exact: true }).focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('output[aria-label="素材索引"]').textContent(), '0');
  await page.waitForFunction(() => document.querySelector('.video-player video').currentTime > 0);
  await page.getByRole('button', { name: /下一/ }).click();
  assert.equal(await page.locator('output[aria-label="素材索引"]').textContent(), '1');
  await page.getByRole('button', { name: /上一/ }).click(); await ready();
  // Portrait thumbnails preserve the source ratio; reopening uses a bounded revision-aware cache.
  await strip();
  assert.ok(await page.locator('.video-player-film img').first().evaluate(img => Math.abs(img.naturalWidth / img.naturalHeight - 180 / 320) < 0.01));
  const decoded = await page.evaluate(() => window.decodes);
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: '打开视频' }).click(); await ready(); await strip();
  assert.equal(await page.evaluate(() => window.decodes), decoded, 'reopening unchanged media must reuse the filmstrip');
  await page.evaluate(async () => {
    const { invalidateVideoStrip } = await import('/src/lib/videoFrame.ts');
    invalidateVideoStrip('/.tmp/video-upgrade/player/portrait.mp4');
  });
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: '打开视频' }).click(); await ready(); await strip();
  assert.ok(await page.evaluate(before => window.decodes > before, decoded), 'source replacement invalidation must retire all cached revisions');
  await page.evaluate(() => window.setRevision('changed')); await ready(); await strip();
  await page.waitForFunction(before => window.decodes > before, decoded);
  const revisionDecoded = await page.evaluate(() => window.decodes);
  // LRU keeps recent revisions, but does not retain an unlimited video library in memory.
  for (let n = 0; n < 17; n++) {
    await page.evaluate(n => window.setRevision('revision-' + n), n); await ready(); await strip();
  }
  assert.ok(await page.evaluate(before => window.decodes >= before + 17, revisionDecoded));
  const afterFill = await page.evaluate(() => window.decodes);
  await page.evaluate(() => window.setRevision('changed')); await ready(); await strip();
  assert.ok(await page.evaluate(before => window.decodes > before, afterFill), 'an evicted revision must decode again');
  // Library frame capture remains full resolution and never calls a default importer.
  await page.getByRole('button', { name: '保存该帧到素材库', exact: true }).click();
  await page.getByRole('button', { name: '已保存到素材库', exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(async () => { const img = new Image(); img.src = window.frames[0].dataUrl; await img.decode(); return [img.width, img.height]; }), [180, 320]);
  assert.equal(await page.getByRole('button', { name: '添加该帧到画板', exact: true }).count(), 1, 'library and canvas are independent frame destinations');
  await page.getByRole('button', { name: '添加该帧到画板', exact: true }).click();
  await page.getByRole('button', { name: '已添加到画板', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.canvasFrames.length), 1);
  // Native media faults are injected at the browser boundary; UI must keep raw detail out of normal text.
  await volume.fill('0.35');
  await page.getByRole('combobox', { name: '播放速度' }).selectOption('1.5');
  await video.evaluate(v => { Object.defineProperty(v, 'error', { configurable: true, value: { code: 3, message: 'decoder-private-diagnostic' } }); v.dispatchEvent(new Event('error')); });
  assert.match(await page.getByRole('alert').textContent(), /解码|编码/);
  assert.doesNotMatch(await page.getByRole('alert').textContent(), /decoder-private/);
  await page.getByRole('button', { name: '重新加载视频', exact: true }).click(); await ready();
  await page.waitForFunction(() => !document.querySelector('.video-player-error'));
  assert.equal(await video.evaluate(v => v.volume), 0.35, 'retry preserves volume');
  assert.equal(await video.evaluate(v => v.playbackRate), 1.5, 'retry preserves speed');
  // A genuine failed media request is recoverable without closing the modal or creating assets.
  await page.route('**/portrait.mp4*', route => route.fulfill({ status: 404, body: '' }));
  await page.evaluate(() => window.setRevision('missing-source'));
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /格式|访问|读取|加载/);
  await page.unroute('**/portrait.mp4*');
  await page.getByRole('button', { name: '重新加载视频', exact: true }).click(); await ready();
  assert.equal(await page.evaluate(() => window.frames.length), 1, 'media recovery must not save or duplicate frames');
  await video.evaluate(v => v.dispatchEvent(new Event('waiting')));
  await page.getByRole('status').filter({ hasText: '正在缓冲' }).waitFor();
  await video.evaluate(v => v.dispatchEvent(new Event('canplay')));
  assert.equal(await page.getByText('正在缓冲…').count(), 0);
  // Embedded controls cannot steal typing from another editor.
  await page.evaluate(() => window.setEmbedded(true)); await ready();
  await page.getByRole('textbox', { name: '外部输入' }).focus(); await page.keyboard.press('Space');
  assert.equal(await page.getByRole('textbox', { name: '外部输入' }).inputValue(), ' ');
  assert.equal(await video.evaluate(v => v.paused), true);
  assert.equal(await page.getByRole('button', { name: '裁剪视频' }).count(), 1);
  await page.getByRole('slider', { name: '音量', exact: true }).focus(); await page.keyboard.press('ArrowLeft');
  assert.equal(await video.evaluate(v => v.currentTime), 0, 'volume slider arrows do not seek the media');
  assert.ok(await video.evaluate(v => {
    const screen = v.parentElement.getBoundingClientRect(), picture = v.getBoundingClientRect();
    return picture.top >= screen.top - 1 && picture.bottom <= screen.bottom + 1;
  }), 'embedded video must fit the screen without clipping its portrait pixels');
  await page.screenshot({ path: `${directory}/embedded.png` });
  assert.deepEqual(errors, []);
  console.log('PASS player controls, keyboard ownership, full screen, strip ratio/cache/revision, library frame, recovery, embedded scope');
} finally { await browser.close(); await server.close(); }
