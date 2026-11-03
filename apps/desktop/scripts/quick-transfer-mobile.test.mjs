import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const url = process.argv[2];
assert.ok(url, 'Run through fixtures/quick-transfer-mobile/Cargo.toml');
const output = fileURLToPath(new URL('../.tmp/quick-transfer-mobile/', import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [];
const errors = [];
const remote = [];
const file = name => ({ name, mimeType: 'image/png', buffer: Buffer.from('browser-upload') });

async function openPage(context, address = url) {
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (new URL(request.url()).origin !== new URL(url).origin) remote.push(request.url());
  });
  await page.goto(address);
  return page;
}

async function selectAndSend(page, files) {
  await page.locator('#file-input').setInputFiles(files);
  await page.locator('#send').click();
}

async function waitDone(page, count) {
  await page.waitForFunction(expected => document.querySelectorAll('.file-state.done').length === expected, count);
}

async function successfulBatch(context) {
  const page = await openPage(context);
  const uploads = [];
  page.on('response', response => {
    if (response.url().includes('/upload?')) uploads.push(response.status());
  });
  await selectAndSend(page, [file('山间晨雾.png'), file('海边散步.png')]);
  await page.locator('.file-state').filter({ hasText: '确认中' }).waitFor();
  assert.equal(await page.locator('.file-state.done').count(), 0, 'sent bytes are not durable receipt');
  assert.equal(await page.locator('#send').isDisabled(), true, 'busy sends cannot be submitted twice');
  await waitDone(page, 2);
  assert.match(await page.locator('#mobile-notice').innerText(), /已传到电脑/);
  assert.equal(await page.locator('#send').isDisabled(), true);
  assert.deepEqual(uploads, [200, 200]);
  await page.screenshot({ path: `${output}/mobile-390-received.png`, fullPage: true });
  await selectAndSend(page, file('山间晨雾.png'));
  await waitDone(page, 1);
  assert.deepEqual(uploads, [200, 200, 200]);
  results.push('Chinese names, sequential batch, durable acknowledgement, explicit repeated selection');
  await page.close();
}

async function refusalAndPartialRetry(context) {
  const page = await openPage(context);
  const prepareBodies = [];
  page.on('request', request => {
    if (request.url().includes('/prepare-upload')) prepareBodies.push(request.postDataJSON());
  });
  await selectAndSend(page, file('拒绝.png'));
  await page.locator('#mobile-notice').filter({ hasText: '未接受' }).waitFor();
  assert.equal(await page.locator('.file-state.done').count(), 0);
  await selectAndSend(page, [file('先成功.png'), file('校验失败.png')]);
  await page.locator('#mobile-notice').filter({ hasText: '未能确认' }).waitFor();
  await waitDone(page, 1);
  await page.locator('#send').click();
  await page.locator('#mobile-notice').filter({ hasText: '未能确认' }).waitFor();
  assert.deepEqual(Object.values(prepareBodies.at(-1).files).map(item => item.fileName), ['校验失败.png']);
  results.push('Receiver refusal, failed durable receipt, retry excludes received files');
  await page.close();
}

async function literalFileName(context) {
  const page = await openPage(context);
  const name = '<img src=x onerror=alert(1)>.png';
  await page.locator('#file-input').setInputFiles(file(name));
  assert.equal(await page.locator('.file-name').innerText(), name);
  assert.equal(await page.locator('#mobile-queue img').count(), 0);
  results.push('File names are rendered as text, not markup');
  await page.close();
}

async function lostReceipt(context) {
  const page = await openPage(context);
  let storedResponses = 0;
  await page.route('**/api/localsend/v2/upload?**', async route => {
    const response = await route.fetch();
    assert.equal(response.status(), 200, 'receiver has durably acknowledged this file');
    storedResponses++;
    await route.abort('failed');
  });
  await selectAndSend(page, file('回执丢失.png'));
  await page.locator('#mobile-notice').filter({ hasText: '先在电脑核对' }).waitFor();
  assert.equal(await page.locator('.file-state.done').count(), 0);
  assert.equal(storedResponses, 1, 'unknown receipt is never automatically retried');
  await page.screenshot({ path: `${output}/mobile-390-unconfirmed.png`, fullPage: true });
  results.push('Lost HTTP response after real durable receipt remains unconfirmed and asks to check computer');
  await page.close();
}

