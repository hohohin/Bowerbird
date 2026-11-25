import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ server: { host: '127.0.0.1', port: 1796, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
page.setDefaultTimeout(8000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
const root = () => page.getByRole('menu', { name: '素材操作', exact: true });
const deletion = () => page.getByRole('menu', { name: '删除', exact: true });
const open = async (kind = 'single', x = 100, y = 100) => {
  await page.evaluate(args => window.openMenu(...args), [kind, x, y]);
  await page.locator('.asset-context-menu').waitFor();
};
const close = async () => { await page.evaluate(() => window.fixtureStore.getState().closeContextMenu()); await page.locator('.asset-context-menu').waitFor({ state: 'hidden' }); };
const focused = () => page.evaluate(() => document.activeElement?.textContent?.trim());
async function bounds() {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const result = await page.locator('.context-menu-surface').evaluateAll(elements => elements.map(el => {
    const rect = el.getBoundingClientRect(), scroll = el.querySelector('.collection-scroll-viewport');
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight,
      gutter: scroll.offsetWidth - scroll.clientWidth };
  }));
  for (const r of result) { assert.ok(r.left >= 7 && r.top >= 7 && r.right <= r.width - 7 && r.bottom <= r.height - 7, JSON.stringify(r)); assert.equal(r.gutter, 0); }
}
try {
  await mkdir('.tmp/context-menu', { recursive: true });
  await page.goto('http://127.0.0.1:1796/scripts/fixtures/asset-multi-menu/preview.html', { waitUntil: 'domcontentloaded' });
  await open();
  assert.equal(await root().getByRole('menuitem', { name: '编辑', exact: true }).locator('svg[viewBox="0 0 1024 1024"]').count(), 1);
  await close();
  await page.locator('#trigger').click();
  await root().getByRole('menuitem', { name: '编辑标签', exact: true }).click();
  const tagDialog = page.getByRole('dialog', { name: '编辑标签', exact: true });
  await tagDialog.getByText('已选 1 项素材', { exact: true }).waitFor();
  await tagDialog.getByRole('textbox', { name: '搜索标签', exact: true }).press('Escape');
  await tagDialog.waitFor({ state: 'detached' });
  assert.equal(await page.locator('#trigger').evaluate(el => el === document.activeElement), true);
  await open('canvas-mixed');
  for (const name of ['调整层级', '整理', '添加到对话框']) {
    assert.equal(await page.getByRole('menuitem', { name, exact: true }).isEnabled(), true);
  }
  assert.equal(await page.getByRole('menuitem', { name: /整组操作/ }).count(), 0);
  await page.getByRole('menuitem', { name: '从画布移出所选 2 项', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.removedCanvasNodes), ['n1', 'n2']);
  await page.locator('#trigger').click();
  await page.evaluate(() => window.fixtureStore.setState({ promptedAssets: [{ id: 'a1', sections: [{ title: '构图', body: '中心构图' }] }], boardOpen: true }));
  await root().getByRole('menuitem', { name: '维度', exact: true }).click();
  const ring = page.getByRole('group', { name: '可选维度环' });
  await ring.waitFor();
  await page.mouse.move(1200, 780);
  await page.waitForTimeout(250);
  await ring.locator('.caption-ring-sector-label').click({ force: true });
  assert.equal(await page.evaluate(() => window.fixtureStore.getState().pendingKeyword?.title), '构图');
  await page.evaluate(() => window.fixtureStore.setState({ boardOpen: false }));
  assert.equal(await page.evaluate(async () => (await import('/src/store.ts')).useStore.getState().captionRing), 'a1');
  await page.evaluate(async () => (await import('/src/store.ts')).useStore.getState().closeCaptionRing());
  await page.locator('#trigger').click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await root().getByRole('menuitem', { name: '删除原文件…', exact: true }).count(), 0);
  // ArrowRight never changes column. Down traverses DOM order, left column then right.
  await root().getByRole('menuitem', { name: '打开图片详情', exact: true }).focus();
  await page.keyboard.press('ArrowRight'); assert.equal(await focused(), '打开图片详情');
  const leftLast = root().locator('.asset-context-column').first().getByRole('menuitem').last();
  await leftLast.focus(); await page.keyboard.press('ArrowDown'); assert.equal(await focused(), '添加到文件夹');
  await page.keyboard.press('ArrowUp'); assert.equal(await focused(), (await leftLast.textContent()).trim());
  await root().getByRole('menuitem', { name: '反推提示词', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await page.getByRole('menu', { name: '选择反推引擎' }).waitFor();
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Bowerbird Cloud');
  assert.equal(await focused(), 'Bowerbird Cloud');
  await page.keyboard.press('ArrowDown'); assert.equal(await focused(), 'Bowerbird Cloud', 'skip disabled provider');
  await page.keyboard.press('ArrowLeft'); assert.equal(await focused(), '反推提示词');
  await root().getByRole('menuitem', { name: '删除', exact: true }).focus(); await page.keyboard.press('ArrowRight');
  await deletion().waitFor(); await page.keyboard.press('Escape');
  assert.equal(await deletion().count(), 0); assert.equal(await root().count(), 1); assert.equal(await focused(), '删除');
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#trigger').evaluate(el => el === document.activeElement), true);
  await page.locator('#trigger').click();
  await page.waitForFunction(() => document.activeElement?.textContent.trim() === '打开图片详情'); await page.keyboard.press('Tab');
  await root().waitFor({ state: 'hidden' }); assert.equal(await page.locator('#after').evaluate(el => el === document.activeElement), true);
  // True batch scope, independently of unrelated library selection.
  for (const kind of ['multi', 'canvas']) {
    await open(kind);
    const menu = page.getByRole('menu', { name: '已选 2 项素材的操作', exact: true });
    for (const name of ['重命名', '打开图片详情', '反推提示词', '编辑', '用选中的内容新建文件夹', '移入已有文件夹']) assert.equal(await menu.getByRole('menuitem', { name, exact: true }).count(), 0);
    await menu.getByRole('menuitem', { name: '编辑标签', exact: true }).click();
    await tagDialog.getByText('已选 2 项素材', { exact: true }).waitFor();
    await tagDialog.getByRole('button', { name: '关闭', exact: true }).click();
    await open(kind);
    await menu.getByRole('menuitem', { name: '批量反推', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Bowerbird Cloud', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.describe.splice(0).map(v => v.id)), ['a1', 'a2']);
    const deleteMenu = kind === 'canvas' ? '当前项的项目与原文件' : '删除';
    await open(kind); await menu.getByRole('menuitem', { name: deleteMenu, exact: true }).click();
    await page.getByRole('menu', {name:deleteMenu, exact:true}).getByRole('menuitem', { name: '删除原文件…', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    assert.deepEqual(await page.locator('[data-delete-asset-id]').evaluateAll(els => els.map(el => el.dataset.deleteAssetId)), kind === 'canvas' ? ['a1'] : ['a1','a2']);
    await page.getByRole('button', { name: '取消', exact: true }).click();
  }
  await page.evaluate(() => {
    window.fixtureStore.setState({ mode: 'manage', selectedIds: new Set(['a1', 'a2']) });
    window.fixtureStore.getState().openContextMenu(100, 100, 'a1', {
      canvasSelection: { projectId: 'p1', nodeIds: ['n1'], assetIds: ['a1'],
        deletionTargets: { item: {assetIds:['a1'],removeFromCanvas: () => {}} } },
    });
  });
  await root().waitFor();
  await page.evaluate(() => {
    window.layerSteps = [];
    window.addEventListener('bowerbird:canvas-layer-step', event => window.layerSteps.push(event.detail));
  });
  await root().getByRole('menuitem', { name: '调整层级', exact: true }).focus();
  await page.keyboard.press('Enter'); await page.keyboard.press('Shift+Enter');
  assert.deepEqual(await page.evaluate(() => window.layerSteps), [
    { projectId: 'p1', nodeIds: ['n1'], direction: 1 },
    { projectId: 'p1', nodeIds: ['n1'], direction: -1 },
  ]);
  const dragLayer = root().getByRole('menuitem', { name: '调整层级', exact: true });
  const dragBox = await dragLayer.boundingBox();
  await page.mouse.move(dragBox.x + 20, dragBox.y + dragBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(dragBox.x + 20, dragBox.y - 25);
  await page.waitForFunction(() => window.layerSteps.length >= 3);
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.layerSteps[2].direction), 1);
  const beforeExplicit = await page.evaluate(() => window.layerSteps.length);
  await root().getByRole('menuitem', { name: '层级操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '下移一层', exact: true }).click();
  assert.deepEqual(await page.evaluate(start => window.layerSteps.slice(start), beforeExplicit), [
    { projectId: 'p1', nodeIds: ['n1'], direction: -1 },
  ]);
  await page.evaluate(() => {
    const store = window.fixtureStore.getState();
    store.openContextMenu(100, 100, 'a1', { canvasSelection: { projectId: 'p1', nodeIds: ['n1'],
      deletionTargets: { item: { assetIds: ['a1'], removeFromCanvas: () => {} } } } });
  });
  await root().waitFor();
  await root().getByRole('menuitem', { name: '项目与原文件', exact: true }).click();
  await page.getByRole('menu', {name:'项目与原文件', exact:true}).getByRole('menuitem', { name: '删除原文件…', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  assert.deepEqual(await page.locator('[data-delete-asset-id]').evaluateAll(els => els.map(el => el.dataset.deleteAssetId)), ['a1'], 'single canvas target ignores library multiselect');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.evaluate(() => { window.holdGroupCheck = true; window.holdCanvasCheck = true; });
  await open('generated');
  await root().getByRole('menuitem', { name: '删除', exact: true }).click();
  const canvasLibraryCheck = deletion().getByRole('menuitem', { name: '从库中删除 · 在画布保留', exact: true });
  const groupCheck = deletion().getByRole('menuitem', { name: /^删除整组原文件/ });
  assert.equal(await canvasLibraryCheck.getAttribute('title'), '正在检查画布状态…');
  assert.equal(await canvasLibraryCheck.isEnabled(), false);
  assert.equal(await groupCheck.isEnabled(), false);
  const beforeHeight = [await root().boundingBox(), await deletion().boundingBox()].map(box => box.height);
  await page.waitForFunction(() => window.releaseCanvasCheck && window.releaseGroupCheck);
  await page.evaluate(() => { window.releaseCanvasCheck(); window.releaseGroupCheck(); });
  await groupCheck.filter({ hasText: '2 张' }).waitFor();
  assert.equal(await groupCheck.isEnabled(), true);
  assert.equal(await canvasLibraryCheck.isEnabled(), true);
  assert.deepEqual([await root().boundingBox(), await deletion().boundingBox()].map(box => box.height),
    beforeHeight, 'library and group checks preserve the open menu dimensions');
  await close();
  for (const [status, title] of [
    ['unavailable', '请先将图片拖到当前画布'],
    ['failed', '无法检查画布状态，请重新打开菜单'],
  ]) {
    await page.evaluate(status => { window.holdCanvasCheck = false; window.holdGroupCheck = false; window.canvasCheck = status; }, status);
    await open('generated');
    await root().getByRole('menuitem', { name: '删除', exact: true }).click();
    await canvasLibraryCheck.and(deletion().locator(`[title="${title}"]`)).waitFor();
    assert.equal(await canvasLibraryCheck.isEnabled(), false);
    await close();
  }
  assert.deepEqual(await page.evaluate(() => window.calls.filter(({ command }) =>
    command === 'project_canvas_has_asset' || command === 'project_canvas_get')), Array.from({ length: 3 }, () =>
    ({ command: 'project_canvas_has_asset', args: { projectId: 'p1', assetId: 'a1' } })));
  for (const kind of ['video', 'audio', 'mixed', 'external']) {
    await open(kind);
    if (kind !== 'external') for (const name of ['反推提示词', '批量反推', '编辑', '分层编辑', '复制图片']) assert.equal(await page.getByRole('menuitem', { name, exact: true }).count(), 0);
    if (kind === 'video') {
      assert.equal(await root().getByRole('menuitem', { name: '打开视频详情', exact: true }).count(), 0);
      assert.equal(await root().getByRole('menuitem', { name: '转录文稿', exact: true }).isEnabled(), true);
    }
    if (kind === 'audio') {
      assert.equal(await root().getByRole('menuitem', { name: '打开音频详情', exact: true }).isEnabled(), true);
      assert.equal(await root().getByRole('menuitem', { name: '转录文稿', exact: true }).isEnabled(), true);
    }
    if (kind === 'external') { await page.getByRole('menuitem', { name: '删除', exact: true }).click(); assert.equal(await page.getByRole('menuitem', { name: '移出园丁鸟' }).count(), 0); }
    await close();
  }
  await page.evaluate(() => {
    const store = window.fixtureStore.getState();
    const target = store.assets.find(asset => asset.id === 'external');
    store.openContextMenu(100, 100, target.id, { asset: target, fileSelection: {
      assets: [target], localPaths: { external: 'C:/test/真实文件名.png' }, select: () => {}, openReferences: () => {},
    } });
  });
  await root().waitFor();
  assert.equal(await root().getByRole('menuitem', { name: '移动到项目', exact: true }).count(), 0);
  const localRename = root().getByRole('menuitem', { name: '重命名', exact: true });
  assert.equal(await localRename.getAttribute('title'), '重命名本机文件');
  await localRename.click();
  const renameDialog = page.getByRole('dialog', { name: '重命名素材' });
  const renameInput = renameDialog.getByLabel('素材名称');
  assert.equal(await renameInput.inputValue(), '真实文件名');
  await renameInput.fill('新名字');
  await renameDialog.getByRole('button', { name: '保存名称' }).click();
  await renameDialog.waitFor({ state: 'hidden' });
  assert.deepEqual(await page.evaluate(() => window.calls.find(call => call.command === 'local_file_rename')?.args),
    { assetId: 'external', path: 'C:/test/真实文件名.png', name: '新名字' });
  // An old asynchronous operation must not close a newly opened menu.
  await open(); await page.evaluate(() => { window.holdReveal = true; });
  await root().getByRole('menuitem', { name: '打开所在文件夹' }).click();
  await page.waitForFunction(() => window.releaseReveal);
  await close(); await open('video'); await page.evaluate(() => { window.releaseReveal(); window.holdReveal = false; });
  await root().getByRole('menuitem', { name: '转录文稿', exact: true }).waitFor(); await close();
  // Both themes, every corner, short/narrow windows and resize while submenu is open.
  for (const theme of ['light', 'dark']) for (const [width, height] of [[1280,840],[700,320],[480,360]]) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.setViewportSize({ width, height });
    for (const [x,y] of [[8,8],[width-8,8],[8,height-8],[width-8,height-8]]) {
      await open('single', x, y); await bounds();
      await root().getByRole('menuitem', { name: '删除', exact: true }).click(); await deletion().waitFor(); await bounds();
      await page.screenshot({ path: `.tmp/context-menu/${theme}-${width}-${x}-${y}.png` }); await close();
    }
  }
  await page.setViewportSize({ width: 1280, height: 840 });
  await open(); await root().getByRole('menuitem', { name: '删除', exact: true }).hover(); await deletion().waitFor();
  const p = await deletion().getByRole('menuitem').first().boundingBox(); await page.mouse.move(p.x+p.width/2,p.y+p.height/2,{steps:12}); await deletion().waitFor();
  await page.setViewportSize({width:480,height:360}); await bounds(); await close();
  await page.setViewportSize({width:1280,height:840});
  await page.locator('#project').click();
  assert.equal(await page.getByRole('menuitem', { name: '更新项目文件' }).count(), 0);
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === '重命名');
  await page.keyboard.press('End'); assert.equal(await focused(), '删除项目 · 素材保留'); await page.keyboard.press('Escape');
  await page.locator('#disconnect').click(); await page.waitForFunction(() => document.activeElement?.textContent?.includes('图片输入')); await page.keyboard.press('Escape');
  await page.locator('.session-test').focus(); await page.keyboard.press('Shift+F10'); await page.getByRole('menu', { name: '生成会话操作' }).waitFor();
  await page.waitForFunction(() => document.activeElement?.closest('[role="menu"][aria-label="生成会话操作"]'));
  await page.keyboard.press('End'); assert.equal(await focused(), '复制本次会话诊断信息'); await page.keyboard.press('Escape');
  await page.locator('[data-tag-id="tag1"]').click({button:'right'}); await page.getByRole('menu', {name:'标签操作'}).waitFor(); await page.keyboard.press('Escape');
  assert.equal(await page.locator('[data-tag-id="tag1"]').evaluate(el => el === document.activeElement), true);
  assert.deepEqual(errors, []);
  console.log('PASS context menus: batch scope, delete submenu, media capabilities, keyboard/focus, stale async completion, themes/corners/resize/zero-gutter, project/tag/wire/session menus');
} catch(error) { console.error('Browser errors:', errors); await page.screenshot({path:'.tmp/context-menu/failure.png'}); throw error; }
finally { await browser.close(); await server.close(); }
