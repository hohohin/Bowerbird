// Real native initialization/resize, isolated profile and intercepted synthetic pages.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
import { imageFor } from './fixtures/pinterest-layout/page.mjs';
import { chromeFixture } from './fixtures/pinterest-layout/chrome.mjs';

const directory = path.resolve('.tmp/pinterest-layout-native-' + Date.now());
await mkdir(directory, { recursive: true });
const executable = path.resolve(process.argv[2] || 'src-tauri/target-local-classification/debug/examples/pinterest_search_smoke.exe');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = createServer((_, response) => {
  response.setHeader('content-type', 'text/html'); response.end('<body>isolated layout fixture</body>');
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(1557, '127.0.0.1', resolve); });
let child, mainBrowser, sourceBrowser, main, source, diagnostic = '';
const errors = [], unexpected = [], checks = [];
function nativeFixture() {
  return chromeFixture().replace('</body>', `<button id="fixture-lens" aria-label="Lens">Lens</button><div id="fixture-uploader"></div>
<script>window.layoutUploads=[];document.querySelector('#fixture-lens').onclick=()=>{
 document.querySelector('#fixture-uploader').innerHTML='<input id="lens-file-upload" data-test-id="lens-file-upload" type="file">';
 document.querySelector('#lens-file-upload').onchange=async event=>{
  const file=event.target.files[0];window.layoutUploads.push({type:file.type,bytes:Array.from(new Uint8Array(await file.arrayBuffer()))});
  history.pushState({},'', '/lens-search/?synthetic=uploaded');
 };
};</script></body>`);
}
async function poll(check, message) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (child?.exitCode != null) throw new Error('native fixture exited ' + child.exitCode + ': ' + diagnostic);
    const value = await check().catch(() => null);
    if (value) return value;
    await pause(100);
  }
  throw new Error(message);
}
const invoke = (command, args) => main.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
async function geometry() {
  return source.evaluate(() => {
    const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
    return { url: location.href, timeOrigin: performance.timeOrigin, width: innerWidth,
      availableWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
      source: rect('[data-test-id="visual-search-image-container"]'), image: rect('#source-image'), results: rect('#results'),
      fit: getComputedStyle(document.querySelector('#source-image')).objectFit,
      marked: document.querySelectorAll('[data-bowerbird-lens]').length,
      originalNodes: window.originalPins.every((node, index) => node === document.querySelector('#native-grid').children[index]),
      nativeLayout: window.layoutRuns.at(-1), count: window.appendCount,
    };
  });
}
async function ready() {
  await source.waitForFunction(() => window.layoutRuns?.length);
  await source.evaluate(() => Promise.all([...document.images].map(image => image.decode())));
  await pause(300);
}
async function assertLayout(name) {
  const value = await geometry();
  checks.push({ name, ...value });
  assert.equal(value.availableWidth, value.width, `${name}: scrollbar must not reserve native width`);
  assert.equal(await source.locator('#VerticalNavContent').evaluate(node => node.getBoundingClientRect().width), 36, `${name}: native navigation is half-width`);
  assert.ok(value.source.height <= 161, `${name}: reference preview exceeds 160px (${value.source.height})`);
  assert.ok(value.image.height > 0 && value.image.height <= 161, `${name}: reference image is visible`);
  assert.equal(value.fit, 'contain', name);
  assert.ok(value.results.top >= value.source.bottom - 1, `${name}: results follow the reference`);
  assert.ok(value.results.width >= value.availableWidth - 40, `${name}: results use the viewport width`);
  assert.ok(value.scrollWidth <= value.availableWidth + 1, `${name}: horizontal overflow`);
  assert.equal(value.originalNodes, true, `${name}: original Pin nodes stay attached`);
  return value;
}
async function assertOriginal(name) {
  const value = await geometry(); checks.push({ name, ...value });
  assert.equal(value.fit, 'cover', `${name}: original image styling returns`);
  assert.equal(value.marked, 0, `${name}: all owned layout markers are removed`);
}