async function authenticatedCancel(context) {
  const page = await openPage(context);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: -1, uploadThroughput: 65536 });
  const upload = page.waitForRequest(request => request.url().includes('/upload?'));
  await selectAndSend(page, { name: '取消.png', mimeType: 'image/png', buffer: Buffer.alloc(2 * 1024 * 1024, 1) });
  await upload;
  const cancel = page.waitForResponse(response => response.url().includes('/cancel?'));
  await page.locator('#cancel').click();
  const response = await cancel;
  assert.equal(response.status(), 200);
  assert.equal(new URL(response.url()).searchParams.get('pin'), new URL(url).searchParams.get('pin'));
  await page.locator('#mobile-notice').filter({ hasText: '已停止发送' }).waitFor();
  assert.equal(await page.locator('.file-state.done').count(), 0);
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await selectAndSend(page, file('取消后.png'));
  await waitDone(page, 1);
  results.push('Authenticated cancellation stops transfer and releases batch for another selection');
  await page.close();
}

async function disconnected(context) {
  const page = await openPage(context);
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.locator('#mobile-notice').filter({ hasText: '连接已中断' }).waitFor();
  assert.equal(await page.locator('#send').isDisabled(), true);
  await context.setOffline(false);
  await page.locator('#mobile-receiver').filter({ hasText: '接收已开启' }).waitFor();
  await selectAndSend(page, file('重连.png'));
  await waitDone(page, 1);
  results.push('Disconnected state blocks send and reconnection can send again');
  await page.close();
}

async function interruptedUpload(context) {
  const page = await openPage(context);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: -1, uploadThroughput: 65536 });
  const upload = page.waitForRequest(request => request.url().includes('/upload?'));
  await selectAndSend(page, { name: '中断.png', mimeType: 'image/png', buffer: Buffer.alloc(2 * 1024 * 1024, 2) });
  await upload;
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.locator('#mobile-notice').filter({ hasText: '先在电脑核对' }).waitFor();
  await page.locator('#reconnect').waitFor();
  assert.equal(await page.locator('.file-state.done').count(), 0);
  assert.equal(await page.locator('#send').isDisabled(), true);
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await context.setOffline(false);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.locator('#mobile-receiver').filter({ hasText: '接收已开启' }).waitFor();
  assert.match(await page.locator('#mobile-notice').innerText(), /先在电脑核对/);
  results.push('Active network interruption never reports receipt; reconnection retains check-computer warning');
  await page.close();
}

async function closedReceiver(context) {
  const page = await openPage(context);
  await page.locator('#file-input').setInputFiles(file('关闭后.png'));
  await page.locator('#mobile-receiver').filter({ hasText: '接收已开启' }).waitFor();
  await writeFile(process.argv[3], 'stop');
  await page.waitForTimeout(100);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.locator('#mobile-notice').filter({ hasText: '连接已中断' }).waitFor();
  assert.equal(await page.locator('#send').isDisabled(), true);
  assert.equal(await page.locator('#pick').isDisabled(), true);
  results.push('Listener close detected on foreground probe disables sending');
  await page.close();
}

async function expiredLink(context) {
  const expired = new URL(url);
  expired.searchParams.set('pin', 'expired-secret-000000000000000000000');
  const page = await openPage(context, expired.href);
  await page.locator('#mobile-notice').filter({ hasText: '重新扫码' }).waitFor();
  assert.equal(await page.locator('#send').isDisabled(), true);
  assert.equal(await page.locator('#pick').isDisabled(), true);
  results.push('Old pairing link fails authentication and disables selection/send');
  await page.close();
}

async function smallScreens(context) {
  for (const theme of ['light', 'dark']) {
    const page = await openPage(context);
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 320, height: 640 });
    await page.locator('#file-input').setInputFiles(file('很长的中文文件名'.repeat(10) + '.png'));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `${output}/mobile-320-${theme}.png`, fullPage: true });
    await page.close();
  }
  results.push('320px light/dark layouts have no horizontal overflow');
}

try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  await successfulBatch(context);
  await refusalAndPartialRetry(context);
  await literalFileName(context);
  await lostReceipt(context);
  await authenticatedCancel(context);
  await disconnected(context);
  await interruptedUpload(context);
  await expiredLink(context);
  await smallScreens(context);
  await closedReceiver(context);
  assert.deepEqual(errors, []);
  assert.deepEqual(remote, []);
  await writeFile(`${output}/report.json`, JSON.stringify({ results, errors, remote, scope: 'Chrome loopback, temporary directory; not a physical phone or production library' }, null, 2));
  console.log(JSON.stringify({ results, errors, remote }));
} finally {
  await browser.close();
}
