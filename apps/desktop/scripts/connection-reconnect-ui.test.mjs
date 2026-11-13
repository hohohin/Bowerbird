import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/connection-reconnect/vite', server: { host: '127.0.0.1', port: 17957, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + 'scripts/fixtures/connected-collections/preview.html');
  await page.getByRole('tab', { name: '文件夹', exact: true }).click();
  const row = page.getByRole('treeitem', { name: '另一目录', exact: true });
  const card = page.locator('[data-connection-entry="second-0"]');
  const status = page.locator('.catalog-gallery .connected-status');
  await row.click(); await card.waitFor();
  await page.evaluate(() => {
    window.onlineEntries = window.entries;
    window.entries = window.entries.filter(e => e.folder_id !== 'second');
    window.folders.filter(f => f.root_id === 'second').forEach(f => {f.available = false;});
    window.connectionAvailability({rootId:'second', available:false});
  });
  await row.click();
  await status.filter({hasText:'另一目录」已离线'}).waitFor();
  await card.waitFor({state:'detached'});
  await page.evaluate(() => window.setLibraryVisible(false));
  await row.waitFor({state:'detached'});
  await page.evaluate(() => window.setLibraryVisible(true));
  await page.getByRole('tab', { name: '文件夹', exact: true }).click();
  await row.click();
  await status.filter({hasText:'另一目录」已离线'}).waitFor();
  const preReconnectReads = await page.evaluate(() => window.requests.filter(r => r.command === 'folder_connections').length);
  await page.evaluate(() => {
    // Directory available before the native debounce starts the scan.
    window.folders.filter(f => f.root_id === 'second').forEach(f => {f.available = true; f.scanning = false;});
    window.connectionAvailability({rootId:'second',available:true});
    window.connectionProgress({rootId:'second',scanning:false,error:null}); // old completion
  });
  await page.waitForFunction(count => window.requests.filter(r => r.command === 'folder_connections').length > count, preReconnectReads);
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  await status.filter({hasText:'正在读取「另一目录」'}).waitFor();
  await page.evaluate(() => {
    window.folders.filter(f => f.root_id === 'second').forEach(f => {f.scanning = true;});
    window.connectionProgress({rootId:'second',scanning:true,error:null});
    window.catalogGate = new Promise(done => {window.finishRead = done;});
  });
  const beforeFinish = await page.evaluate(() => window.requests.filter(r => r.command === 'folder_connections').length);
  await page.evaluate(() => {
    window.entries = window.onlineEntries;
    window.folders.filter(f => f.root_id === 'second').forEach(f => {f.scanning = false;});
    // A reconnect may restore identical files without a structural asset-change event.
    window.connectionProgress({rootId:'second',scanning:false,error:null});
  });
  await page.waitForFunction(count => window.requests.filter(r => r.command === 'folder_connections').length > count, beforeFinish);
  assert.match(await status.innerText(),/正在读取/);
  await page.evaluate(() => { window.finishRead(); window.catalogGate = null; });
  await card.waitFor();
  await status.waitFor({state:'detached'});
  assert.equal(await row.getAttribute('aria-selected'), 'true');
  assert.equal(await page.evaluate(() => window.requests.filter(r => ['refresh_folder_connections','connect_folder','relocate_folder','restart_app'].includes(r.command)).length),0);
  assert.deepEqual(errors,[]);
  console.log('PASS connected folder offline click and re-entry, reconnect read state, same folder and original assets restored without manual action');
} finally { await browser.close(); await server.close(); }
