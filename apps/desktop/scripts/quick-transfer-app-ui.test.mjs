import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import jsQR from 'jsqr';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const { PNG } = createRequire(createRequire(import.meta.url).resolve('qrcode/package.json'))('pngjs');

const server = await createServer({ cacheDir: '.tmp/quick-transfer-app-vite', server: { host: '127.0.0.1', port: 18957, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(7000);
const errors = [], remote = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => {
  if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue();
  remote.push(route.request().url()); return route.abort();
});
async function checkToolbar() {
  for (const width of [900, 1100, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.locator('.app-topbar').evaluate(bar => {
      const rect = bar.getBoundingClientRect();
      const controls = [...bar.querySelectorAll('button')].map(node => node.getBoundingClientRect()).filter(box => box.width && box.height);
      return { overflow: bar.scrollWidth > bar.clientWidth,
        contained: controls.every(box => box.left >= rect.left && box.right <= rect.right),
        overlap: controls.some((box, i) => controls.slice(i + 1).some(other => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)) };
    });
    assert.deepEqual(layout, { overflow: false, contained: true, overlap: false }, `toolbar ${width}px`);
  }
}
try {
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/quick-transfer-live/preview.html?source-library&detail-route&canvas-library`);
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  const trigger = page.getByRole('button', { name: /^快传/ });
  await trigger.waitFor();
  await checkToolbar();
  assert.equal(await trigger.count(), 1, 'one persistent receive entry in the actual App');
  assert.equal(await page.evaluate(() => window.transferCalls.some(call => call.command === 'quick_transfer_start')), false, 'mounting the App never opens a listener');
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '快传', exact: true });
  await dialog.waitFor();
  await dialog.getByText('D:\\BowerbirdLibrary\\快传', { exact: true }).waitFor();
  await page.getByRole('switch', { name: /接收/ }).click();
  await dialog.getByText('手机扫码上传', { exact: true }).waitFor();
  await dialog.getByText('电脑浏览器打开', { exact: true }).waitFor();
  await dialog.getByText('01234567', { exact: true }).waitFor();
  const qr = page.getByRole('img', { name: '扫码上传到 Bowerbird' });
  await qr.waitFor();
  const pixels = PNG.sync.read(await qr.screenshot({ animations: 'disabled' }));
  assert.equal(jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height)?.data,
    await page.evaluate(() => window.transferSnapshot.url), 'QR is readable at its actual on-screen size');
  assert.equal(await page.evaluate(() => window.transferCalls.filter(call => call.command === 'quick_transfer_start').length), 1);
  await page.keyboard.press('Escape');
  assert.equal(await dialog.count(), 0);
  assert.equal(await page.evaluate(() => window.transferCalls.some(call => call.command === 'quick_transfer_stop')), false, 'collapse keeps receiving');
  await page.getByRole('button', { name: '返回主页', exact: true }).click();
  await page.getByRole('region', { name: '素材库创作', exact: true }).waitFor();
  await checkToolbar();
  await page.evaluate(() => window.transferUpdate({ transfers: [{ id: 'one', name: '手机照片.heic', size: 4096, received: 4096, status: 'complete', error: null, assetId: 'incoming', retryable: false }] }));
  await trigger.click();
  await dialog.getByText('手机照片.heic', { exact: true }).waitFor();
  await dialog.getByText('已入库', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.transferCalls.filter(call => call.command === 'quick_transfer_start').length), 1, 'route changes and reopening reuse the same session');
  await mkdir('.tmp/quick-transfer-app', { recursive: true });
  await page.screenshot({ path: '.tmp/quick-transfer-app/desktop-dark.png', animations: 'disabled' });
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');
  await page.screenshot({ path: '.tmp/quick-transfer-app/desktop-light.png', animations: 'disabled' });
  await page.getByRole('switch', { name: /接收/ }).click();
  await dialog.getByText('接收已关闭', { exact: true }).first().waitFor();
  assert.equal(await page.evaluate(() => window.transferCalls.filter(call => call.command === 'quick_transfer_stop').length), 1);
  assert.deepEqual(errors, []); assert.deepEqual(remote, []);
  console.log('PASS actual App quick transfer: one entry, explicit start, directory, QR, collapse, navigation, incoming state and explicit stop');
} finally { await browser.close(); await server.close(); }
