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
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/quick-transfer-live/preview.html?source-library&detail-route&canvas-library`, {
    waitUntil: 'domcontentloaded', timeout: 60_000,
  });
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  const trigger = page.getByRole('button', { name: /^快传/ });
  await trigger.waitFor();
  await checkToolbar();
  assert.equal(await trigger.count(), 1, 'one persistent receive entry in the actual App');
  assert.equal(await page.evaluate(() => window.transferCalls.some(call => call.command === 'quick_transfer_start')), false, 'mounting the App never opens a listener');
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '快传', exact: true });
  const destination = dialog.getByRole('combobox', { name: '接收到' });
  const projectPath = 'D:\\BowerbirdLibrary\\项目\\山野品牌 1-p';
  const defaultPath = 'D:\\BowerbirdLibrary\\快传';
  const folderPath = 'D:\\素材收件\\手机';
  const startArguments = () => page.evaluate(() => window.transferCalls.filter(call => call.command === 'quick_transfer_start').map(call => call.args.destination));
  await dialog.waitFor();
  await dialog.getByText(projectPath, { exact: true }).waitFor();
  assert.match(await destination.innerText(), /山野品牌 1/);
  await page.getByRole('switch', { name: /接收/ }).click();
  await destination.and(page.locator(':disabled')).waitFor();
  assert.deepEqual(await startArguments(), [{ kind: 'project', projectId: 'p' }]);
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
  const home = page.getByRole('navigation', { name: '首页' });
  await home.locator('[aria-current="page"]').filter({ hasText: '项目' }).waitFor();
  assert.equal(await trigger.count(), 0, 'project management does not expose quick transfer');
  await checkToolbar();
  await page.evaluate(() => window.transferUpdate({ transfers: [{ id: 'one', name: '手机照片.heic', size: 4096, received: 4096, status: 'complete', error: null, assetId: 'incoming', retryable: false }] }));
  await home.getByRole('button', { name: '素材库', exact: true }).click();
  await trigger.waitFor();
  await checkToolbar();
  assert.equal(await page.evaluate(() => window.transferCalls.some(call => call.command === 'quick_transfer_stop')), false, 'hiding the entry never stops receiving');
  assert.equal(await page.evaluate(() => window.transferCalls.filter(call => call.command === 'quick_transfer_status').length), 1, 'navigation keeps the receive owner mounted');
  await trigger.click();
  await dialog.getByText(projectPath, { exact: true }).waitFor();
  assert.equal(await destination.isDisabled(), true, 'the active project destination survives reopening from the library');
  await dialog.getByText('手机照片.heic', { exact: true }).waitFor();
  await dialog.getByText('已入库', { exact: true }).waitFor();
  const receivedImage = dialog.locator('.quick-transfer-file').filter({ hasText: '手机照片.heic' }).locator('img');
  await receivedImage.waitFor();
  assert.deepEqual(await receivedImage.evaluate(async image => {
    await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 60;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, 80, 60);
    return [...context.getImageData(60, 40, 1, 1).data];
  }), [198, 75, 55, 255], 'the received HEIC row renders its generated preview pixels');
  assert.equal(await page.evaluate(() => window.transferCalls.filter(call => call.command === 'quick_transfer_start').length), 1, 'route changes and reopening reuse the same session');
  await mkdir('.tmp/quick-transfer-app', { recursive: true });
  await page.screenshot({ path: '.tmp/quick-transfer-app/desktop-dark.png', animations: 'disabled' });
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');
  await page.screenshot({ path: '.tmp/quick-transfer-app/desktop-light.png', animations: 'disabled' });
  await page.getByRole('switch', { name: /接收/ }).click();
  await dialog.getByText('接收已关闭', { exact: true }).first().waitFor();
  assert.equal(await page.evaluate(() => window.transferCalls.filter(call => call.command === 'quick_transfer_stop').length), 1);
  await dialog.getByText(defaultPath, { exact: true }).waitFor();
  await destination.click();
  await page.getByRole('option', { name: '素材收件 / 手机', exact: true }).click();
  await dialog.getByText(folderPath, { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '设为默认', exact: true }).click();
  await dialog.getByRole('button', { name: '恢复默认快传', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await trigger.click();
  await dialog.getByText(folderPath, { exact: true }).waitFor();
  assert.match(await destination.innerText(), /素材收件 \/ 手机（默认）/);
  await page.getByRole('switch', { name: /接收/ }).click();
  await destination.and(page.locator(':disabled')).waitFor();
  assert.deepEqual(await startArguments(), [{ kind: 'project', projectId: 'p' }, { kind: 'folder', folderId: 'mobile' }]);
  assert.equal(await destination.innerText(), '手机');
  await page.getByRole('switch', { name: /接收/ }).click();
  await dialog.getByText('接收已关闭', { exact: true }).first().waitFor();
  await page.keyboard.press('Escape');
  await page.evaluate(() => { window.transferFolders.find(item => item.id === 'mobile').available = false; });
  await trigger.click();
  await dialog.getByText('默认接收文件夹「手机」不可用，已回退到默认「快传」。', { exact: true }).waitFor();
  await dialog.getByText(defaultPath, { exact: true }).waitFor();
  assert.equal(await page.getByRole('switch', { name: /接收/ }).isEnabled(), true, 'fallback can receive immediately');
  await dialog.getByRole('button', { name: '恢复默认快传', exact: true }).click();
  await dialog.getByRole('button', { name: '恢复默认快传', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.transferDefaultFolderId), null);
  assert.equal(await dialog.locator('#quick-transfer-default-warning').count(), 0);
  await destination.click();
  await page.getByRole('option', { name: '秋日海报 2', exact: true }).click();
  await dialog.getByText('D:\\BowerbirdLibrary\\项目\\秋日海报 2-home-project-1', { exact: true }).waitFor();
  await page.getByRole('switch', { name: /接收/ }).click();
  await destination.and(page.locator(':disabled')).waitFor();
  assert.deepEqual((await startArguments()).at(-1), { kind: 'project', projectId: 'home-project-1' });
  await page.getByRole('switch', { name: /接收/ }).click();
  await dialog.getByText('接收已关闭', { exact: true }).first().waitFor();
  assert.deepEqual(errors, []); assert.deepEqual(remote, []);
  console.log('PASS actual App quick transfer: project and folder starts, destination lock, default persistence and fallback, QR, navigation and incoming preview');
} catch (error) {
  console.error(error);
  throw error;
} finally { await browser.close(); await server.close(); }
