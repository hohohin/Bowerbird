import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ server: { host: '127.0.0.1', port: 1676, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 780 } });
const errors = []; page.on('pageerror', e => errors.push(e.message));
const dialog = page.getByRole('dialog', { name: '随图资料', exact: true });
const restore = () => dialog.getByRole('button', { name: /恢复可用项/ });
const calls = command => page.evaluate(command => window.calls.filter(c => c.command === command), command);
try {
  await page.goto('http://127.0.0.1:1676/scripts/fixtures/folder-mode/preview.html');
  await page.getByRole('button', { name: '文件浏览器', exact: true }).click();
  await page.getByRole('button', { name: 'photo.png', exact: true }).waitFor();
  await page.evaluate(() => {
    window.recordItems = [
      { record_path: 'a.json', file: '/pictures/海边.png', asset_id: 'a', action: 'import', message: '恢复图片描述、生成参数、标签与提示词' },
      { record_path: 'b.json', file: '/pictures/改名.png', asset_id: 'b', action: 'relink', message: '修复失效引用，保留本机创作资料与项目关联' },
      { record_path: 'c.json', file: '/pictures/副本.png', asset_id: 'c', action: 'blocked', message: '原位置仍有文件，请先检查原位置' },
    ];
    window.recordPreviewDelay = 150;
  });
  await page.getByRole('button', { name: '更多文件操作', exact: true }).click();
  await page.getByRole('button', { name: '随图资料', exact: true }).click();
  assert.equal(await restore().isEnabled(), false);
  await dialog.getByRole('list', { name: '资料恢复预览' }).waitFor();
  assert.equal(await dialog.getByRole('listitem').count(), 3);
  assert.equal(await restore().textContent(), '恢复可用项（2）');
  assert.equal((await calls('file_workspace_restore')).length, 0);
  await page.keyboard.press('Escape');
  assert.equal(await dialog.count(), 0);
  assert.equal((await calls('file_workspace_restore')).length, 0);
  await page.getByRole('button', { name: '更多文件操作', exact: true }).click();
  await page.getByRole('button', { name: '随图资料', exact: true }).click();
  await dialog.getByRole('list').waitFor();
  await dialog.getByRole('checkbox', { name: '包含子文件夹' }).check();
  await dialog.getByRole('list').waitFor();
  assert.equal((await calls('file_workspace_restore_preview')).at(-1).args.recursive, true);
  await page.evaluate(() => { window.recordRestoreError = '文件或本机记录已变化，请重新预览后恢复'; });
  await restore().click();
  await dialog.getByRole('alert').waitFor();
  assert.equal(await restore().isEnabled(), false);
  assert.equal(await dialog.getByRole('listitem').count(), 0);
  await page.evaluate(() => { window.recordRestoreError = ''; window.recordRestoreDelay = 500; });
  await dialog.getByRole('button', { name: '重新预览', exact: true }).click();
  await dialog.getByRole('list').waitFor();
  await mkdir('.tmp/file-records', { recursive: true });
  await page.screenshot({ path: '.tmp/file-records/preview.png' });
  await restore().evaluate(button => { button.click(); button.click(); });
  await page.waitForFunction(() => window.calls.filter(c => c.command === 'file_workspace_restore').length === 2);
  await page.keyboard.press('Escape');
  assert.equal(await dialog.count(), 1);
  for (const button of await dialog.getByRole('button', { name: '关闭', exact: true }).all()) assert.equal(await button.isEnabled(), false);
  await dialog.getByText('已恢复 1 项资料，修复 1 项引用。', { exact: true }).waitFor();
  await dialog.getByRole('list').waitFor();
  assert.equal(await restore().isEnabled(), false);
  const applied = (await calls('file_workspace_restore')).at(-1);
  assert.deepEqual(applied.args, { root: '/pictures', recursive: true, token: 'preview-token' });
  assert.equal((await calls('file_workspace_restore')).length, 2);
  await dialog.getByRole('button', { name: '保存当前文件夹资料', exact: true }).click();
  await dialog.getByText('当前文件夹已登记 3 项；1 项等待重试，1 项资料保存在本机。', { exact: true }).waitFor();
  await dialog.getByRole('list').waitFor();
  assert.deepEqual((await calls('file_workspace_save_records')).at(-1).args, { root: '/pictures' });
  await page.setViewportSize({ width: 760, height: 680 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: '.tmp/file-records/narrow.png' });
  await page.keyboard.press('Escape');
  // A late preview must not populate a newly opened dialog.
  await page.evaluate(() => { window.recordPreviewDelay = 400; });
  await page.getByRole('button', { name: '更多文件操作', exact: true }).click();
  await page.getByRole('button', { name: '随图资料', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.evaluate(() => { window.recordItems = []; window.recordPreviewDelay = 0; });
  await page.getByRole('button', { name: '更多文件操作', exact: true }).click();
  await page.getByRole('button', { name: '随图资料', exact: true }).click();
  await dialog.getByText(/未找到随图资料/).waitFor();
  await page.waitForTimeout(450);
  assert.equal(await dialog.getByRole('listitem').count(), 0);
  assert.equal(await restore().isEnabled(), false);
  assert.deepEqual(errors, []);
  console.log('PASS preview and cancel are read-only, explicit recursion, stale preview rejection, duplicate submit guard, write close guard, save fallback status, late preview isolation and narrow layout');
} finally { await browser.close(); await server.close(); }
