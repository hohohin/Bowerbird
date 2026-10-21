import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ server: { host: '127.0.0.1', port: 1698, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
try {
  await mkdir('.tmp/file-context-menu', { recursive: true });
  await page.goto('http://127.0.0.1:1698/scripts/fixtures/canvas-reference/preview.html?source-library&local-files&detail-route');
  await page.getByRole('button', { name: '返回主页', exact: true }).click();
  const first = page.locator('.folder-media-card[aria-label="原图.png"]');
  const second = page.locator('.folder-media-card[aria-label="另一张.png"]');
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.command === 'external_files_index').length), 0, 'browsing does not index files');
  for (const width of [900, 980, 981, 1120, 1200, 1201, 1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 840 });
    for (const busy of [false, true]) {
      await page.evaluate(busy => window.store.setState({ loading: busy }), busy);
      await page.waitForFunction(busy => document.querySelector('.app-topbar').getAttribute('aria-busy') === String(busy), busy);
      const geometry = await page.locator('.app-topbar').evaluate(el => {
        const bar = el.getBoundingClientRect(), search = el.querySelector('.app-search').getBoundingClientRect();
        const controls = [...el.querySelectorAll('button, input')].map(e => e.getBoundingClientRect()).filter(r => r.width && r.height);
        return { offset: search.x + search.width / 2 - bar.x - bar.width / 2,
          overlap: controls.some((a, i) => controls.slice(i + 1).some(b => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top)),
          overflow: el.scrollWidth > el.clientWidth };
      });
      assert.ok(Math.abs(geometry.offset) < 1, JSON.stringify({ width, busy, geometry }));
      assert.equal(geometry.overlap, false, JSON.stringify({ width, busy, geometry }));
      assert.equal(geometry.overflow, false);
    }
  }
  await page.evaluate(() => window.store.setState({ loading: false }));
  await page.setViewportSize({ width: 1280, height: 840 });
  // Deliberately retain unrelated library selection: file operations must never consume it.
  await page.evaluate(() => window.store.setState({ mode: 'manage', selectedIds: new Set(['a', 'b']) }));
  for (const source of ['文件浏览器']) {
    await page.getByRole('button', { name: '文件浏览器', exact: true }).click();
    await first.waitFor();
    await first.click({ button: 'right' });
    await page.getByRole('menuitem', { name: '打开图片详情', exact: true }).waitFor();
    await page.getByRole('menuitem', { name: '删除', exact: true }).click();
    for (const name of ['重命名', '打开所在文件夹', '用系统程序打开', '复制文件路径', source === '文件浏览器' ? '删除本机文件' : '移除外部引用记录']) {
      await page.getByRole('menuitem', { name, exact: true }).waitFor();
    }
    assert.equal(await page.evaluate(() => window.store.getState().contextMenu.assetId), 'external-original');
    await page.screenshot({ path: `.tmp/file-context-menu/${source}.png` });
    await page.getByRole('menuitem', { name: '用系统程序打开', exact: true }).click();
    await page.waitForFunction(() => !window.store.getState().contextMenu);
    await first.click({ button: 'right' });
    await page.getByRole('menuitem', { name: '打开图片详情', exact: true }).click();
    await page.locator('.asset-detail-stage').waitFor();
    assert.equal(await page.evaluate(() => window.store.getState().detailAssetId), 'external-original');
    await page.locator('.asset-detail-back').click();
    await first.click({ button: 'right' });
    await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
    await page.getByText(source === '文件浏览器' ? '直接修改本机文件名，保留扩展名，并同步素材引用。同名文件不会被覆盖。' : '仅更新园丁鸟中的引用名称，电脑中的原文件名保持不变。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await first.click({ button: 'right' });
    await page.getByRole('menuitem', { name: '管理外部引用 · 原图保留', exact: true }).click();
    await page.getByRole('dialog', { name: '外部引用', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await first.click();
    await second.click({ modifiers: ['Control'] });
    await first.click({ button: 'right' });
    await page.getByRole('menu', { name: '已选 2 项素材的操作', exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.store.getState().contextMenu.fileSelection.assets.map(a => a.id)), ['external-original', 'external-other']);
    assert.equal(await page.getByRole('menuitem', { name: '用选中的内容新建集合', exact: true }).count(), 0);
    await page.getByRole("menuitem", { name: "删除", exact: true }).click();
  await page.getByRole('menuitem', { name: source === '文件浏览器' ? '删除本机文件' : '移除引用 · 原文件保留', exact: true }).click();
    await page.getByRole('dialog', { name: source === '文件浏览器' ? '删除 2 个本机文件' : '移除 2 项外部引用', exact: true }).waitFor();
    assert.deepEqual(await page.locator('[data-delete-asset-id]').evaluateAll(els => els.map(el => el.dataset.deleteAssetId)), ['external-original', 'external-other']);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await first.click();
    await first.press('Shift+F10');
    await page.getByRole('menuitem', { name: '选择', exact: true }).click();
    assert.equal(await first.getAttribute('aria-pressed'), 'true');
    await second.click();
    assert.equal(await page.locator('.folder-media-card[aria-pressed="true"]').count(), 2, 'normal clicks accumulate in multiselect mode');
    await first.click();
    assert.equal(await page.locator('.folder-media-card[aria-pressed="true"]').count(), 1);
    await page.getByRole('button', { name: '取消文件选择', exact: true }).click();
    await first.click(); await second.click({ modifiers: ['Shift'] });
    assert.equal(await page.locator('.folder-media-card[aria-pressed="true"]').count(), 2, 'shift range');
    await page.getByRole('button', { name: '取消文件选择', exact: true }).click();
    await first.focus(); await page.keyboard.press('Control+a');
    assert.equal(await page.locator('.folder-media-card[aria-pressed="true"]').count(), 2, 'select all only includes media');
    await page.getByRole('button', { name: '取消文件选择', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => [...window.store.getState().selectedIds]), ['a', 'b']);
    // A failed or dismissed asynchronous lookup must not leave a ghost menu.
    await page.evaluate(() => { window.holdIndex = true; });
    await first.click({ button: 'right' });
    await page.waitForFunction(() => window.releaseIndex);
    await page.getByRole('menu', { name: '正在准备素材操作' }).waitFor();
    await page.keyboard.press('Escape');
    await page.evaluate(() => { window.holdIndex = false; window.releaseIndex(); window.releaseIndex = null; });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.store.getState().contextMenu), null);
    await page.evaluate(() => { window.failIndex = true; });
    await first.click({ button: 'right' });
    await page.getByText('原图片不可用', { exact: true }).last().waitFor();
    assert.equal(await page.evaluate(() => window.store.getState().contextMenu), null);
    await page.evaluate(() => { window.failIndex = false; });
  }
  await page.evaluate(() => { window.holdIndex = true; });
  await first.click({ button: 'right' });
  await page.waitForFunction(() => window.releaseIndex);
  await page.getByRole('button', { name: '文件浏览器', exact: true }).click();
  await page.evaluate(() => { window.holdIndex = false; window.releaseIndex(); window.releaseIndex = null; });
  await page.locator('.local-file-workspace').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.store.getState().contextMenu), null, 'switching sources cancels pending menu');
  await page.getByRole('button', { name: '文件浏览器', exact: true }).click(); await first.waitFor();
  // Rename changes the listed file and uses the exact path. Failures keep the dialog editable.
  await first.click({ button: 'right' }); await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  await page.getByLabel('素材名称', { exact: true }).fill('改名后');
  await page.evaluate(() => { window.failFileRename = true; });
  await page.getByRole('button', { name: '保存名称', exact: true }).click();
  await page.getByText('同名文件已存在', { exact: true }).waitFor();
  await page.evaluate(() => { window.failFileRename = false; });
  await page.getByRole('button', { name: '保存名称', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const renamed = page.locator('.folder-media-card[aria-label="改名后.png"]'); await renamed.waitFor();
  assert.equal(await first.count(), 0);
  assert.deepEqual(await page.evaluate(() => window.calls.filter(c => c.command === 'local_file_rename').at(-1).args), {assetId:'external-original',path:'/pictures/original.png',name:'改名后'});
  await renamed.click({ button: 'right' }); await page.getByRole("menuitem", { name: "删除", exact: true }).click();
  await page.getByRole('menuitem', { name: '删除本机文件', exact: true }).click();
  await page.getByRole('dialog', { name: '删除 1 个本机文件', exact: true }).waitFor();
  await page.getByText('/pictures/改名后.png', { exact: true }).waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.command === 'local_file_delete').length), 0, 'cancel never deletes');
  // Execute only synthetic deletion; a partial failure retries only the failed file.
  await renamed.click(); await second.click({ modifiers: ['Control'] }); await renamed.click({ button: 'right' });
  await page.getByRole("menuitem", { name: "删除", exact: true }).click();
  await page.getByRole('menuitem', { name: '删除本机文件', exact: true }).click();
  await page.getByRole('dialog', { name: '删除 2 个本机文件', exact: true }).waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: '.tmp/file-context-menu/delete-confirm.png' });
  const reads = await page.evaluate(() => window.calls.filter(c => c.command === 'external_files_browse').length);
  await page.evaluate(() => { window.failFileDeleteId = 'external-other'; });
  await page.getByRole('button', { name: '删除本机文件', exact: true }).click();
  await page.getByRole('button', { name: '重试失败项', exact: true }).waitFor();
  assert.deepEqual(await page.locator('[data-delete-asset-id]').evaluateAll(els => els.map(el => el.dataset.deleteAssetId)), ['external-other']);
  await page.evaluate(() => { window.failFileDeleteId = null; });
  await page.getByRole('button', { name: '重试失败项', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(reads => window.calls.filter(c => c.command === 'external_files_browse').length > reads, reads);
  assert.deepEqual(await page.evaluate(() => window.calls.filter(c => c.command === 'local_file_delete').map(c => c.args.assetId)), ['external-original', 'external-other', 'external-other']);
  await renamed.waitFor({ state: 'hidden' }); await second.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.command === 'external_files_copy').length), 0);
  // A fresh home selection creates a persisted project library, without canvas nodes or prompt references.
  await page.reload();
  await page.getByRole('button', { name: '返回主页', exact: true }).click();
  await page.getByRole('button', { name: '文件浏览器', exact: true }).click();
  await first.waitFor(); await first.click(); await second.click({ modifiers: ['Control'] });
  await page.getByRole('button', { name: '把所选素材添加到新项目', exact: true }).click();
  await page.waitForFunction(() => window.store.getState().activeProjectId === 'library-project');
  await page.waitForFunction(() => window.store.getState().assets.length === 2);
  assert.deepEqual(await page.evaluate(() => window.calls.filter(c => c.command === 'add_assets_to_project').map(c => c.args)), [
    { projectId: 'library-project', assetIds: ['external-original', 'external-other'] },
  ]);
  assert.deepEqual(await page.evaluate(() => window.store.getState().assets.map(a => a.id)), ['external-original', 'external-other']);
  assert.equal(await page.evaluate(() => window.calls.filter(c => ['project_canvas_node_create', 'project_canvas_thread_create', 'external_files_copy', 'project_canvas_materialize'].includes(c.command)).length), 0);
  assert.equal(await page.locator('.canvas-asset-node').count(), 0);
  await page.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => command === 'material_catalog_assets' ? window.store.getState().assets : invoke(command, args);
  });
  await page.getByRole('button', { name: '展开画板素材库', exact: true }).click();
  await page.getByRole('tab', { name: '项目素材', exact: true }).click();
  await page.locator('.canvas-source-panel [data-asset-id="external-original"]').waitFor();
  await page.locator('.canvas-source-panel [data-asset-id="external-other"]').waitFor();
  await page.screenshot({ path: '.tmp/file-context-menu/new-project-library.png' });
  await page.getByRole('tab', { name: '全局素材', exact: true }).click();
  await page.setViewportSize({ width: 760, height: 840 });
  await page.getByRole('button', { name: '颜色筛选', exact: true }).click();
  await page.waitForTimeout(240);
  const colorLayout = await page.locator('.canvas-source-panel .library-color-control').evaluate(el => {
    const heading = el.closest('.file-view-heading');
    const panel = document.querySelector('.canvas-source-panel').getBoundingClientRect();
    const nav = heading.querySelector('.library-browser-heading').getBoundingClientRect();
    return { right: el.getBoundingClientRect().right, limit: panel.right, left: nav.left,
      count: el.querySelectorAll('.library-filter-colors button').length };
  });
  assert.ok(colorLayout.right < colorLayout.limit && colorLayout.left >= 0, JSON.stringify(colorLayout));
  assert.equal(colorLayout.count, 12);
  await page.screenshot({ path: '.tmp/file-context-menu/project-colors.png' });
  assert.deepEqual(errors, []);
  console.log('PASS centered global search; file menus, persistent multiselect, Ctrl/Shift/select-all, rename, physical-delete confirmation/cancel/partial retry, refresh, stale menu cancellation and new project library without canvas/prompt references');
} catch (error) {
  console.error(errors); console.error((await page.locator('body').innerText()).slice(-2500));
  await page.screenshot({ path: '.tmp/file-context-menu/failure.png' });
  throw error;
} finally { await browser.close(); await server.close(); }
