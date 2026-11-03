// Real WebView2 drag/notice bridge; synthetic Pin feed and isolated browser profiles.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
import { feedFixture, syntheticImage } from './fixtures/pinterest-feed-drag/page.mjs';
import { startBrowserDrag, finishBrowserDrag } from './fixtures/explorer/native-drag.mjs';
import { parseExplorerImage } from '../src/lib/explorer.ts';

const directory = path.resolve('.tmp/pinterest-feed-native-' + Date.now());
await mkdir(directory, { recursive: true });
const executable = path.resolve(process.argv[2] || 'src-tauri/target-local-classification/debug/examples/explorer_smoke.exe');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = createServer((_, response) => {
  response.setHeader('content-type', 'text/html');
  response.end('<body style="margin:0"><div id="drop" style="width:250px;height:600px">Isolated library drop target</div></body>');
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(1557, '127.0.0.1', resolve); });
let child, browser, sourceBrowser, main, source, diagnostic = '', currentKind = 'hover';
const results = [], errors = [], unexpected = [];
const invoke = (command, args) => main.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
async function poll(check, message) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (child?.exitCode != null) throw new Error('native fixture exited ' + child.exitCode + ': ' + diagnostic);
    const value = await check().catch(() => null); if (value) return value;
    await pause(100);
  }
  throw new Error(message);
}
async function load(kind) {
  currentKind = kind;
  const url = kind === 'detail-image' ? 'https://www.pinterest.com/pin/1001/' : `https://www.pinterest.com/?fixture=${kind}`;
  await invoke('navigate_source_browser', { url });
  await source.waitForURL(url);
  await source.locator('#pin-image').waitFor();
  await source.evaluate(() => Promise.all([...document.images].map(image => image.decode())));
  await source.mouse.move(160, 200); await pause(80);
}
async function cancelDrag(session, data) {
  if (!session) return;
  if (data) await session.send('Input.dispatchDragEvent', { type: 'dragCancel', x: 0, y: 0, data }).catch(() => {});
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 0, y: 0, button: 'left', buttons: 0 }).catch(() => {});
  await session.detach().catch(() => {});
}
async function positive(kind, point = { x: 160, y: 200 }) {
  await load(kind);
  const noticesBefore = (await invoke('smoke_drag_notices')).length;
  let session, data, timeout;
  try {
    ({ session, data } = await Promise.race([startBrowserDrag(source, point.x, point.y), new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('bounded native drag did not start')), 8000);
    })]));
    const item = data.items.find(item => item.mimeType === 'application/x-bowerbird-explorer');
    assert.ok(item, 'Pin image drag must carry the image capture payload, not only the Pin hyperlink');
    const payload = JSON.parse(item.data);
    assert.equal(payload.imageUrl, 'https://i.pinimg.com/originals/target.svg');
    assert.equal(payload.pageUrl, 'https://www.pinterest.com/pin/1001/');
    await poll(async () => (await invoke('smoke_drag_notices')).slice(noticesBefore).some(notice => notice.start && notice.id === payload.dragId), 'native private start notice missing');
    const notices = (await invoke('smoke_drag_notices')).slice(noticesBefore).filter(notice => notice.start);
    assert.equal(notices.length, 1, 'one browser drag produces exactly one native start');
    assert.equal(notices[0].imageUrl, payload.imageUrl); assert.equal(notices[0].pageUrl, payload.pageUrl);
    await main.evaluate(() => window.droppedText = null);
    await finishBrowserDrag(await main.context().newCDPSession(main), { items: data.items.filter(item => item.mimeType === 'text/plain'), dragOperationsMask: 1 }, 100, 200);
    const text = await main.evaluate(() => window.droppedText);
    const dropped = parseExplorerImage({ getData: type => type === 'text/plain' ? text : '' });
    assert.equal(dropped.imageUrl, payload.imageUrl); assert.equal(dropped.pageUrl, payload.pageUrl);
    assert.ok(kind === 'detail-image' ? source.url() === payload.pageUrl : source.url().includes(`fixture=${kind}`), 'private notices never navigate the source page');
    await cancelDrag(session, data); session = null;
    await poll(async () => (await invoke('smoke_drag_notices')).some(notice => !notice.start && notice.id === payload.dragId), 'native drag end notice missing');
    return { payload, standardTextTransferredToMain: true };
  } finally { clearTimeout(timeout); await cancelDrag(session, data); }
}
async function negative(kind, selector, blank = false) {
  await load(kind);
  const before = (await invoke('smoke_drag_notices')).filter(notice => notice.start).length;
  await source.locator(selector).waitFor({ state: 'visible' });
  const box = await source.locator(selector).boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, `${kind}: actual foreground target is visible`);
  const point = blank ? { x: 100, y: 330 } : { x: box.x + 8, y: box.y + 12 };
  const session = await source.context().newCDPSession(source), drags = [];
  session.on('Input.dragIntercepted', ({ data }) => drags.push(data));
  await session.send('Input.setInterceptDrags', { enabled: true });
  try {
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
    const pressed = await source.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y);
      return { tag: target.tagName, draggable: target.getAttribute('draggable'), userDrag: target.style.getPropertyValue('-webkit-user-drag') };
    }, point);
    for (let step = 1; step <= 8; step++) await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + step * 12, y: point.y, button: 'left', buttons: 1 });
    assert.equal(pressed.draggable, null, `${kind}: no image drag handle on a control/text/panel`);
    assert.equal(pressed.userDrag, '', `${kind}: native selection is not overridden`);
    assert.equal(drags.some(data => data.items.some(item => item.mimeType === 'application/x-bowerbird-explorer' || item.data.startsWith('bowerbird-explorer:'))), false);
    assert.equal((await invoke('smoke_drag_notices')).filter(notice => notice.start).length, before);
    if (kind === 'modal-text') assert.ok((await source.evaluate(() => String(getSelection()))).length > 3, 'modal text remains selectable');
    return { pressed, imageCaptureNotices: 0 };
  } finally { await cancelDrag(session, drags.at(-1)); }
}

