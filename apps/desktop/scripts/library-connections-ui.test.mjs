import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

// Standalone design fixture only: no production App, Tauri bridge or user database.
const output = '.tmp/library-connections';
const origin = 'http://127.0.0.1:17872';
const url = `${origin}/scripts/fixtures/library-connections/preview.html`;
await mkdir(output, { recursive: true });
const server = await createServer({
  cacheDir: '.tmp/library-connections-test-vite',
  optimizeDeps: { entries: ['scripts/fixtures/library-connections/preview.html'] },
  server: { host: '127.0.0.1', port: 17872, strictPort: true, hmr: false, watch: null },
});
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
page.setDefaultTimeout(7000);
const runtimeErrors = [], localFailures = [], blockedRequests = [], results = [];
page.on('pageerror', error => runtimeErrors.push(error.message));
page.on('response', response => {
  if (response.url().startsWith(origin) && response.status() >= 400) localFailures.push(`${response.status()} ${response.url()}`);
});
await page.route('**/*', route => {
  if (new URL(route.request().url()).origin === origin) return route.continue();
  blockedRequests.push(route.request().url());
  return route.abort();
});
const cards = () => page.locator('[data-entry]');
const entry = id => page.locator(`[data-entry="${id}"]`);
const folder = id => page.locator(`[data-folder="${id}"]`);
const section = id => page.locator(`section[data-section="${id}"]`);
const currentTitle = () => page.locator('.catalog-section-title[data-current="true"]');
const currentSection = () => page.locator('section[data-section]:has(.catalog-section-title[data-current="true"])');
const topConnect = () => page.locator('.connection-topbar').getByRole('button', { name: '建立连接', exact: true });
async function count(expected) {
  await page.waitForFunction(value => document.querySelector('[data-result-count]')?.getAttribute('data-result-count') === String(value), expected);
  const current = await currentTitle().count() ? currentSection().locator('[data-entry]') : cards();
  assert.equal(await current.count(), expected, 'current section entries match its displayed count');
}
async function activeSection(id) {
  await page.waitForFunction(value => document.querySelector('.catalog-section-title[data-current="true"]')?.closest('[data-section]')?.getAttribute('data-section') === value, id);
  assert.equal(await currentTitle().count(), 1, 'only one section is current');
}
async function wheelToSection(id, inset = 0) {
  const distance = await section(id).evaluate((element, offset) => element.getBoundingClientRect().top - document.querySelector('#connection-gallery').getBoundingClientRect().top + offset, inset);
  await page.locator('#connection-gallery').hover();
  await page.mouse.wheel(0, distance);
  await activeSection(id);
}
async function isFocused(locator) {
  return locator.evaluate(element => element === document.activeElement);
}
async function chooseMedia(name) {
  await page.getByRole('button', { name: '筛选素材类型', exact: true }).click();
  await page.getByRole('menuitemradio', { name, exact: true }).click();
}
async function addTo(sourceId, destinationName) {
  await entry(sourceId).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '添加到集合', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加到集合', exact: true });
  await dialog.getByRole('radio', { name: destinationName, exact: true }).click();
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
}
async function deleteReference(id) {
  await entry(id).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除分身', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '删除分身', exact: true });
  await dialog.getByRole('button', { name: '删除分身', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
}
async function assertNoHorizontalOverflow(context) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const geometry = await page.evaluate(() => {
    const width = innerWidth;
    const elements = [...document.querySelectorAll('.connection-topbar, .connection-gallery-toolbar, .connection-count-row, .connection-study-bar, .connection-modal, .catalog-section-title[data-current="true"]')];
    return {
      root: { width, scroll: document.documentElement.scrollWidth },
      violations: elements.filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.left < -1 || rect.right > width + 1 || element.scrollWidth > element.clientWidth + 1;
      }).map(element => ({ className: element.className, width: element.clientWidth, scroll: element.scrollWidth, rect: element.getBoundingClientRect().toJSON() })),
    };
  });
  assert.ok(geometry.root.scroll <= geometry.root.width + 1, `${context}: document width ${geometry.root.scroll}px exceeds viewport ${geometry.root.width}px`);
  assert.deepEqual(geometry.violations, [], `${context}: toolbars/dialogs must fit without hidden horizontal overflow`);
}
async function scenario(name, action) {
  try {
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.goto(url);
    await count(5);
    assert.equal(await page.evaluate(() => '__TAURI_INTERNALS__' in window), false, 'fixture has no native bridge');
    await action();
    results.push({ name, passed: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, passed: false, error: error.stack ?? String(error) });
    await page.screenshot({ path: `${output}/failure-${name}.png`, fullPage: true, animations: 'disabled' }).catch(() => {});
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

try {
  await scenario('continuous-folder-order', async () => {
    const order = ['brand', 'products', 'details', 'videos', 'inspiration', 'projects', 'proposal', 'drive', 'archive'];
    const sectionOrder = () => page.locator('section[data-section]').evaluateAll(elements => elements.map(element => element.dataset.section));
    assert.deepEqual(await sectionOrder(), order, 'complete depth-first order includes collapsed descendants and every root');
    assert.equal(await page.getByRole('button', { name: '全部展开', exact: true }).count(), 0);
    assert.equal(await cards().count(), 23, 'each physical entry appears once in the continuous collection stream');
    assert.deepEqual(await section('brand').locator('[data-entry]').evaluateAll(elements => elements.map(element => element.dataset.entry)), ['entry-brand-01', 'entry-brand-02', 'entry-brand-03', 'entry-brand-04', 'entry-brand-05']);
    assert.equal(await section('products').locator('[data-entry]').count(), 5, 'parent section does not repeat descendant media');
    assert.equal(await section('details').locator('[data-entry]').count(), 2);
    await page.getByRole('button', { name: '折叠品牌素材', exact: true }).click();
    assert.deepEqual(await sectionOrder(), order, 'tree collapse cannot hide or reorder gallery sections');
    await wheelToSection('products', 40); await count(5);
    assert.match(await currentTitle().innerText(), /产品/);
    const sticky = await currentTitle().evaluate(element => ({ top: element.getBoundingClientRect().top, galleryTop: document.querySelector('#connection-gallery').getBoundingClientRect().top }));
    assert.ok(sticky.top >= sticky.galleryTop && sticky.top <= sticky.galleryTop + 30, 'current collection block floats at the upper left of the gallery');
    await page.getByRole('button', { name: '展开品牌素材', exact: true }).click();
    await page.getByRole('button', { name: '展开产品', exact: true }).click();
    await wheelToSection('products', 120); await count(5);
    await page.waitForFunction(() => [...document.querySelectorAll('[data-section="products"] img')].every(image => image.complete && image.naturalWidth > 0));
    await page.screenshot({ path: `${output}/continuous-pinned-dark.png`, fullPage: true, animations: 'disabled' });
    await wheelToSection('details', 20); await count(2);
    assert.equal(await folder('details').getAttribute('aria-selected'), 'true', 'scroll follows the corresponding tree row');
    await wheelToSection('projects', 10); await count(0);
    assert.equal(await folder('projects').getAttribute('aria-selected'), 'true', 'scroll continues into the next connected root');
    await wheelToSection('proposal', 20); await count(3);
    await folder('brand').click(); await activeSection('brand'); await count(5);
    const scrollTop = await page.locator('#connection-gallery').evaluate(element => element.scrollTop);
    assert.ok(scrollTop <= 1, 'clicking the tree locates the selected section');
  });

  await scenario('inline-create-collection', async () => {
    assert.doesNotMatch(await page.locator('body').innerText(), /父集合|子集合/);
    const add = folder('products').getByRole('button', { name: '在产品中新建集合', exact: true });
    assert.equal(await add.isVisible(), true, 'the plus action is directly available on the collection row');
    const row = await folder('products').boundingBox(), plus = await add.boundingBox();
    assert.ok(plus.x > row.x + row.width / 2, 'new collection plus is on the right side of its row');
    await add.click();
    const dialog = page.getByRole('dialog', { name: '新建集合', exact: true });
    assert.doesNotMatch(await dialog.innerText(), /父集合|子集合/);
    await dialog.getByLabel('名称', { exact: true }).fill('配色研究');
    await dialog.getByRole('button', { name: '创建', exact: true }).click();
    const created = page.getByRole('treeitem', { name: '配色研究', exact: true });
    await created.waitFor();
    const id = await created.getAttribute('data-folder');
    await activeSection(id); await count(0);
    assert.equal(await created.getAttribute('aria-level'), '3');
    assert.equal(await folder('products').locator('..').locator(`[data-folder="${id}"]`).count(), 1);
    assert.match(await created.getAttribute('title'), /产品[\\/]配色研究$/);
    await folder('products').click({ button: 'right' });
    assert.equal(await page.getByRole('menuitem', { name: /新建/ }).count(), 0, 'creation is removed from the more menu');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '新建集合', exact: true }).click();
    await page.getByRole('dialog', { name: '新建集合', exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog').getByLabel('保存位置').count(), 1, 'top-level creation keeps its location field without engineering labels');
    assert.doesNotMatch(await page.locator('body').innerText(), /父集合|子集合/);
    await page.keyboard.press('Escape');
  });

  await scenario('media-filter', async () => {
    await chooseMedia('图片'); await count(4);
    assert.equal(await page.locator('.connection-video').count(), 0);
    await chooseMedia('视频'); await count(1);
    assert.equal(await entry('entry-brand-05').count(), 1);
    await folder('videos').click(); await activeSection('videos'); await count(2);
    await chooseMedia('图片'); await count(0);
    assert.equal(await section('details').locator('[data-entry]').count(), 2, 'filtering keeps the rest of the stream available');
    await chooseMedia('图片与视频'); await count(2);
    await folder('brand').click(); await count(5);
  });

  await scenario('reference-add-remove', async () => {
    await addTo('entry-brand-02', '春季提案');
    await folder('proposal').click(); await count(4);
    const added = section('proposal').locator('[data-asset="brand-02"][data-reference="true"]');
    assert.equal(await added.count(), 1);
    const referenceId = await added.getAttribute('data-entry');
    assert.notEqual(referenceId, 'entry-brand-02', 'reference has its own entry identity');
    await added.click();
    const detail = page.getByRole('dialog');
    assert.match(await detail.innerText(), /原文件位置/);
    assert.match(await detail.innerText(), /品牌素材/);
    await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: '全部', exact: true }).click(); await count(20);
    assert.equal(await page.locator('[data-asset="brand-02"]').count(), 1, 'global view deduplicates original and references');
    await page.getByRole('tab', { name: '集合分类', exact: true }).click(); await activeSection('proposal'); await count(4);
    await deleteReference(referenceId); await count(3);
    await folder('brand').click(); await count(5);
    assert.equal(await entry('entry-brand-02').count(), 1, 'deleting the reference leaves the original');
    assert.equal(await entry('entry-brand-02').getAttribute('data-reference'), null);
  });

  await scenario('entry-selection-identity', async () => {
    await addTo('entry-brand-02', '产品');
    assert.equal(await cards().count(), 24);
    const original = entry('entry-brand-02');
    const reference = page.locator('[data-asset="brand-02"][data-reference="true"]');
    const referenceId = await reference.getAttribute('data-entry');
    await original.click({ modifiers: ['Control'] });
    assert.equal(await original.getAttribute('aria-pressed'), 'true');
    assert.equal(await reference.getAttribute('aria-pressed'), 'false', 'same asset does not imply shared entry selection');
    await reference.click({ button: 'right' });
    assert.equal(await original.getAttribute('aria-pressed'), 'true', 'context menu preserves existing visual selection');
    await page.getByRole('menuitem', { name: '删除分身', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: '删除分身', exact: true });
    assert.match(await confirmation.innerText(), /删除 1 个分身/);
    await confirmation.getByRole('button', { name: '删除分身', exact: true }).click();
    await count(5);
    assert.equal(await cards().count(), 23);
    assert.equal(await entry(referenceId).count(), 0);
    assert.equal(await original.count(), 1);
  });

  await scenario('connect-travel', async () => {
    await topConnect().click();
    const dialog = page.getByRole('dialog', { name: '建立连接', exact: true });
    await dialog.getByRole('radio', { name: '旅行采风', exact: true }).click();
    await dialog.getByRole('button', { name: '建立连接', exact: true }).click();
    await count(2);
    assert.equal(await folder('travel').getAttribute('aria-selected'), 'true');
    assert.equal(await section('travel').locator('[data-entry]').count(), 2);
    assert.equal(await section('travel-nature').locator('[data-entry]').count(), 2);
    await wheelToSection('travel-nature', 20); await count(2);
    await page.getByRole('button', { name: '刷新文件夹', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-label="刷新文件夹"]')?.disabled);
    await page.getByRole('button', { name: '刷新文件夹', exact: true }).click();
    await count(2);
    assert.equal(await cards().count(), 27, 'background refresh keeps the complete gallery stream');
  });

  await scenario('folder-move-delete', async () => {
    await page.getByRole('button', { name: '展开产品', exact: true }).click();
    await folder('products').click();
    await activeSection('products'); await count(5);
    const subtreeCards = () => page.locator('[data-section="products"] [data-entry], [data-section="details"] [data-entry]');
    const identities = await subtreeCards().evaluateAll(elements => elements.map(element => [element.dataset.entry, element.dataset.asset]).sort());
    assert.deepEqual(identities.map(([, asset]) => asset).sort(), ['detail-01', 'detail-02', 'product-01', 'product-02', 'product-03', 'product-04', 'product-05']);
    await folder('products').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '移动文件夹', exact: true }).click();
    const move = page.getByRole('dialog', { name: '移动文件夹', exact: true });
    assert.equal(await move.getByRole('radio', { name: '产品', exact: true }).count(), 0, 'folder cannot move into itself');
    assert.equal(await move.getByRole('radio', { name: '细节', exact: true }).count(), 0, 'folder cannot move into its descendants');
    await move.getByRole('radio', { name: '项目参考', exact: true }).click();
    await move.getByRole('button', { name: '移动', exact: true }).click();
    await move.waitFor({ state: 'detached' }); await activeSection('products'); await count(5);
    assert.equal(await folder('brand').locator('..').locator('[data-folder="products"]').count(), 0);
    assert.equal(await folder('projects').locator('..').locator('[data-folder="products"]').count(), 1);
    assert.equal(await folder('products').locator('..').locator('[data-folder="details"]').count(), 1);
    assert.equal(await folder('products').getAttribute('aria-level'), '2');
    assert.equal(await folder('details').getAttribute('aria-level'), '3');
    assert.match(await folder('products').getAttribute('title'), /项目参考[\\/]产品$/);
    assert.match(await folder('details').getAttribute('title'), /项目参考[\\/]产品[\\/]细节$/);
    assert.deepEqual(await subtreeCards().evaluateAll(elements => elements.map(element => [element.dataset.entry, element.dataset.asset]).sort()), identities, 'moving a subtree preserves every original entry and asset identity');
    assert.deepEqual(await page.locator('section[data-section]').evaluateAll(elements => elements.map(element => element.dataset.section)), ['brand', 'videos', 'inspiration', 'projects', 'products', 'details', 'proposal', 'drive', 'archive'], 'moving the subtree also updates continuous browsing order');
    await folder('proposal').click(); await count(3);
    assert.doesNotMatch(await entry('reference-product-01').getAttribute('class'), /is-missing/);
    await entry('reference-product-01').click();
    assert.match(await page.getByRole('dialog').innerText(), /项目参考[\\/]产品/);
    await page.keyboard.press('Escape');
    await folder('products').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '文件夹移到回收站', exact: true }).click();
    const remove = page.getByRole('dialog', { name: '文件夹移到回收站', exact: true });
    await remove.getByRole('button', { name: '移到回收站', exact: true }).click();
    await remove.waitFor({ state: 'detached' }); await count(3);
    assert.equal(await folder('products').count(), 0);
    assert.equal(await folder('details').count(), 0);
    assert.equal(await entry('reference-product-01').getAttribute('data-asset'), 'product-01');
    assert.match(await entry('reference-product-01').getAttribute('class'), /is-missing/, 'deleting the original folder marks its surviving reference unavailable');
    assert.doesNotMatch(await entry('reference-brand-01').getAttribute('class'), /is-missing/, 'references to unrelated originals stay available');
    assert.equal(await section('proposal').locator('.connection-media-card.is-missing').count(), 1);
    await folder('brand').click(); await count(5);
    assert.equal(await entry('entry-brand-01').count(), 1);
    assert.doesNotMatch(await entry('entry-brand-01').getAttribute('class'), /is-missing/);
  });

  await scenario('offline-reconnect', async () => {
    await folder('archive').click(); await count(2);
    assert.equal(await page.locator('.connection-media-card.is-missing').count(), 2);
    await page.getByRole('button', { name: 'macOS', exact: true }).click();
    await section('archive').getByRole('button', { name: '重新定位', exact: true }).click();
    await page.getByRole('dialog', { name: '重新定位文件夹', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await activeSection('archive'); await count(2);
    assert.equal(await folder('archive').getAttribute('aria-selected'), 'true', 'canceling relocation preserves the collection being viewed');
    await section('archive').getByRole('button', { name: '重新定位', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '重新定位文件夹', exact: true });
    await dialog.getByLabel('新位置').fill('/Volumes/工作资料/移动硬盘');
    await dialog.getByRole('button', { name: '连接此位置', exact: true }).click();
    await activeSection('archive'); await count(2);
    assert.equal(await page.locator('.connection-media-card.is-missing').count(), 0);
    assert.equal(await page.locator('.connection-unavailable').count(), 0);
    assert.match(await folder('archive').getAttribute('title'), /\/Volumes\/工作资料\/移动硬盘\/往期影像/);
    assert.deepEqual(await section('archive').locator('[data-entry]').evaluateAll(elements => elements.map(element => element.dataset.asset)), ['archive-01', 'archive-02'], 'reconnection retains asset identity');
  });

  await scenario('keyboard-tree-menu', async () => {
    await folder('brand').focus(); await page.keyboard.press('ArrowDown');
    assert.equal(await isFocused(folder('products')), true);
    await count(5);
    await page.keyboard.press('ArrowRight');
    await folder('details').waitFor();
    await page.keyboard.press('ArrowRight');
    assert.equal(await isFocused(folder('details')), true);
    await page.keyboard.press('Enter'); await count(2);
    await page.keyboard.press('Shift+F10');
    const items = page.getByRole('menuitem');
    assert.equal(await isFocused(items.first()), true);
    await page.keyboard.press('ArrowDown');
    assert.equal(await isFocused(items.nth(1)), true);
    await page.keyboard.press('Escape');
    await page.getByRole('menu').waitFor({ state: 'detached' });
    assert.equal(await isFocused(folder('details')), true, 'closing the keyboard menu restores its trigger');
  });

  await scenario('keyboard-dialog', async () => {
    await topConnect().click();
    const dialog = page.getByRole('dialog', { name: '建立连接', exact: true });
    const first = dialog.getByRole('button', { name: '关闭弹窗', exact: true });
    const last = dialog.getByRole('button', { name: '建立连接', exact: true });
    assert.equal(await isFocused(first), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await isFocused(last), true, 'backward tab stays inside the modal');
    await page.keyboard.press('Tab');
    assert.equal(await isFocused(first), true, 'forward tab wraps inside the modal');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await isFocused(topConnect()), true, 'modal restores the launch button');
  });

  await scenario('responsive-themes', async () => {
    for (const width of [1500, 900, 390]) {
      for (const theme of ['dark', 'light']) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.goto(`${url}?theme=${theme}`); await count(5);
        await assertNoHorizontalOverflow(`${theme} ${width}px`);
        assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
        await page.waitForFunction(() => { const image = document.querySelector('[data-entry] img'); return image?.complete && image.naturalWidth > 0; });
        await page.screenshot({ path: `${output}/${theme}-${width}.png`, fullPage: true, animations: 'disabled' });
        if (width === 390) {
          await page.getByRole('button', { name: '展开目录侧栏', exact: true }).click();
          await folder('products').click(); await count(5);
          assert.equal(await page.locator('.connection-sidebar.is-open').count(), 0);
          await assertNoHorizontalOverflow(`${theme} mobile folder navigation`);
        }
        await topConnect().click();
        await assertNoHorizontalOverflow(`${theme} ${width}px connect dialog`);
        await page.screenshot({ path: `${output}/${theme}-${width}-connect.png`, fullPage: true, animations: 'disabled' });
        await page.keyboard.press('Escape');
      }
    }
  });
  assert.deepEqual(runtimeErrors, [], 'fixture must not produce uncaught browser errors');
  assert.deepEqual(localFailures, [], 'all local fixture resources must load');
  await writeFile(`${output}/ui-results.json`, JSON.stringify({ results, runtimeErrors, localFailures, blockedRequests }, null, 2));
  assert.equal(results.filter(result => !result.passed).length, 0, 'one or more UI scenarios failed; see ui-results.json');
  console.log(`${results.length} library connection UI scenarios passed; screenshots: ${output}`);
} finally {
  await writeFile(`${output}/ui-results.json`, JSON.stringify({ results, runtimeErrors, localFailures, blockedRequests }, null, 2));
  await browser.close();
  await server.close();
}
