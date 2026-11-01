// Windows WebView2/real Tauri asset protocol spike; synthetic files and private profiles only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
import { createPreviewServer } from './fixtures/audio-library-preview/server.mjs';

const exec = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const root = resolve(repo, `.tmp/audio-preview-native/run-${Date.now()}`);
await mkdir(root, { recursive: true });
for (const name of ['appdata', 'localappdata', 'profile', 'fixtures']) await mkdir(resolve(root, name));
const log = async message => { await writeFile(resolve(root, 'actions.log'), `${new Date().toISOString()} ${message}\n`, { flag: 'a' }); };
await log('Create an isolated synthetic-media harness; no production setup, database or credentials.');

async function syntheticWav(path, frequency) {
  const rate = 48000; const seconds = 30; const bytes = Buffer.alloc(44 + rate * seconds * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let i = 0; i < rate * seconds; i++) bytes.writeInt16LE(Math.round(Math.sin(i * frequency * Math.PI * 2 / rate) * 2400), 44 + i * 2);
  await writeFile(path, bytes);
  return { id: basename(path), path, duration: seconds, bytes: bytes.length };
}

let fixtureRoot = resolve(root, 'fixtures');
let files;
if (process.env.BOWERBIRD_AUDIO_NATIVE_MANIFEST) {
  const manifestPath = resolve(process.env.BOWERBIRD_AUDIO_NATIVE_MANIFEST);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  fixtureRoot = dirname(manifestPath);
  files = await Promise.all((manifest.files || manifest.items || manifest).map(async file => {
    const path = resolve(fixtureRoot, file.path || file.file || basename(file.url));
    assert.ok(path.startsWith(fixtureRoot + '\\') || path.startsWith(fixtureRoot + '/'), 'fixtures must stay under the manifest directory');
    return { id: file.id || basename(path), path, duration: file.duration, bytes: (await stat(path)).size };
  }));
} else {
  files = await Promise.all([syntheticWav(resolve(fixtureRoot, 'tone-a.wav'), 440), syntheticWav(resolve(fixtureRoot, 'tone-b.wav'), 660)]);
}
assert.ok(files.length >= 2, 'two synthetic sources are needed for cancellation coverage');
await log(`Synthetic sources: ${JSON.stringify(files)}`);
const html = `<!doctype html><meta charset="utf-8"><title>Isolated audio preview acceptance</title>
<style>body{margin:40px}button{display:block;width:600px;height:70px;margin:20px}</style><main></main>
<script>
const sources = ${JSON.stringify(files)};
const audio = document.createElement('audio'); audio.preload = 'none'; audio.volume = 0.03; audio.muted = false;
document.body.append(audio);
const state = { generation: 0, owner: null, entries: [], starts: [], failures: [], stops: 0 };
function stop() { state.generation++; state.owner = null; state.stops++; audio.pause(); audio.removeAttribute('src'); audio.load(); }
async function enter(file, ratio) {
  stop(); const generation = state.generation; state.owner = file.id;
  const started = performance.now(); const entry = { id: file.id, ratio, started, userActivation: { hasBeenActive: navigator.userActivation.hasBeenActive, isActive: navigator.userActivation.isActive } }; state.entries.push(entry);
  audio.src = window.__TAURI_INTERNALS__.convertFileSrc(file.path);
  try {
    await new Promise((resolve, reject) => {
      const cleanup = () => { audio.removeEventListener('loadedmetadata', ready); audio.removeEventListener('error', failed); audio.removeEventListener('emptied', cancelled); };
      const ready = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('media error ' + audio.error?.code)); };
      const cancelled = () => { if (state.generation !== generation) { cleanup(); reject(new DOMException('superseded', 'AbortError')); } };
      audio.addEventListener('loadedmetadata', ready); audio.addEventListener('error', failed); audio.addEventListener('emptied', cancelled);
      audio.load();
    });
    if (generation !== state.generation) return;
    entry.metadataMs = performance.now() - started; entry.duration = audio.duration;
    audio.currentTime = Math.min(audio.duration - 0.05, Math.max(0, ratio * audio.duration));
    entry.target = audio.currentTime;
    await audio.play();
    if (generation !== state.generation) return;
    entry.playResolvedMs = performance.now() - started; state.starts.push(file.id);
  } catch (error) {
    if (generation === state.generation) state.failures.push({ id: file.id, name: error.name, message: error.message });
  }
}
for (const file of sources) {
  const card = document.createElement('button'); card.textContent = file.id; card.dataset.id = file.id;
  card.addEventListener('pointerenter', event => { const bounds = card.getBoundingClientRect(); enter(file, (event.clientX - bounds.left) / bounds.width); });
  card.addEventListener('pointerleave', stop); document.querySelector('main').append(card);
}
window.__audioSmoke = { audio, state, stop, enter, sources };
</script>`;
await writeFile(resolve(root, 'fixture.html'), html);
const study = process.env.BOWERBIRD_AUDIO_NATIVE_MANIFEST && !process.env.BOWERBIRD_AUDIO_NATIVE_NO_NETWORK ? await createPreviewServer({ port: 0, fixturesDir: fixtureRoot }) : null;
const server = createServer(async (request, response) => {
  if (request.url === '/' || !study) { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
  try {
    const upstream = await fetch(new URL(request.url, new URL(study.url).origin), { headers: { Accept: request.headers.accept || '*/*' } });
    response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream' });
    Readable.fromWeb(upstream.body).pipe(response);
  } catch { response.writeHead(502).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const portServer = createServer(); await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
const debugPort = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const binary = resolve(process.env.BOWERBIRD_AUDIO_NATIVE_BINARY || resolve(repo, 'apps/desktop/src-tauri/target/debug/examples/audio_preview_smoke.exe'));
let child; let browser; let bare; let output = ''; const requests = new Map(); const memory = []; const results = { root, files, native: true, platform: process.platform };

async function memorySnapshot(stage) {
  const script = `$all = @(Get-CimInstance Win32_Process); $byId = @{}; foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }; $ids = [System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(${child.pid}); do { $changed = $false; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and $p.CreationDate -ge $byId[[int]$p.ParentProcessId].CreationDate -and $ids.Add([int]$p.ProcessId)) { $changed = $true } } } while ($changed); @($all | Where-Object { $ids.Contains([int]$_.ProcessId) } | ForEach-Object { $role = if (([string]$_.CommandLine) -match '--type=([^\\s]+)') { $matches[1] } else { $_.Name }; [pscustomobject]@{ pid=$_.ProcessId; parent=$_.ParentProcessId; name=$_.Name; role=$role; created=$_.CreationDate.ToString('o'); workingSetBytes=[long]$_.WorkingSetSize; privateBytes=[long]$_.PrivatePageCount; peakWorkingSetBytes=[long]$_.PeakWorkingSetSize*1024; readTransferBytes=[long]$_.ReadTransferCount; autoplayArgument=([string]$_.CommandLine).Contains('--autoplay-policy=no-user-gesture-required') } }) | ConvertTo-Json -Compress`;
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, maxBuffer: 1024 * 1024 });
  const processes = JSON.parse(stdout); const rows = Array.isArray(processes) ? processes : [processes];
  memory.push({ stage, processes: rows, workingSetBytes: rows.reduce((sum, row) => sum + row.workingSetBytes, 0), privateBytes: rows.reduce((sum, row) => sum + row.privateBytes, 0) });
}

async function runWithoutNetworkObserver() {
  let target;
  for (let i = 0; i < 100; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(item => item.url.startsWith(url)); } catch { /* WebView2 starting */ }
    if (target) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(target, 'bare native CDP target');
  const socket = new WebSocket(target.webSocketDebuggerUrl); const pending = new Map(); let nextId = 0;
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const response = JSON.parse(event.data); const entry = pending.get(response.id); if (!entry) return;
    pending.delete(response.id); if (response.error) entry.reject(new Error(JSON.stringify(response.error))); else entry.resolve(response.result);
  });
  socket.addEventListener('close', () => { for (const entry of pending.values()) entry.reject(new Error('bare CDP closed')); pending.clear(); });
  bare = { close: () => socket.close(), send: (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); }) };
  const evaluate = async expression => {
    const result = await bare.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: false });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const move = (x, y) => bare.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', pointerType: 'mouse' });
  for (let i = 0; i < 100 && !(await evaluate('Boolean(window.__audioSmoke)')); i++) await new Promise(resolve => setTimeout(resolve, 50));
  results.observationMode = 'bare Node WebSocket CDP; never enables Network; no Playwright connection';
  results.userAgent = await evaluate('navigator.userAgent');
  await memorySnapshot('bare-idle'); results.formats = [];
  for (let index = 0; index < files.length; index++) {
    await move(5, 5);
    const box = await evaluate(`(() => { const node = document.querySelectorAll('button')[${index}]; node.scrollIntoView({block:'center'}); const r = node.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()`);
    await move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    let ready = false;
    for (let i = 0; i < 240; i++) {
      ready = await evaluate('(() => { const { audio,state } = window.__audioSmoke; const entry=state.entries.at(-1); return entry?.playResolvedMs !== undefined && !audio.paused && audio.currentTime > entry.target + 0.2; })()');
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, `bare playback progresses for ${files[index].id}`);
    results.formats.push(await evaluate('(() => { const {audio,state}=window.__audioSmoke; return {entry:state.entries.at(-1),currentTime:audio.currentTime,muted:audio.muted,volume:audio.volume,failures:state.failures}; })()'));
    await move(5, 5);
  }
  await memorySnapshot('bare-after-format-seeks');
  await evaluate('scrollTo(0,0)');
  const boxes = await evaluate("[...document.querySelectorAll('button')].slice(0,2).map(node => {const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})");
  results.pointerCancellation = [];
  for (let round = 1; round <= 3; round++) {
    for (let i = 0; i < 100; i++) { const box = boxes[i % 2]; await move(box.x + box.width * 0.4, box.y + box.height * 0.5); await new Promise(resolve => setTimeout(resolve, 16)); }
    await move(5, 5);
    const cancellation = await evaluate('(async () => { const {audio,state}=window.__audioSmoke; const starts=state.starts.length; await new Promise(resolve=>setTimeout(resolve,5000)); return {lateStartsAfterLeave:state.starts.length-starts,paused:audio.paused,src:audio.getAttribute("src"),audioElements:document.querySelectorAll("audio").length}; })()');
    results.pointerCancellation.push({ round, pointerMoves: 100, settleMs: 5000, ...cancellation });
    assert.equal(cancellation.lateStartsAfterLeave, 0); assert.equal(cancellation.paused, true); assert.equal(cancellation.src, null); assert.equal(cancellation.audioElements, 1);
    await memorySnapshot(`bare-pointer-round-${round}-settled-5s`);
  }
  results.success = true;
  results.limitations = ['no Network domain: this run has no response-byte measurements', 'private memory samples include the full test WebView2 tree', 'no acoustic/first-audible-sample measurement', 'Windows only'];
  await evaluate('window.__audioSmoke.stop(); location.href="bb-audio-exit://exit"').catch(() => {});
}

