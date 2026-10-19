import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ server: { host: '127.0.0.1', port: 1682, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const pathValue = () => page.locator('[aria-label="文件夹路径"]').inputValue();
const browseCount = () => page.evaluate(() => window.calls.filter(c => c.command === 'external_files_browse').length);
async function edit(value) {
  await page.getByRole('group', { name: '文件夹地址栏' }).click({position:{x:2,y:2}});
  await page.getByRole('textbox', { name: '文件夹路径' }).fill(value);
}
try {
  await page.goto('http://127.0.0.1:1682/scripts/fixtures/folder-mode/preview.html');
  await page.locator('[role="tab"][data-tab-value="files"]').click();
  await page.getByRole('button', { name: 'photo.png', exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: '文件夹路径' }).count(), 0);
  assert.equal(await page.getByText('浏览不入库', { exact: false }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'photo.png', exact: true }).innerText(), '');
  assert.equal(await page.locator('.folder-media-name').innerText(), '旅行');
  assert.equal(await page.getByRole('button', { name: '截图', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '编辑文件夹路径' }).count(), 0);
  assert.equal(await page.locator('.app-topbar .folder-navigation').count(), 1);
  assert.equal(await page.getByRole('group', { name: '文件夹地址栏' }).getByRole('button', { name: '刷新文件夹' }).count(), 1);
  const folderPicker = page.getByRole('group', { name: '文件夹地址栏' }).getByRole('button', { name: '选择浏览文件夹' });
  const beforePicker = await browseCount();
  await page.evaluate(() => { window.cancelFolderPicker = true; });
  await folderPicker.click();
  assert.equal(await browseCount(), beforePicker, 'cancelling the system picker preserves the current directory');
  assert.equal(await page.getByRole('textbox', { name: '文件夹路径' }).count(), 0, 'folder button does not start path editing');
  assert.deepEqual(await page.evaluate(() => window.calls.filter(c => c.command === 'plugin:dialog|open').at(-1).args.options), { directory:true, multiple:false, title:'选择文件夹', defaultPath:'/pictures' });
  await page.evaluate(() => { window.cancelFolderPicker = false; });
  await folderPicker.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('[aria-label="文件夹路径"]').value === '/picked');
  await page.getByRole('button', { name: '返回上次目录' }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="文件夹路径"]').value === '/pictures');
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.command === 'file_colors').length), 0, 'browsing does not scan colors');
  await page.getByRole('button', { name: '颜色筛选', exact: true }).click();
  const colors = page.getByRole('dialog', { name: '颜色筛选', exact: true });
  await colors.getByRole('button', { name: '红', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.folder-media-card').length === 1);
  assert.equal(await page.locator('.folder-media-card').getAttribute('aria-label'), 'photo.png');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '更多文件操作', exact: true }).click();
  await page.getByRole('button', { name: '只看视频', exact: true }).click();
  assert.equal(await page.locator('.folder-media-card').count(), 0, 'color and type filters combine');
  await page.getByRole('group', { name: '素材类型筛选' }).getByRole('button', { name: '全部', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '颜色筛选', exact: true }).click();
  await page.getByRole('button', { name: '清除颜色筛选' }).click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.folder-media-card').count(), 3);
  assert.equal(await page.evaluate(() => window.calls.some(c => c.command === 'external_files_index')), false);
  await page.evaluate(() => { window.colorFailure = true; });
  await page.getByRole('button', { name: '刷新文件夹' }).click();
  await page.getByRole('button', { name: '颜色筛选', exact: true }).click();
  await colors.getByRole('button', { name: '2 项读取失败 · 重试', exact: true }).waitFor();
  await page.evaluate(() => { window.colorFailure = false; });
  await colors.getByRole('button', { name: '2 项读取失败 · 重试', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.folder-popover')?.textContent.includes('读取失败') && !document.querySelector('.folder-popover [role="status"]'));
  await page.keyboard.press('Escape');
  const initialCount = await browseCount();
  await edit(''); await page.keyboard.press('Enter');
  assert.equal(await browseCount(), initialCount, 'empty paths never navigate');
  await page.keyboard.press('Escape');
  assert.equal(await pathValue(), '/pictures');
  assert.equal(await page.getByRole('region', { name: '本机文件' }).count(), 1);
  await page.getByRole('textbox', { name: '搜索当前文件夹', exact: true }).focus();
  await page.keyboard.press('Control+l');
  assert.equal(await page.getByRole('textbox', { name: '文件夹路径' }).evaluate(e => document.activeElement === e && e.selectionEnd === e.value.length), true);
  await page.getByRole('textbox', { name: '文件夹路径' }).fill('/not-submitted');
  await page.keyboard.press('Control+l');
  assert.equal(await page.getByRole('textbox', { name: '文件夹路径' }).evaluate(e => e.selectionStart === 0 && e.selectionEnd === e.value.length), true);
  await page.locator('.folder-masonry').click({ position: { x: 3, y: 3 } });
  assert.equal(await pathValue(), '/pictures');
  assert.equal(await browseCount(), initialCount, 'blur cancels unsubmitted edits');
  await edit('C:\\Design\\References'); await page.keyboard.press('Enter');
  await page.getByRole('navigation', { name: '当前文件夹' }).getByRole('button', { name: 'References', exact: true }).waitFor();
  await page.getByRole('navigation', { name: '当前文件夹' }).getByRole('button', { name: 'C:', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="文件夹路径"]').value === 'C:/');
  await edit('\\\\studio-nas\\素材\\灵感'); await page.keyboard.press('Enter');
  await page.getByRole('navigation', { name: '当前文件夹' }).getByRole('button', { name: '//studio-nas/素材', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="文件夹路径"]').value === '//studio-nas/素材');
  await edit('/'); await page.keyboard.press('Enter');
  await page.getByRole('navigation', { name: '当前文件夹' }).getByRole('button', { name: '根目录', exact: true }).waitFor();
  await page.getByRole('button', { name: '更多文件操作', exact: true }).click();
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), '迁移资料目录');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('button', { name: '更多文件操作', exact: true }).evaluate(e => document.activeElement === e), true);
  await page.getByRole('button', { name: '文件位置', exact: true }).click();
  await page.locator('.folder-masonry').click({ position: { x: 3, y: 3 } });
  assert.equal(await page.getByRole('dialog', { name: '文件位置', exact: true }).count(), 0);

  // Use bundled sample art and synthetic directory data; no user's filesystem or database.
  await page.evaluate(() => {
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.convertFileSrc = path => path;
    window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (command === 'external_files_browse' && args.path === '/灵感素材/视觉参考') return { path: args.path, parent: '/灵感素材', total: 15,
        entries: args.offset ? [] : [{ path: args.path + '/品牌设计', name: '品牌设计', directory: true }, ...Array.from({ length: 14 }, (_, i) => ({ path: args.path + `/sample-${i + 1}.png`, name: `sample-${i + 1}.png`, directory: false }))] };
      if (command === 'external_files_preview' && args.path.includes('/sample-')) {
        const n = Number(args.path.match(/sample-(\d+)/)[1]);
        return `/src-tauri/resources/samples/preset-${String(n).padStart(2, '0')}.${n > 11 ? 'png' : 'webp'}`;
      }
      return original(command, args);
    };
  });
  await edit('/灵感素材/视觉参考'); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'sample-1.png', exact: true }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.folder-media-preview img')].filter(img => img.complete && img.naturalWidth > 0).length >= 6);
  const card = page.getByRole('button', { name: 'sample-1.png', exact: true });
  const size = page.getByRole('spinbutton', { name: '主页素材大小数值' });
  await size.fill('15'); await size.press('Enter'); await page.waitForTimeout(450);
  const small = await card.boundingBox();
  await size.fill('80'); await size.press('Enter'); await page.waitForTimeout(450);
  assert.ok((await card.boundingBox()).width > small.width + 40, 'slider changes actual card geometry');
  await size.fill('45'); await size.press('Enter'); await page.waitForTimeout(450);
  await mkdir('.tmp/file-browser-design', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    for (const width of [1280, 760]) {
      await page.setViewportSize({ width, height: 840 }); await page.waitForTimeout(1000);
      await page.waitForFunction(() => {
        const cards = [...document.querySelectorAll('.folder-media-card')].map(el => el.getBoundingClientRect());
        return cards.every((a, i) => cards.slice(i + 1).every(b => Math.min(a.right, b.right) - Math.max(a.left, b.left) < 1 || Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) < 1));
      });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const layout = await page.locator('.app-topbar').evaluate(el => {
        const address = el.querySelector('.app-file-navigation-slot').getBoundingClientRect();
        const search = el.querySelector('.app-search').getBoundingClientRect();
        return { aligned: Math.abs(address.y + address.height / 2 - search.y - search.height / 2) < 1, separate: address.right <= search.left, smallSearch: search.width <= 241 };
      });
      assert.deepEqual(layout, { aligned: true, separate: true, smallSearch: true });
      const floating = await page.locator('.file-view-heading').evaluate(el => {
        const workspace = el.closest('.local-file-workspace');
        const grid = workspace.querySelector('.folder-browser-grid');
        const card = grid.querySelector('.folder-media-card');
        const before = card.getBoundingClientRect().top;
        const rect = el.getBoundingClientRect();
        const clickThrough = !el.contains(document.elementFromPoint(rect.left + 2, rect.top + rect.height / 2));
        el.style.display = 'none';
        const after = card.getBoundingClientRect().top;
        el.style.removeProperty('display');
        return { noReservedSpace: Math.abs(grid.getBoundingClientRect().top - workspace.getBoundingClientRect().top) < 1, noShift: before === after, clickThrough };
      });
      assert.deepEqual(floating, { noReservedSpace: true, noShift: true, clickThrough: true });
      const slider = page.getByRole('group', { name: '素材缩略图大小调整' });
      assert.equal(await slider.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) && r.bottom <= innerHeight; }), true);
      await page.screenshot({ path: `.tmp/file-browser-design/${theme}-${width}.png` });
    }
  }
  await card.click();
  await page.getByRole('group', { name: '所选文件操作' }).waitFor();
  await page.screenshot({ path: '.tmp/file-browser-design/selection.png' });
  await page.getByRole('button', { name: '取消文件选择' }).click();
  assert.equal(await page.getByRole('group', { name: '所选文件操作' }).count(), 0);
  await page.getByRole('button', { name: '更多文件操作', exact: true }).click();
  await page.screenshot({ path: '.tmp/file-browser-design/actions.png' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '颜色筛选', exact: true }).click();
  await page.screenshot({ path: '.tmp/file-browser-design/colors.png' });
  assert.deepEqual(errors, []);
  console.log('PASS compact navigation, path edit/cancel/blur/shortcut, drive and UNC ancestors, menu keyboard/outside dismissal, image-only cards, slider geometry/hit target, selection, bundled-art light/dark wide/narrow screenshots');
} finally { await browser.close(); await server.close(); }
