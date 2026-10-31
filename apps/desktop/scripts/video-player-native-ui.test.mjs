import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createServer } from 'vite';

const directory = '.tmp/video-upgrade/native';
const root = resolve(`${directory}/run-${Date.now()}`);
await mkdir(root, { recursive: true });
await mkdir(`${root}/appdata`, { recursive: true });
await mkdir(`${root}/localappdata`, { recursive: true });
const ffmpeg = process.env.BOWERBIRD_FFMPEG_BINARY || resolve('../../.tmp/video-integration/tools/local/ffmpeg.exe');
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=red:s=320x180:r=25:d=4',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${directory}/clip.mp4`]);
await writeFile(`${directory}/index.html`, '<html><meta charset="utf-8"><div id="root"></div><script type="module" src="./fixture.tsx"></script></html>');
await writeFile(`${directory}/core-shim.ts`, 'export { Channel } from "/node_modules/@tauri-apps/api/core.js"; export function convertFileSrc(path: string) { return path; } export async function invoke() { throw new Error("Native IPC is not part of this isolated player fixture"); }');
await writeFile(`${directory}/fixture.tsx`, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { VideoPlayer } from '/src/components/VideoPlayer';
import '/src/styles.css';
import '/src/components/MediaTactical.css';
import '/src/components/IndustrialTheme.css';
const reactRoot = createRoot(document.getElementById('root')!);
let saved: any;
reactRoot.render(<React.StrictMode><VideoPlayer path="/${directory}/clip.mp4" frameTarget="library" onAddFrame={async frame => { saved = frame; }}/></React.StrictMode>);
const results: Record<string, unknown> = { nativeWebView: true, userAgent: navigator.userAgent };
const wait = async (check: () => unknown) => {
  const deadline = Date.now() + 15000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Timed out: ' + check.toString()); await new Promise(r => setTimeout(r, 50)); }
};
const button = (name: string) => [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === name || b.textContent === name)!;
const pixels = (source: CanvasImageSource, width: number, height: number) => {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d')!; context.drawImage(source, 0, 0);
  return [...context.getImageData(width / 2, height / 2, 1, 1).data];
};
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
(async () => {
  try {
    await wait(() => document.querySelector<HTMLVideoElement>('.video-player video')?.readyState! >= 2);
    const video = document.querySelector<HTMLVideoElement>('.video-player video')!;
    results.firstFrame = { width: video.videoWidth, height: video.videoHeight, pixel: pixels(video, 320, 180), paused: video.paused };
    check(video.paused, 'first frame must remain paused');
    check((results.firstFrame as any).pixel[0] > 220 && (results.firstFrame as any).pixel[1] < 30, 'first frame pixels must decode red');
    button('静音').click(); // Hidden native view: silent playback satisfies the actual browser autoplay contract.
    button('播放').click();
    await wait(() => video.currentTime >= 0.25 && !video.paused);
    results.playingTime = video.currentTime;
    button('暂停').click(); await wait(() => video.paused);
    results.paused = video.paused;
    await wait(() => !button('保存该帧到素材库').disabled);
    button('保存该帧到素材库').click(); await wait(() => saved);
    const image = new Image(); image.src = saved.dataUrl; await image.decode();
    results.capture = { width: image.width, height: image.height, pixel: pixels(image, image.width, image.height), time: saved.time };
    check(image.width === 320 && image.height === 180, 'capture must retain original resolution');
    check((results.capture as any).pixel[0] > 220 && (results.capture as any).pixel[1] < 30, 'captured pixels must match native decoded frame');
    reactRoot.unmount();
    await wait(() => !video.getAttribute('src') && video.paused && !document.querySelector('.video-player'));
    results.released = { src: video.getAttribute('src'), paused: video.paused, connected: video.isConnected };
    results.success = true;
  } catch (error) {
    results.success = false; results.error = String(error);
    results.body = document.body.innerText;
    results.media = [...document.querySelectorAll('video')].map(v => ({ src: v.src, currentSrc: v.currentSrc, readyState: v.readyState, networkState: v.networkState, error: v.error && { code: v.error.code, message: v.error.message } }));
  }
  location.href = 'bb-player-result://result?payload=' + encodeURIComponent(JSON.stringify(results));
})();
`);
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: `${directory}/vite`,
  optimizeDeps: { entries: [`${directory}/index.html`], exclude: ['@tauri-apps/api/core'] },
  resolve: { alias: [{ find: /^@tauri-apps\/api\/core$/, replacement: resolve(`${directory}/core-shim.ts`) }] },
  server: { host: '127.0.0.1', port: 1668, strictPort: true, hmr: false, watch: null } });
await server.listen();
const child = spawn(resolve('src-tauri/target/debug/examples/video_player_smoke.exe'), [], { windowsHide: true,
  env: { ...process.env, APPDATA: `${root}/appdata`, LOCALAPPDATA: `${root}/localappdata`, BOWERBIRD_PLAYER_TEST_ROOT: root,
    BOWERBIRD_PLAYER_TEST_URL: `http://127.0.0.1:1668/${directory}/index.html` }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
const timer = setTimeout(() => child.kill(), 80000);
try {
  const exitCode = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  await writeFile(`${root}/native.log`, output);
  const result = JSON.parse(await readFile(`${root}/result.json`, 'utf8'));
  console.log(JSON.stringify({ root, exitCode, ...result }, null, 2));
  assert.equal(exitCode, 0); assert.equal(result.success, true, result.error);
  console.log('PASS native Windows WebView2 first-frame decoding, playback, pause, original-size frame capture and source release');
} finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); await server.close(); }
