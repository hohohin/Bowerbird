import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ server: { host: '127.0.0.1', port: 1675, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 780 } });
const errors = []; page.on('pageerror', e => errors.push(e.message));
try {
  await page.addInitScript(() => localStorage.setItem('bowerbird.library.tabOrder', JSON.stringify(['files','library','project'])));
  await page.goto('http://127.0.0.1:1675/scripts/fixtures/folder-mode/preview.html');
  assert.deepEqual(await page.getByRole('tab').allTextContents(), ['全局素材','文件浏览器']);
  await page.getByRole('tab', { name: '全局素材', exact: true }).click();
  await page.getByRole('tab',{name:'文件浏览器',exact:true}).click();
  await page.getByRole('button', { name: 'photo.png', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.command === 'file_workspace_place').length), 0);
  if (!await page.getByRole('dialog', { name: '文件位置', exact: true }).count()) await page.getByRole('button', { name: '文件位置', exact: true }).click();
  await page.getByRole('button', { name: '全局素材', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent === '全局素材');
  assert.equal(await page.getByRole('group', { name: '文件夹地址栏' }).count(), 0);
  assert.equal(await page.locator('.folder-media-card').count(), 0);
  await page.getByRole('tab', { name: '文件浏览器', exact: true }).click();
  await page.getByRole('group', { name: '文件夹地址栏' }).click({position:{x:2,y:2}});
  const input = page.getByRole('textbox', { name: '文件夹路径' });
  await input.fill('/pictures'); await input.press('Enter');
  await page.getByRole('button', { name: 'photo.png', exact: true }).waitFor();
  if (!await page.getByRole('dialog', { name: '文件位置', exact: true }).count()) await page.getByRole('button', { name: '文件位置', exact: true }).click();
  await page.getByRole('button', { name: '添加当前目录', exact: true }).click();
  await page.getByRole('button', { name: '移除常用位置 /pictures', exact: true }).waitFor();
  if (!await page.getByRole('dialog', { name: '文件位置', exact: true }).count()) await page.getByRole('button', { name: '文件位置', exact: true }).click();
  await page.getByRole('button', { name: '全局素材', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent === '全局素材');
  assert.equal(await page.getByRole('group', { name: '文件夹地址栏' }).count(), 0);
  assert.equal(await page.locator('.folder-media-card').count(), 1);
  await page.evaluate(() => { window.offlineLocations = ['/nas/photos']; });
  await page.getByRole('button', { name: '更多文件操作', exact: true }).click();
  await page.getByRole('button', { name: '刷新素材', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '/nas/photos' }).waitFor();
  if (!await page.getByRole('dialog', { name: '文件位置', exact: true }).count()) await page.getByRole('button', { name: '文件位置', exact: true }).click();
  await page.getByRole('button', { name: '移除常用位置 /pictures', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.folder-media-card').length === 0);
  assert.equal(await page.evaluate(() => window.calls.some(c => /delete|remove_file/.test(c.command))), false);
  // Cancelling the required folder selection cannot create a project or change active ownership.
  const cancelled = await page.evaluate(async () => {
    window.rootUnwritable = true; window.cancelFolderPicker = true;
    const before = window.store.getState().activeProjectId;
    try { await window.store.getState().beginProvisionalProject('取消项目'); return null; }
    catch (e) { return { error: String(e), unchanged: before === window.store.getState().activeProjectId }; }
  });
  assert.equal(cancelled.unchanged, true);
  assert.match(cancelled.error, /未选择可写/);
  assert.equal(await page.evaluate(() => window.calls.some(c => c.command === 'set_active_project')), false);
  const created = await page.evaluate(async () => {
    window.cancelFolderPicker = false;
    const id = await window.store.getState().beginProvisionalProject('选定位置的项目');
    return window.store.getState().projects.find(p => p.id === id);
  });
  assert.ok(created.workspace_path.startsWith('/picked/项目/'));
  const prepare = await page.evaluate(() => window.calls.filter(c => c.command === 'file_workspace_prepare'));
  assert.equal(prepare.at(-1).args.root, '/picked');
  await page.evaluate(() => { window.rootUnwritable = false; window.offlineLocations = []; });
  if (!await page.getByRole('dialog', { name: '文件位置', exact: true }).count()) await page.getByRole('button', { name: '文件位置', exact: true }).click();
  await page.getByRole('button', { name: '资料文件夹', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="文件夹路径"]').value === '/picked');
  await mkdir('.tmp/file-workspace', { recursive: true });
  await page.screenshot({ path: '.tmp/file-workspace/locations.png' });
  await page.setViewportSize({ width: 760, height: 680 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log('PASS two-tab migration, explicit location enrollment/removal, aggregate refresh/offline state, required writable selection, cancelled project isolation, selected project directory and narrow layout');
} finally { await browser.close(); await server.close(); }
