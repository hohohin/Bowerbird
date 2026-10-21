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
  await page.locator('#trigger').click();
  assert.equal(await root().getByRole('menuitem', { name: '物理删除', exact: true }).count(), 0);
  // ArrowRight never changes column. Down traverses DOM order, left column then right.
  await root().getByRole('menuitem', { name: '打开图片详情', exact: true }).focus();
  await page.keyboard.press('ArrowRight'); assert.equal(await focused(), '打开图片详情');
  const leftLast = root().locator('.asset-context-column').first().getByRole('menuitem').last();
  await leftLast.focus(); await page.keyboard.press('ArrowDown'); assert.equal(await focused(), '添加到集合');
  await page.keyboard.press('ArrowUp'); assert.equal(await focused(), (await leftLast.textContent()).trim());
  await root().getByRole('menuitem', { name: '反推提示词', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await page.getByRole('menu', { name: '选择反推引擎' }).waitFor();
  assert.equal(await focused(), 'Bowerbird Cloud');
  await page.keyboard.press('ArrowDown'); assert.equal(await focused(), 'Bowerbird Cloud', 'skip disabled provider');
  await page.keyboard.press('ArrowLeft'); assert.equal(await focused(), '反推提示词');
  await root().getByRole('menuitem', { name: '删除', exact: true }).focus(); await page.keyboard.press('ArrowRight');
  await deletion().waitFor(); await page.keyboard.press('Escape');
  assert.equal(await deletion().count(), 0); assert.equal(await root().count(), 1); assert.equal(await focused(), '删除');
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#trigger').evaluate(el => el === document.activeElement), true);
  await page.locator('#trigger').click(); await page.keyboard.press('Tab');
  await root().waitFor({ state: 'hidden' }); assert.equal(await page.locator('#after').evaluate(el => el === document.activeElement), true);
  // True batch scope, independently of unrelated library selection.
  for (const kind of ['multi', 'canvas']) {
    await open(kind);
    const menu = page.getByRole('menu', { name: '已选 2 项素材的操作', exact: true });
    for (const name of ['重命名', '打开图片详情', '反推提示词', '图片标注', '用选中的内容新建集合', '移入已有集合']) assert.equal(await menu.getByRole('menuitem', { name, exact: true }).count(), 0);
    await menu.getByRole('menuitem', { name: '批量反推', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Bowerbird Cloud', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.describe.splice(0).map(v => v.id)), ['a1', 'a2']);
    await open(kind); await menu.getByRole('menuitem', { name: '删除', exact: true }).click();
    await deletion().getByRole('menuitem', { name: '物理删除', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    assert.deepEqual(await page.locator('[data-delete-asset-id]').evaluateAll(els => els.map(el => el.dataset.deleteAssetId)), ['a1', 'a2']);
    await page.getByRole('button', { name: '取消', exact: true }).click();
  }
  await page.evaluate(() => {
    window.fixtureStore.setState({ mode: 'manage', selectedIds: new Set(['a1', 'a2']) });
    window.fixtureStore.getState().openContextMenu(100, 100, 'a1', {
      canvasSelection: { projectId: 'p1', nodeIds: ['n1'], assetIds: ['a1'] },
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
  await root().getByRole('menuitem', { name: '删除', exact: true }).click();
  await deletion().getByRole('menuitem', { name: '物理删除', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  assert.deepEqual(await page.locator('[data-delete-asset-id]').evaluateAll(els => els.map(el => el.dataset.deleteAssetId)), ['a1'], 'single canvas target ignores library multiselect');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  for (const kind of ['video', 'mixed', 'external']) {
    await open(kind);
    if (kind !== 'external') for (const name of ['反推提示词', '批量反推', '图片标注', '分层编辑', '复制图片']) assert.equal(await page.getByRole('menuitem', { name, exact: true }).count(), 0);
    if (kind === 'video') await page.getByRole('menuitem', { name: '打开视频详情' }).waitFor();
    if (kind === 'external') { await page.getByRole('menuitem', { name: '删除', exact: true }).click(); assert.equal(await page.getByRole('menuitem', { name: '移出园丁鸟' }).count(), 0); }
    await close();
  }
  // An old asynchronous operation must not close a newly opened menu.
  await open(); await page.evaluate(() => { window.holdReveal = true; });
  await root().getByRole('menuitem', { name: '打开所在文件夹' }).click();
  await page.waitForFunction(() => window.releaseReveal);
  await close(); await open('video'); await page.evaluate(() => { window.releaseReveal(); window.holdReveal = false; });
  await page.getByRole('menuitem', { name: '打开视频详情' }).waitFor(); await close();
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
  await page.keyboard.press('End'); assert.equal(await focused(), '删除'); await page.keyboard.press('Escape');
  await page.locator('#disconnect').click(); await page.waitForFunction(() => document.activeElement?.textContent?.includes('图片输入')); await page.keyboard.press('Escape');
  await page.locator('.session-test').focus(); await page.keyboard.press('Shift+F10'); await page.getByRole('menu', { name: '生成会话操作' }).waitFor();
  await page.keyboard.press('End'); assert.equal(await focused(), '复制本次会话诊断信息'); await page.keyboard.press('Escape');
  await page.locator('[data-tag-id="tag1"]').click({button:'right'}); await page.getByRole('menu', {name:'标签操作'}).waitFor(); await page.keyboard.press('Escape');
  assert.equal(await page.locator('[data-tag-id="tag1"]').evaluate(el => el === document.activeElement), true);
  assert.deepEqual(errors, []);
  console.log('PASS context menus: batch scope, delete submenu, media capabilities, keyboard/focus, stale async completion, themes/corners/resize/zero-gutter, project/tag/wire/session menus');
} catch(error) { console.error('Browser errors:', errors); await page.screenshot({path:'.tmp/context-menu/failure.png'}); throw error; }
finally { await browser.close(); await server.close(); }
