import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/original-deletion/vite', server: { host: '127.0.0.1', port: 17908, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
const errors = [], remote = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => { if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue(); remote.push(route.request().url()); return route.abort(); });
page.setDefaultTimeout(6000);
const dialog = () => page.getByRole('dialog');
const calls = () => page.evaluate(() => window.trashCalls);
async function reset() {
  await page.goto('http://127.0.0.1:17908/scripts/fixtures/original-deletion/preview.html');
  await page.waitForFunction(() => window.ready);
}
async function open(kind = 'single') {
  await page.evaluate(kind => window.openMenu(kind), kind);
  await page.getByRole('menuitem', { name: '删除', exact: true }).click();
  assert.equal(await page.getByRole('menuitem', { name: '移出园丁鸟', exact: true }).count(), 0);
  await page.getByRole('menuitem', { name: '删除原文件', exact: true }).click();
  await dialog().waitFor();
}
try {
  await mkdir('.tmp/original-deletion', { recursive: true });
  await reset(); await open();
  await dialog().getByText('disk-a1.png', { exact: true }).waitFor();
  await dialog().getByText('D:/素材/a1.png', { exact: true }).waitFor();
  await dialog().getByText(/系统回收站/).waitFor();
  assert.deepEqual(await calls(), [], 'opening confirmation never deletes a file');
  assert.equal(await dialog().getByText(/不可恢复|仅移除引用/).count(), 0);
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.screenshot({ path: `.tmp/original-deletion/${theme}.png` });
  }
  await dialog().getByRole('button', { name: '取消', exact: true }).click(); assert.deepEqual(await calls(), []);
  // Frozen IDs, partial failure, busy protection and retry only the remaining original.
  await open('multi'); await dialog().locator('[data-delete-asset-id="a2"]').waitFor();
  await page.evaluate(() => { window.failId = 'a2'; window.holdTrash = true; });
  await dialog().getByRole('button', { name: '删除原文件', exact: true }).click();
  await page.waitForFunction(() => window.releaseTrash);
  await page.keyboard.press('Escape'); assert.equal(await dialog().isVisible(), true);
  assert.equal(await dialog().getByRole('button', { name: '取消', exact: true }).isDisabled(), true);
  await page.evaluate(() => { window.holdTrash = false; window.releaseTrash(); });
  await dialog().getByRole('alert').filter({ hasText: '1 项失败' }).waitFor();
  assert.deepEqual(await dialog().locator('[data-delete-asset-id]').evaluateAll(items => items.map(item => item.dataset.deleteAssetId)), ['a2']);
  await page.evaluate(() => { window.failId = null; });
  await dialog().getByRole('button', { name: '重试失败项', exact: true }).click(); await dialog().waitFor({ state: 'detached' });
  assert.deepEqual((await calls()).map(item => item.asset_id), ['a1', 'a2', 'a2']);
  assert.deepEqual((await calls()).map(item => item.fingerprint), ['version-a1', 'version-a2', 'version-a2']);
  assert.equal(await page.evaluate(() => window.calls.some(call => call.command === 'delete_asset_with_mode')), false, 'no legacy record-deletion command');
  // External originals use exactly the same recycle path, not reference record deletion.
  await reset(); await open('external'); await dialog().getByText('disk-external.png', { exact: true }).waitFor();
  await dialog().getByRole('button', { name: '删除原文件', exact: true }).click(); await dialog().waitFor({ state: 'detached' });
  assert.deepEqual((await calls()).map(item => item.asset_id), ['external']);
  // A failed read never enables destructive confirmation; retry obtains a fresh preview.
  await reset(); await page.evaluate(() => { window.failPreview = true; }); await open();
  await dialog().getByRole('alert').waitFor(); assert.equal(await dialog().getByRole('button', { name: '删除原文件', exact: true }).isDisabled(), true);
  await page.evaluate(() => { window.failPreview = false; }); await dialog().getByRole('button', { name: '重新读取', exact: true }).click();
  await dialog().getByText('disk-a1.png', { exact: true }).waitFor(); await dialog().getByRole('button', { name: '取消', exact: true }).click();
  assert.deepEqual(await calls(), []);
  await reset(); await page.evaluate(() => { window.samePath = true; }); await open('multi');
  await dialog().locator('[data-delete-asset-id]').waitFor(); assert.equal(await dialog().locator('[data-delete-asset-id]').count(), 1);
  await dialog().getByRole('button', { name: '删除原文件', exact: true }).click(); await dialog().waitFor({ state: 'detached' }); assert.equal((await calls()).length, 1);
  assert.deepEqual(errors, []); assert.deepEqual(remote, []);
  await writeFile('.tmp/original-deletion/result.json', JSON.stringify({ passed: true, errors, remote, boundary: 'real menu and dialog, controlled native IPC' }, null, 2));
  console.log('Original deletion UI passed.');
} finally { await browser.close(); await server.close(); }