try {
  child = spawn(executable, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BOWERBIRD_PINTEREST_TEST_ROOT: directory, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '' } });
  child.stderr.on('data', chunk => diagnostic += chunk);
  mainBrowser = await poll(() => chromium.connectOverCDP('http://127.0.0.1:9567', { timeout: 1000 }), 'main native CDP missing');
  main = await poll(async () => mainBrowser.contexts()[0].pages().find(page => page.url().startsWith('http://127.0.0.1:1557')), 'main page missing');
  await main.waitForFunction(() => window.__TAURI_INTERNALS__?.invoke);
  await invoke('open_source_browser', { url: 'http://127.0.0.1:1557/source', bounds: { x: 250, y: 100, width: 360, height: 600 } });
  sourceBrowser = await poll(() => chromium.connectOverCDP('http://127.0.0.1:9568', { timeout: 1000 }), 'source native CDP missing');
  source = await poll(async () => sourceBrowser.contexts()[0].pages().find(page => page.url().includes('/source')), 'source page missing');
  source.setDefaultTimeout(8000);
  source.on('pageerror', error => errors.push(error.message));
  await source.context().route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'i.pinimg.com') return route.fulfill({ contentType: 'image/svg+xml', body: imageFor(url.href) });
    if (url.hostname === 'www.pinterest.com') return route.fulfill({ contentType: 'text/html', body: nativeFixture(),
      headers: { 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https://i.pinimg.com" } });
    if (url.hostname === '127.0.0.1') return route.continue();
    unexpected.push(url.href); return route.abort();
  });
  await invoke('navigate_source_browser', { url: 'https://www.pinterest.com/lens-search/?synthetic=native' });
  await source.waitForURL('**/lens-search/**'); await ready();
  await assertLayout('initial native document');
  await source.screenshot({ path: path.join(directory, 'narrow.png') });

  await invoke('navigate_source_browser', { url: 'https://www.pinterest.com/' });
  await source.waitForURL('https://www.pinterest.com/'); await ready();
  await assertOriginal('homepage');
  const originalDocument = await source.evaluate(() => performance.timeOrigin);
  await source.evaluate(() => history.pushState({}, '', '/lens-search/?synthetic=spa'));
  await pause(300); await assertLayout('homepage to Lens SPA without DOM changes');
  await source.locator('[data-grid-item="1"] a').click();
  await source.waitForURL('**/pin/1001/'); await pause(300);
  await assertOriginal('Pin detail');
  assert.deepEqual(await source.evaluate(() => window.pinClicks), ['/pin/1001/']);
  await invoke('source_browser_back');
  await source.waitForURL('**/lens-search/**'); await pause(300);
  const back = await assertLayout('native Back returns to Lens');
  assert.equal(back.timeOrigin, originalDocument, 'SPA navigation keeps the same document');

  const resize = async (width, visible = true) => invoke('resize_source_browser', { bounds: { x: 250, y: 100, width, height: 600 }, visible });
  await resize(720, false); await resize(720);
  await poll(() => source.evaluate(() => innerWidth === 720 && window.layoutRuns.at(-1)?.columns >= 2), 'native resize did not reach site masonry');
  const wide = await assertLayout('native hidden-resize-show at 720px');
  await source.screenshot({ path: path.join(directory, 'wide.png') });
  await resize(320);
  await poll(() => source.evaluate(() => innerWidth === 320 && window.layoutRuns.at(-1)?.columns === 1), 'native narrow resize did not reach site masonry');
  const narrow = await assertLayout('native resize back to 320px');
  assert.ok(wide.nativeLayout.columns > narrow.nativeLayout.columns);
  await source.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await poll(() => source.evaluate(() => window.appendCount === 12), 'window scrolling stopped native fixture pagination');
  await ready(); await assertLayout('site pagination retains layout');

  await source.evaluate(() => history.replaceState({}, '', '/'));
  await pause(300); await assertOriginal('replaceState leaves Lens');

  await main.evaluate(async () => {
    window.searchEvents = [];
    const handler = window.__TAURI_INTERNALS__.transformCallback(event => window.searchEvents.push(event.payload));
    await window.__TAURI_INTERNALS__.invoke('plugin:event|listen', { event: 'source-browser://pinterest-search', target: { kind: 'Any' }, handler });
  });
  const assetId = await invoke('smoke_asset');
  await invoke('start_pinterest_image_search', { assetId, requestId: 'layout-native-upload' });
  await poll(() => main.evaluate(() => window.searchEvents.some(event => event.requestId === 'layout-native-upload' && event.status === 'submitted')), 'native image search did not reach the results route');
  await source.waitForURL('**/lens-search/**'); await ready();
  await assertLayout('native upload to SPA Lens results');
  const uploads = await source.evaluate(() => window.layoutUploads);
  assert.equal(uploads.length, 1); assert.equal(uploads[0].type, 'image/png');
  assert.deepEqual(uploads[0].bytes.slice(0, 8), [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  const executableBytes = await readFile(executable);
  const hashes = {};
  for (const file of [executable, 'src-tauri/src/commands/source_browser.rs', 'src-tauri/src/commands/source_browser_pinterest_layout.js', 'src-tauri/src/commands/source_browser_pinterest.js']) {
    const bytes = file === executable ? executableBytes : await readFile(file);
    if (file.endsWith('.js')) assert.ok(executableBytes.includes(bytes), `rebuild the native fixture: current ${file} is not embedded`);
    hashes[file] = createHash('sha256').update(bytes).digest('hex');
  }
  await writeFile(path.join(directory, 'result.json'), JSON.stringify({ ok: true, directory, executable, checks, hashes, errors, unexpected }, null, 2));
  console.log('PASS native Pinterest layout initialization, SPA routes, real resize, restoration, pagination and image upload: ' + directory);
} catch (error) {
  await writeFile(path.join(directory, 'result.json'), JSON.stringify({ ok: false, directory, executable, error: error.message, checks, errors, unexpected }, null, 2));
  console.error('Native layout evidence: ' + directory); throw error;
} finally {
  if (child && child.exitCode == null && main) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    await invoke('smoke_exit').catch(() => {});
    await Promise.race([exited, pause(2000)]);
  }
  if (child && child.exitCode == null) await new Promise(resolve => spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('exit', resolve));
  await mainBrowser?.close().catch(() => {}); await sourceBrowser?.close().catch(() => {});
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
