import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { createReadStream, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import vm from 'node:vm';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

// Real extension background/WS/SQLite, disposable native process; no user profile or library.
const root = resolve(`.tmp/video-extension-native/run-${Date.now()}`);
await mkdir(`${root}/appdata`, { recursive: true });
await mkdir(`${root}/localappdata`, { recursive: true });
await writeFile(`${root}/isolated-fixture`, 'No production setup or credentials');
const clip = await readFile('src-tauri/tests/fixtures/media/fragmented.mp4');
const heic = await readFile('src-tauri/tests/fixtures/heic/rgb-strips-96.heic');
const image = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="red"/></svg>');
const chunkSize = 1024 * 1024;
const largeSize = 200 * chunkSize;
const freeBoxHeader = Buffer.alloc(8);
freeBoxHeader.writeUInt32BE(largeSize - clip.length);
freeBoxHeader.write("free", 4);
const zeros = Buffer.alloc(chunkSize);
function* largeVideo() {
  yield clip;
  yield freeBoxHeader;
  for (let size = largeSize - clip.length - freeBoxHeader.length; size > 0; size -= chunkSize) {
    yield zeros.subarray(0, Math.min(chunkSize, size));
  }
}
let storedVideo;
const http = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/image' ? 'image/svg+xml' : req.url === '/heic' ? 'application/octet-stream' : req.url === '/page' ? 'text/html' : 'video/mp4');
  if (req.url === '/large') {
    Readable.from(largeVideo()).pipe(res);
    return;
  }
  res.end(req.url === '/image' ? image : req.url === '/heic' ? heic : req.url === '/page' ? '<!doctype html><video muted controls src="/stored"></video>' : req.url === '/stored' ? storedVideo : clip);
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
  const listeners = [];
  const manifest = JSON.parse(readFileSync('../extension/manifest.json', 'utf8'));
  let maxFrame = 0, frames = 0;
  const context = vm.createContext({ URL, TextEncoder, TextDecoder, crypto, Uint8Array, ArrayBuffer, AbortController, AbortSignal, console, setTimeout, clearTimeout, performance,
    fetch: (input, options) => fetch(input === "http://127.0.0.1:39871/pairing-session" ? url.replace("ws:", "http:").replace("/ws", "/pairing-session") : input, options),
    WebSocket: class extends WebSocket {
      constructor(_, protocols) { super(url, {protocols, headers:{origin:extensionOrigin}}); }
      send(data) {
        if (typeof data !== "string") { maxFrame = Math.max(maxFrame, data.byteLength); frames += 1; }
        super.send(data);
      }
    },
    chrome: {
      storage: { local: {setAccessLevel:async()=>{},get:async()=>({collectionKey:key})}, onChanged: { addListener() {} } },
      runtime: { id:extensionId, getManifest: () => manifest, onMessage: { addListener: callback => listeners.push(callback) } },
    },
  });
  context.importScripts = (...names) => names.forEach(name => vm.runInContext(readFileSync(resolve('../extension', name), 'utf8'), context));
  vm.runInContext(readFileSync('../extension/background.js', 'utf8'), context);
  const request = message => new Promise(done => {
    assert.ok(listeners.some(listener => listener(message, {id:extensionId, tab:{id:1}}, done)));
  });
  assert.equal((await context.BowerbirdCollection.currentProject()).name, "Fixture");
  async function assertVersion(reported, update_required) {
    const expected = { connected:true, version:{ reported, expected:manifest.version, update_required } };
    for (let lapsed = 0; lapsed < 1000; lapsed += 50) {
      const actual = await waitFile('status.json');
      if (actual.version && actual.version.reported === reported) {
        assert.deepEqual(actual, expected);
        return;
      }
      await new Promise(done => setTimeout(done, 50));
    }
    assert.deepEqual(await waitFile('status.json'), expected);
  }
  for (const reported of [undefined, "0.5.2"]) {
    const access = await context.BowerbirdCollection.socketAccess();
    const client = new WebSocket(url, {protocols:access.protocols,headers:{origin:extensionOrigin}});
    const pong = await new Promise((done, reject) => {
      client.onopen = () => client.send(JSON.stringify({ type: "ping", extension_version: reported }));
      client.onmessage = event => { client.close(); done(JSON.parse(event.data)); };
      client.onerror = reject;
    });
    assert.equal(pong.pong, true, "old pings still work");
    await assertVersion(reported ?? null, true);
  }
  const ping = await request({ type: 'collect_heartbeat' });
  assert.equal(ping.streamUpload, true);
  await assertVersion(manifest.version, false);
  const video = await request({ type: 'save_video', url: `${origin}/clip`, pageUrl: `${origin}/source`, candidateSource: 'video-element' });
  assert.equal(video.ok, true, JSON.stringify(video)); assert.equal(video.media_kind, 'video');
  const duplicate = await request({ type: 'save_video', url: `${origin}/clip`, pageUrl: `${origin}/another-source` });
  assert.equal(duplicate.asset_id, video.asset_id);
  const legacy = await context.BowerbirdCollection.uploadBytes(clip, {
    media_kind: 'video', url: `${origin}/clip`, file_name: 'video.mp4',
  });
  assert.equal(legacy.asset_id, video.asset_id, 'legacy single-frame upload remains supported');
  frames = maxFrame = 0;
  const large = await request({ type: 'save_video', url: `${origin}/large`, pageUrl: `${origin}/large-source` });
  assert.equal(large.ok, true, JSON.stringify(large));
  assert.equal(frames, 200);
  assert.equal(maxFrame, chunkSize);
  const picture = await request({ type: 'save_image', url: `${origin}/image`, pageUrl: `${origin}/picture-source` });
  assert.equal(picture.ok, true, JSON.stringify(picture)); assert.notEqual(picture.asset_id, video.asset_id);
  const heicPicture = await request({ type: 'save_image', url: `${origin}/heic`, pageUrl: `${origin}/heic-source` });
  assert.equal(heicPicture.ok, true, JSON.stringify(heicPicture));
  const pictureAccess = await context.BowerbirdCollection.socketAccess();
  const ordered = await new Promise((done, reject) => {
    const socket = new WebSocket(url, {protocols:pictureAccess.protocols,headers:{origin:extensionOrigin}});
    const replies = [];
    const timeout = setTimeout(() => { socket.close(); reject(new Error("Missing ordered image receipts")); }, 5000);
    socket.onopen = () => {
      const metadata = JSON.stringify({
        type: "save_blob", url: `${origin}/image`, page_url: `${origin}/picture-source`, content_type: "image/svg+xml",
      });
      socket.send(metadata);
      socket.send(Buffer.from("not an image"));
      socket.send(metadata);
      socket.send(image);
    };
    socket.onmessage = event => {
      replies.push(JSON.parse(event.data));
      if (replies.length === 2) { clearTimeout(timeout); socket.close(); done(replies); }
    };
    socket.onerror = error => { clearTimeout(timeout); reject(error); };
  });
  assert.equal(ordered[0].ok, false);
  assert.equal(ordered[1].asset_id, picture.asset_id, "an image error keeps the connection and next receipt in order");
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
  const abruptAccess = await context.BowerbirdCollection.socketAccess();
  const interrupted = new WebSocket(url, {protocols:abruptAccess.protocols,headers:{origin:extensionOrigin}});
  await new Promise((done, reject) => {
    interrupted.onopen = () => interrupted.send(JSON.stringify({
      type: 'save_blob_start', media_kind: 'video', url: `${origin}/interrupted`,
    }));
    interrupted.onerror = reject;
    interrupted.onmessage = event => {
      const reply = JSON.parse(event.data);
      assert.equal(reply.ok, true);
      if (reply.received === 0) interrupted.send(clip);
      else { assert.equal(reply.received, clip.byteLength); interrupted.close(); done(); }
    };
  });
  let temporary;
  for (let attempt = 0; attempt < 20; attempt++) {
    temporary = await readdir(`${root}/extension-uploads`);
    if (!temporary.length) break;
    await new Promise(done => setTimeout(done, 50));
  }
  assert.deepEqual(temporary, [], 'disconnected stream removes its staging file');
  await writeFile(`${root}/stop`, 'done');
  assert.equal(await ended, 0, output);
  const result = await waitFile('result.json');
  assert.equal(result.assets.length, 4); assert.equal(result.members.length, 4);
  assert.deepEqual(result.connection_events, [
    null,
    {reported:null, expected:manifest.version, update_required:true},
    {reported:"0.5.2", expected:manifest.version, update_required:true},
    {reported:manifest.version, expected:manifest.version, update_required:false},
  ].map(version => ({event:"collect://extension-connected", version})));
  const heicAsset = result.assets.find(asset => asset.id === heicPicture.asset_id);
  assert.equal(heicAsset.ext, 'png');
  assert.deepEqual([heicAsset.width, heicAsset.height], [96, 32]);
  const saved = result.assets.find(asset => asset.id === video.asset_id);
  assert.equal(saved.ext, 'mp4'); assert.ok(saved.width > 0 && saved.height > 0 && saved.duration > 0);
  assert.equal(saved.source, 'extension'); assert.equal(saved.source_url, `${origin}/source`);
  assert.ok(resolve(saved.store_path).startsWith(root));
  storedVideo = await readFile(saved.store_path); assert.deepEqual(storedVideo, clip);
  const largePath = result.assets.find(asset => asset.id === large.asset_id).store_path;
  assert.equal((await stat(largePath)).size, largeSize);
  const expectedHash = createHash('sha256');
  for (const bytes of largeVideo()) expectedHash.update(bytes);
  const storedHash = createHash('sha256');
  for await (const bytes of createReadStream(largePath)) storedHash.update(bytes);
  assert.equal(storedHash.digest('hex'), expectedHash.digest('hex'));
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage(); await page.goto(`${origin}/page`);
  await page.waitForFunction(() => document.querySelector('video').readyState >= 2);
  const playback = await page.evaluate(async () => { const video = document.querySelector('video'); await video.play(); return { width: video.videoWidth, height: video.videoHeight }; });
  await page.waitForFunction(() => document.querySelector('video').currentTime > 0.1);
  assert.equal(playback.width, saved.width); assert.equal(playback.height, saved.height);
  await writeFile(`${root}/verification.json`, JSON.stringify({ video, duplicate, legacy, large, largeSize, frames, maxFrame, picture, heicPicture, ordered, connectionEvents: result.connection_events, invalid, conflicting, playback, root }, null, 2));
  console.log('PASS extension background -> native WS -> isolated SQLite/media -> playback; 200 MiB stream, 1 MiB frames, legacy upload, interrupted staging cleanup and dedup');
  console.log(root);
} finally {
  if (child.exitCode === null) child.kill();
  await writeFile(`${root}/native.log`, output);
  await browser?.close(); await new Promise(done => http.close(done));
}