try {
  child = spawn(binary, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
    APPDATA: resolve(root, 'appdata'), LOCALAPPDATA: resolve(root, 'localappdata'),
    BOWERBIRD_AUDIO_TEST_ROOT: root, BOWERBIRD_AUDIO_TEST_FIXTURES: fixtureRoot, BOWERBIRD_AUDIO_TEST_URL: url,
    BOWERBIRD_AUDIO_TEST_SOURCES: JSON.stringify(Object.fromEntries(files.map(file => [file.id, file.path]))),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort} --remote-debugging-address=127.0.0.1` } });
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  let spawnError; child.on('error', error => { spawnError = error; });
  if (process.env.BOWERBIRD_AUDIO_NATIVE_NO_NETWORK) {
    await runWithoutNetworkObserver();
  } else {
  for (let i = 0; i < 100; i++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`native fixture exited ${child.exitCode}: ${output}`);
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(browser, 'isolated WebView2 debug endpoint must start');
  let page;
  for (let i = 0; i < 100; i++) {
    page = browser.contexts()[0].pages().find(page => page.url().startsWith(url));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(page, 'fixture page');
  const session = await page.context().newCDPSession(page); await session.send('Network.enable', { maxTotalBufferSize: 1024 * 1024, maxResourceBufferSize: 64 * 1024 });
  for (let i = 0; i < 100; i++) {
    const ready = await session.send('Runtime.evaluate', { expression: 'Boolean(window.__audioSmoke && window.__TAURI_INTERNALS__?.convertFileSrc)', userGesture: false });
    if (ready.result.value) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  session.on('Network.requestWillBeSent', event => { if (event.request.url.includes('asset.localhost')) requests.set(event.requestId, { url: event.request.url, method: event.request.method, headers: event.request.headers }); });
  session.on('Network.requestWillBeSentExtraInfo', event => { const row = requests.get(event.requestId); if (row) row.extraHeaders = event.headers; });
  session.on('Network.responseReceived', event => { const row = requests.get(event.requestId); if (row) { row.status = event.response.status; row.responseHeaders = event.response.headers; row.mimeType = event.response.mimeType; } });
  session.on('Network.loadingFinished', event => { const row = requests.get(event.requestId); if (row) row.encodedDataLength = event.encodedDataLength; });
  results.userAgent = (await session.send('Runtime.evaluate', { expression: 'navigator.userAgent', userGesture: false })).result.value;
  await memorySnapshot('idle');
  assert.equal(requests.size, 0, 'passive cards must not load their audio');
  results.passiveAudioRequests = requests.size;
  if (!process.env.BOWERBIRD_AUDIO_NATIVE_UI_ONLY) {
  results.formats = [];
  for (const file of files) {
    await page.mouse.move(5, 5);
    const card = page.getByRole('button', { name: file.id, exact: true }); await card.scrollIntoViewIfNeeded();
    const bounds = await card.boundingBox(); assert.ok(bounds);
    await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5);
    await page.waitForFunction(() => { const { audio, state } = window.__audioSmoke; const entry = state.entries.at(-1); return state.failures.length || (entry?.playResolvedMs !== undefined && !audio.paused && audio.currentTime > entry.target + 0.2); }, null, { timeout: 12000 });
    const result = await page.evaluate(() => { const { audio, state } = window.__audioSmoke; return { entry: state.entries.at(-1), currentTime: audio.currentTime, duration: audio.duration, paused: audio.paused, muted: audio.muted, volume: audio.volume, failures: state.failures, src: audio.currentSrc, audioElements: document.querySelectorAll('audio').length }; });
    results.formats.push(result);
    assert.equal(result.failures.length, 0, JSON.stringify(result.failures)); assert.equal(result.audioElements, 1);
    assert.equal(result.muted, false); assert.ok(result.volume > 0 && result.volume <= 0.03); assert.equal(result.paused, false);
    if (file.duration >= 600) await memorySnapshot(`playing-${file.id}`);
    await page.mouse.move(5, 5); await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.__audioSmoke.audio.paused && !window.__audioSmoke.audio.getAttribute('src')), true, 'leaving releases the source');
  }
  await memorySnapshot('after-format-seeks');
  await page.evaluate(() => scrollTo(0, 0));
  const first = await page.getByRole('button', { name: files[0].id, exact: true }).boundingBox();
  const second = await page.getByRole('button', { name: files[1].id, exact: true }).boundingBox();
  results.pointerCancellation = [];
  for (let round = 1; round <= 3; round++) {
    for (let i = 0; i < 100; i++) { const box = i % 2 ? second : first; await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5); }
    await page.mouse.move(5, 5);
    const cancellation = await page.evaluate(async () => {
      const { audio, state } = window.__audioSmoke; const before = state.starts.length;
      await new Promise(resolve => setTimeout(resolve, 5000));
      return { pointerMoves: 100, settleMs: 5000, lateStartsAfterLeave: state.starts.length - before, paused: audio.paused, src: audio.getAttribute('src') };
    });
    results.pointerCancellation.push(cancellation);
    assert.equal(cancellation.lateStartsAfterLeave, 0); assert.equal(cancellation.paused, true); assert.equal(cancellation.src, null);
    await memorySnapshot(`raw-pointer-round-${round}-settled-5s`);
  }
  // No await between 100 alternating pending starts: all but the final owner must become stale.
  results.cancellation = await page.evaluate(async () => {
    const { enter, stop, audio, state, sources } = window.__audioSmoke;
    const before = state.starts.length; const failures = state.failures.length;
    for (let i = 0; i < 100; i++) enter(sources[i % 2], 0.4);
    stop(); await new Promise(resolve => setTimeout(resolve, 800));
    return { switches: 100, lateStarts: state.starts.length - before, newFailures: state.failures.slice(failures), paused: audio.paused, src: audio.getAttribute('src'), owner: state.owner, audioElements: document.querySelectorAll('audio').length };
  });
  assert.equal(results.cancellation.lateStarts, 0); assert.equal(results.cancellation.paused, true);
  assert.equal(results.cancellation.src, null); assert.equal(results.cancellation.owner, null); assert.equal(results.cancellation.audioElements, 1);
  await memorySnapshot('after-100-cancelled-starts');
  }
  if (study) {
    await page.addInitScript(() => {
      const NativeAudio = window.Audio;
      window.Audio = new Proxy(NativeAudio, { construct(target, args, constructor) { const audio = Reflect.construct(target, args, constructor); audio.volume = 0.03; return audio; } });
      window.__audioPointerEvents = [];
      for (const type of ['pointerenter', 'pointerleave']) document.addEventListener(type, event => {
        if (event.target?.classList?.contains('audio-wave')) window.__audioPointerEvents.push({ type, target: event.target.getAttribute('aria-label'), x: event.clientX, y: event.clientY });
      }, true);
    });
    await page.goto(new URL(new URL(study.url).pathname, url).href);
    await page.waitForSelector('.audio-card[data-wave-ready="true"]');
    await session.send('Runtime.evaluate', { expression: 'document.querySelector("audio").volume = 0.03', userGesture: false });
    results.ui = { documentHidden: (await session.send('Runtime.evaluate', { expression: 'document.hidden', userGesture: false })).result.value, hoverDwellMs: 90, samples: [] };
    assert.equal(results.ui.documentHidden, false, 'native hidden host must expose visible document for real hover lifecycle');
    const firstWave = page.locator('.audio-wave').first();
    const longWave = page.getByRole('button', { name: '试听 一小时环境录音.mp3', exact: true });
    for (const wave of [firstWave, longWave]) {
      await page.mouse.move(5, 5); await wave.scrollIntoViewIfNeeded();
      const bounds = await wave.boundingBox(); const started = performance.now();
      await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5);
      await page.waitForFunction(() => { const audio = document.querySelector('audio'); return document.querySelector('.audio-card[data-playing="true"]') && !audio.paused && audio.currentTime > audio.duration * 0.5 + 0.2; }, null, { timeout: 12000 });
      const sample = await page.locator('audio').evaluate(audio => ({ src: audio.currentSrc, currentTime: audio.currentTime, duration: audio.duration, paused: audio.paused, muted: audio.muted, volume: audio.volume, elements: document.querySelectorAll('audio').length }));
      sample.pointerToObservedProgressMs = performance.now() - started; results.ui.samples.push(sample);
      assert.ok(sample.src.startsWith('http://asset.localhost/')); assert.equal(sample.elements, 1);
      assert.equal(sample.muted, false); assert.ok(sample.volume > 0 && sample.volume <= 0.03); assert.equal(sample.paused, false);
      await page.mouse.move(5, 5); await page.waitForTimeout(150);
      const left = await page.evaluate(() => ({ paused: document.querySelector('audio').paused, src: document.querySelector('audio').getAttribute('src'), hit: document.elementFromPoint(5, 5)?.outerHTML.slice(0, 500), events: window.__audioPointerEvents }));
      sample.afterLeave = left;
      assert.equal(left.paused && !left.src, true);
    }
    await memorySnapshot('actual-ui-after-two-previews');
    const uiBefore = requests.size;
    const waves = page.locator('.audio-wave'); const boxes = [await waves.nth(0).boundingBox(), await waves.nth(1).boundingBox()];
    for (let i = 0; i < 100; i++) { const box = boxes[i % 2]; await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5); }
    await page.mouse.move(5, 5); await page.waitForTimeout(5000);
    results.ui.quickPointerMoves = 100; results.ui.quickPointerAssetRequests = requests.size - uiBefore;
    results.ui.stopped = await page.locator('audio').evaluate(audio => audio.paused && !audio.hasAttribute('src'));
    assert.equal(results.ui.stopped, true); await memorySnapshot('actual-ui-100-pointer-settled-5s');
    await page.screenshot({ path: resolve(root, 'ui.png') });
  }
  const rows = [...requests.values()];
  results.protocol = { requests: rows, requestCount: rows.length, rangeRequestCount: rows.filter(row => Object.keys({ ...row.headers, ...row.extraHeaders }).some(key => key.toLowerCase() === 'range')).length,
    partialResponses: rows.filter(row => row.status === 206).length,
    responseBodyBytesFromContentLength: rows.reduce((sum, row) => sum + Number(Object.entries(row.responseHeaders || {}).find(([key]) => key.toLowerCase() === 'content-length')?.[1] || 0), 0) };
  assert.ok(results.protocol.rangeRequestCount > 0, 'native media must request byte ranges');
  assert.ok(results.protocol.partialResponses > 0, 'unmodified Tauri asset protocol must return 206');
  results.memory = memory; results.success = true;
  results.limitations = ['play() resolution/currentTime are not acoustic output or first-audible-sample measurements', 'Content-Length sums protocol payloads, not physical disk I/O; cancelled requests may be incomplete', 'process-tree working sets can double-count shared pages; snapshots are not continuous peak private memory', '100 CDP pointer moves exercise browser pointer events, not physical hardware input; an additional 100 programmatic pending starts test cancellation races', 'Windows only; no macOS result'];
  await log('Passed native unmuted playback/time progression, cursor midpoint seeks, source release, 100 stale starts, and actual asset Range observation.');
  }
} catch (error) {
  results.success = false; results.error = String(error.stack || error); await log(`Failure: ${results.error}`);
  await browser?.contexts()[0]?.pages()[0]?.screenshot({ path: resolve(root, 'failure.png') }).catch(() => {});
}
finally {
  results.memory = memory; results.protocolRequests = [...requests.values()];
  await writeFile(resolve(root, 'result.json'), JSON.stringify(results, null, 2)); await writeFile(resolve(root, 'native.log'), output);
  if (browser) {
    const page = browser.contexts()[0]?.pages()[0]; await page?.evaluate(() => { window.__audioSmoke?.stop(); location.href = 'bb-audio-exit://exit'; }).catch(() => {});
    await browser.close().catch(() => {});
  }
  bare?.close();
  if (child && child.exitCode === null) child.kill();
  await new Promise(resolve => server.close(resolve)); await study?.close();
}
console.log(JSON.stringify({ root, success: results.success, error: results.error, userAgent: results.userAgent, formats: results.formats, cancellation: results.cancellation, protocol: results.protocol && { requestCount: results.protocol.requestCount, rangeRequestCount: results.protocol.rangeRequestCount, partialResponses: results.protocol.partialResponses, responseBodyBytesFromContentLength: results.protocol.responseBodyBytesFromContentLength }, memory: memory.map(({ stage, workingSetBytes, privateBytes }) => ({ stage, workingSetBytes, privateBytes })) }, null, 2));
assert.equal(results.success, true, results.error);