try {
  child = spawn(executable, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
    PATH: path.dirname(path.dirname(executable)) + ';' + process.env.PATH, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '',
    BOWERBIRD_EXPLORER_TEST_DEBUG_PORT: '9558', BOWERBIRD_EXPLORER_TEST_DATA_DIR: path.join(directory, 'sites'),
    BOWERBIRD_EXPLORER_TEST_MAIN_DATA_DIR: path.join(directory, 'main') } });
  child.stderr.on('data', chunk => diagnostic += chunk);
  browser = await poll(() => chromium.connectOverCDP('http://127.0.0.1:9557', { timeout: 1000 }), 'main CDP missing');
  main = await poll(async () => browser.contexts()[0].pages().find(page => page.url().startsWith('http://127.0.0.1:1557')), 'main page missing');
  await main.waitForFunction(() => window.__TAURI_INTERNALS__?.invoke);
  await main.evaluate(() => {
    document.querySelector('#drop').addEventListener('dragover', event => event.preventDefault());
    document.querySelector('#drop').addEventListener('drop', event => { event.preventDefault(); window.droppedText = event.dataTransfer.getData('text/plain'); });
  });
  await invoke('open_source_browser', { url: 'http://127.0.0.1:1557/source', bounds: { x: 300, y: 100, width: 600, height: 600 } });
  sourceBrowser = await poll(() => chromium.connectOverCDP('http://127.0.0.1:9558', { timeout: 1000 }), 'source CDP missing');
  source = await poll(async () => sourceBrowser.contexts()[0].pages().find(page => page.url().includes('/source')), 'source page missing');
  source.setDefaultTimeout(6000); source.on('pageerror', error => errors.push(error.message));
  await source.context().route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'i.pinimg.com') return route.fulfill({ contentType: 'image/svg+xml', body: syntheticImage });
    if (url.hostname === 'www.pinterest.com') return route.fulfill({ contentType: 'text/html', body: feedFixture(currentKind) });
    if (url.hostname === '127.0.0.1') return route.continue();
    unexpected.push(url.href); return route.abort();
  });
  const cases = [
    ['detail-image', () => positive('detail-image')], ['transparent', () => positive('transparent')],
    ['hover-gradient', () => positive('hover')], ['hover-top-wash', () => positive('top-wash', { x: 100, y: 90 })],
    ['save', () => negative('save', '#save')], ['text', () => negative('text', '#label')],
    ['modal-text', () => negative('modal-text', '#modal-text')], ['modal-blank', () => negative('modal-blank', '#modal', true)],
    ['backdrop', () => negative('backdrop', '#modal-shade', true)], ['opaque-panel', () => negative('opaque-panel', '#opaque-panel', true)],
  ];
  for (const [name, run] of cases) {
    try { results.push({ name, ok: true, ...await run() }); console.log('PASS ' + name); }
    catch (error) { results.push({ name, ok: false, error: error.message }); console.log('FAIL ' + name + ': ' + error.message); }
  }
  const sourceBytes = await readFile('src-tauri/src/commands/source_browser_drag.js'), binary = await readFile(executable);
  const evidence = { ok: results.every(result => result.ok) && !errors.length && !unexpected.length, directory, executable, results, errors, unexpected,
    currentDragScriptEmbedded: binary.includes(sourceBytes), sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'), binarySha256: createHash('sha256').update(binary).digest('hex') };
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log('Native feed evidence: ' + directory);
  assert.equal(evidence.currentDragScriptEmbedded, true, 'rebuild current drag script');
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  assert.equal(results.filter(result => !result.ok).length, 0, 'native Pin feed and no-penetration cases pass');
} finally {
  if (child && child.exitCode == null && main) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    await Promise.race([invoke('smoke_exit').catch(() => {}), pause(1000)]);
    await Promise.race([exited, pause(1000)]);
  }
  if (child && child.exitCode == null) await new Promise(resolve => spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('exit', resolve));
  await browser?.close().catch(() => {}); await sourceBrowser?.close().catch(() => {});
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
