import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

// Real extension background/WS/SQLite, disposable native process; no user profile or library.
const root = resolve(`.tmp/video-extension-native/run-${Date.now()}`);
await mkdir(`${root}/appdata`, { recursive: true });
await mkdir(`${root}/localappdata`, { recursive: true });
await writeFile(`${root}/isolated-fixture`, 'No production setup or credentials');
const clip = await readFile('src-tauri/tests/fixtures/media/fragmented.mp4');
const image = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="red"/></svg>');
let storedVideo;
const http = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/image' ? 'image/svg+xml' : req.url === '/page' ? 'text/html' : 'video/mp4');
  res.end(req.url === '/image' ? image : req.url === '/page' ? '<!doctype html><video muted controls src="/stored"></video>' : req.url === '/stored' ? storedVideo : clip);
});
await new Promise(done => http.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${http.address().port}`;
const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const extensionOrigin = "chrome-extension://" + extensionId;
const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
const key = {
  privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey),
  publicKey: Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("hex"),
};
await writeFile(`${root}/fixture-pair.txt`, `${extensionId}.${key.publicKey}`);
const child = spawn(resolve('src-tauri/target/debug/examples/collect_video_smoke.exe'), [], {
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, APPDATA: `${root}/appdata`, LOCALAPPDATA: `${root}/localappdata`, BOWERBIRD_COLLECT_TEST_ROOT: root },
});
let output = '';
child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
const ended = new Promise((done, reject) => { child.once('exit', done); child.once('error', reject); });
let browser;
const waitFile = async name => {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    try { return JSON.parse(await readFile(`${root}/${name}`, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (child.exitCode !== null) throw new Error(`Native fixture exited ${child.exitCode}: ${output}`);
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error(`Native fixture did not produce ${name}: ${output}`);
};
try {
  const { url } = await waitFile('ready.json');
  let listener;
  const context = vm.createContext({ URL, TextEncoder, TextDecoder, crypto, Uint8Array, ArrayBuffer, AbortController, AbortSignal, console, setTimeout, clearTimeout,
    fetch: (input, options) => fetch(input === "http://127.0.0.1:39871/pairing-session" ? url.replace("ws:", "http:").replace("/ws", "/pairing-session") : input, options),
    WebSocket: class extends WebSocket { constructor(_, protocols) { super(url, {protocols, headers:{origin:extensionOrigin}}); } },
    chrome: { storage: { local: {setAccessLevel:async()=>{},get:async()=>({collectionKey:key})} }, runtime: { id:extensionId, onMessage: { addListener: callback => listener = callback } } },
  });
  context.importScripts = (...names) => names.forEach(name => vm.runInContext(readFileSync(resolve('../extension', name), 'utf8'), context));
  vm.runInContext(readFileSync('../extension/background.js', 'utf8'), context);
  const request = message => new Promise(done => { assert.equal(listener(message, {}, done), true); });
  const video = await request({ type: 'save_video', url: `${origin}/clip`, pageUrl: `${origin}/source`, candidateSource: 'video-element' });
  assert.equal(video.ok, true, JSON.stringify(video)); assert.equal(video.media_kind, 'video');
  const duplicate = await request({ type: 'save_video', url: `${origin}/clip`, pageUrl: `${origin}/another-source` });
  assert.equal(duplicate.asset_id, video.asset_id);
  const picture = await request({ type: 'save_image', url: `${origin}/image`, pageUrl: `${origin}/picture-source` });
  assert.equal(picture.ok, true, JSON.stringify(picture)); assert.notEqual(picture.asset_id, video.asset_id);
  const invalid = await context.BowerbirdCollection.uploadBytes(new TextEncoder().encode('<html>not video</html>').buffer,
    { media_kind: 'video', url: `${origin}/fake.mp4`, file_name: 'fake.mp4', content_type: 'video/mp4' });
  assert.equal(invalid.ok, false);
  const signed = await vm.runInContext('BowerbirdPairing.proof("'+extensionOrigin+'","extension")', context);
  const conflicting = await new Promise((done, reject) => {
    const socket = new WebSocket(url, {protocols:signed.protocols,headers:{origin:extensionOrigin}}), replies = [];
    const timeout = setTimeout(() => { socket.close(); reject(new Error('Conflicting metadata did not receive errors')); }, 5000);
    socket.onopen = () => {
      const metadata = JSON.stringify({ type: 'save_blob', media_kind: 'video', url: `${origin}/conflict`, byte_length: clip.length });
      socket.send(metadata); socket.send(metadata); socket.send(clip);
    };
    socket.onmessage = event => { replies.push(JSON.parse(event.data)); if (replies.length === 2) { clearTimeout(timeout); socket.close(); done(replies); } };
    socket.onerror = () => { clearTimeout(timeout); reject(new Error('Conflicting metadata socket failed')); };
  });
  assert.ok(conflicting.every(reply => reply.ok === false), 'ambiguous two-frame uploads cannot ingest into another item');
  await writeFile(`${root}/stop`, 'done');
  assert.equal(await ended, 0, output);
  const result = await waitFile('result.json');
  assert.equal(result.assets.length, 2); assert.equal(result.members.length, 2);
  const saved = result.assets.find(asset => asset.id === video.asset_id);
  assert.equal(saved.ext, 'mp4'); assert.ok(saved.width > 0 && saved.height > 0 && saved.duration > 0);
  assert.equal(saved.source, 'extension'); assert.equal(saved.source_url, `${origin}/source`);
  assert.ok(resolve(saved.store_path).startsWith(root));
  storedVideo = await readFile(saved.store_path); assert.deepEqual(storedVideo, clip);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage(); await page.goto(`${origin}/page`);
  await page.waitForFunction(() => document.querySelector('video').readyState >= 2);
  const playback = await page.evaluate(async () => { const video = document.querySelector('video'); await video.play(); return { width: video.videoWidth, height: video.videoHeight }; });
  await page.waitForFunction(() => document.querySelector('video').currentTime > 0.1);
  assert.equal(playback.width, saved.width); assert.equal(playback.height, saved.height);
  await writeFile(`${root}/verification.json`, JSON.stringify({ video, duplicate, picture, invalid, conflicting, playback, root }, null, 2));
  console.log('PASS real extension background -> native WS -> isolated SQLite/media -> playback; dedup/source preservation, image compatibility, spoofed-video rejection');
  console.log(root);
} finally {
  if (child.exitCode === null) child.kill();
  await writeFile(`${root}/native.log`, output);
  await browser?.close(); await new Promise(done => http.close(done));
}
