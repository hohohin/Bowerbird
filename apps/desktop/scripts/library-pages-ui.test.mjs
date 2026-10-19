import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1591, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
const root = 'http://127.0.0.1:1591/scripts/fixtures/';
const panel = page.getByRole('complementary', { name: '画板素材库' });
const fullPalette = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink', 'brown', 'gray', 'white', 'black']
  .map((key, i) => ({ key, hex: ['#db635b', '#e79c51', '#e8cf69', '#70bf7d', '#70bacb', '#608cd8', '#937acb', '#d588b5', '#97725d', '#999999', '#ffffff', '#333333'][i], count: 4 }));
async function checkColorStrip(scope, allVisible = true) {
  await scope.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const geometry = await scope.locator('.library-browser-heading').evaluate(el => {
    const nav = el.querySelector('.library-view-switch').getBoundingClientRect();
    const control = el.querySelector('.library-color-control');
    const bounds = control.getBoundingClientRect();
    const rgb = control.querySelector('[data-filter="colors"]').getBoundingClientRect();
    const strip = control.querySelector('.library-color-strip');
    const row = [...control.querySelectorAll('.library-filter-colors button')].map(button => button.getBoundingClientRect());
    const back = el.closest('.canvas-source-panel')?.querySelector('.library-return-canvas')?.getBoundingClientRect();
    const header = el.getBoundingClientRect();
    return { heights: [header.height, nav.height, bounds.height], joined: Math.abs(rgb.right - strip.getBoundingClientRect().left) < 1,
      oneRow: row.every(rect => Math.abs(rect.top - row[0].top) < 1), count: row.length,
      radius: getComputedStyle(control).borderRadius, full: strip.scrollWidth <= strip.clientWidth + 1,
      within: nav.left >= header.left - 1 && bounds.right <= header.right + 1,
      backClear: !back || back.bottom <= header.top || back.top >= header.bottom || bounds.right + 7 <= back.left || nav.left >= back.right + 7 };
  });
  assert.ok(geometry.heights.every(height => Math.abs(height - 28) < .1), 'all floating controls are 28px high');
  assert.equal(geometry.joined, true, 'color strip starts flush with RGB button');
  assert.equal(geometry.oneRow, true, 'all colors share a single row');
  assert.equal(geometry.count, 12);
  assert.equal(geometry.radius, '999px');
  assert.equal(geometry.within, true, 'expanded controls stay inside the library');
  assert.equal(geometry.backClear, true, 'expanded strip avoids the canvas return button');
  if (allVisible) assert.equal(geometry.full, true, 'all colors and actions fit without scrolling');
}
async function openHistory(scope) {
  await scope.getByRole('tab', { name: '全局素材', exact: true }).click();
  await scope.getByRole('button', { name: '更多文件操作', exact: true }).click();
  await scope.getByRole('button', { name: '历史素材', exact: true }).click();
}
async function settle() {
  await page.locator('.canvas-source-panel').evaluate(async el => {
    await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
  });
}
async function libraryOpen(open) {
  await page.waitForFunction(open => window.store.getState().canvasLibraryOpen === open, open);
  await settle();
}
async function revealTags(scope) {
  const edge = await scope.locator('.library-tag-bar').boundingBox();
  await page.mouse.move(edge.x + edge.width - 19, edge.y + 10);
  await scope.locator('.library-tag-content').waitFor({ state: 'visible' });
  await scope.locator('.library-tag-content').evaluate(async el => {
    await Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {})));
  });
}
async function hoverTag(scope, name) {
  const row = await scope.getByRole('navigation', { name: '分类标签' }).getByRole('button', { name, exact: true }).boundingBox();
  const edge = await scope.locator('.library-tag-bar').boundingBox();
  await page.mouse.move(edge.x + edge.width - 10, row.y + row.height / 2);
}
try {
  await mkdir('.tmp/library-pages', { recursive: true });
  await page.addInitScript(() => window.testTags = ['插画', '建筑', '摄影', '平面设计', '人物', '风景', '产品'].map((name, i) => ({ id: `tag-${i}`, name })));
  await page.goto(root + 'project-drop/preview.html?layout');
  const home = page.locator('.library-home');
  await openHistory(home);
  await home.locator('[data-asset-id="owned"]').waitFor();
  assert.equal(await home.locator('.library-project-folder').count(), 0, 'global library contains project assets without project cards');
  assert.equal(await home.locator('[data-asset-id]').count(), 4);
  assert.equal(await page.locator('.app-sidebar .library-navigation').count(), 0);
  assert.equal(await home.getByRole('group', { name: '素材类型筛选' }).count(), 0);
  assert.equal(await home.getByRole('button', { name: '全部', exact: true }).count(), 0);
  const floating = await home.locator('.library-browser-heading').evaluate(el => {
    const grid = el.parentElement, header = el.getBoundingClientRect();
    const rect = grid.getBoundingClientRect();
    const card = grid.querySelector('[data-asset-id]').getBoundingClientRect();
    return { absolute: getComputedStyle(el).position === 'absolute', cardInset: card.top - rect.top,
      inGrid: header.top >= rect.top && header.bottom <= rect.bottom };
  });
  assert.equal(floating.absolute, true);
  assert.ok(floating.cardInset < 16, 'floating switch reserves no header row');
  assert.equal(floating.inGrid, true);
  assert.equal(await home.getByRole('button', { name: '素材筛选', exact: true }).count(), 0);
  const tagMenu = home.getByRole('navigation', { name: '分类标签' });
  const tagButtons = tagMenu.locator('button');
  assert.equal(await home.locator('.library-tag-content').isVisible(), false, 'tags start collapsed');
  await revealTags(home);
  await tagButtons.nth(6).waitFor();
  const longTag = tagMenu.getByRole('button', { name: '平面设计', exact: true });
  assert.equal(await longTag.textContent(), '平面设计', 'full text stays mounted while its suffix is hidden beyond the right edge');
  const tuckedOffset = await longTag.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).e);
  assert.ok(tuckedOffset > 18 && tuckedOffset < 21, 'all but the first two characters slide beyond the edge');
  assert.equal(await home.locator('.library-tag-reveal').evaluate(el => getComputedStyle(el, '::after').content), 'none', 'edge trigger has no visible handle');
  await page.evaluate(() => window.store.getState().enterManage());
  const rightmost = await home.locator('[data-asset-id]').evaluateAll(items => {
    const el = items.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
    const rect = el.getBoundingClientRect();
    return { id: el.dataset.assetId, x: rect.right - 8, y: rect.top + rect.height / 2, right: rect.right };
  });
  const tagEdge = await home.locator('.library-tag-bar').boundingBox();
  const assetArea = await home.locator('.library-scroll-area').boundingBox();
  assert.ok(Math.abs(assetArea.x + assetArea.width - tagEdge.x - tagEdge.width) < 2, 'assets fill the library without a reserved tag gutter');
  await page.mouse.click(rightmost.x, rightmost.y);
  assert.equal(await page.evaluate(id => window.store.getState().selectedIds.has(id), rightmost.id), true, 'rightmost card remains clickable after revealing tags');
  await home.locator('.library-tag-content').waitFor({ state: 'hidden' });
  await page.evaluate(() => window.store.getState().exitManage());
  await revealTags(home);
  assert.equal(await tagButtons.first().locator('span').evaluate(el => getComputedStyle(el).fontSize), '9.7px');
  const positions = await tagButtons.evaluateAll(items => items.map(el => el.getBoundingClientRect().top));
  const gridBeforeHover = await home.locator('[data-asset-id="owned"]').boundingBox();
  await tagButtons.nth(3).hover();
  assert.deepEqual(await tagButtons.evaluateAll(items => items.map(el => el.dataset.distance)), ['3', '2', '1', '0', '1', '2', '3']);
  assert.equal(await tagMenu.getByRole('button', { name: '平面设计', exact: true }).textContent(), '平面设计', 'hover-affected neighbors show their full names');
  const extensionFrames = await longTag.evaluate(el => {
    const animation = el.getAnimations().find(a => a.transitionProperty === 'transform');
    if (!animation) return [];
    animation.pause();
    const frames = [0, 75, 150, 300].map(time => {
      animation.currentTime = time;
      return new DOMMatrix(getComputedStyle(el).transform).e;
    });
    animation.play();
    return frames;
  });
  assert.equal(extensionFrames.length, 4, 'reveal uses a real transform transition');
  assert.ok(extensionFrames[0] > extensionFrames[1] && extensionFrames[1] > extensionFrames[2] && extensionFrames[2] > extensionFrames[3], 'the same text travels left through intermediate positions');
  assert.ok(extensionFrames[0] - extensionFrames[1] > extensionFrames[1] - extensionFrames[2], 'entry decelerates toward its resting position');
  await tagMenu.evaluate(async el => await Promise.all(el.getAnimations({subtree:true}).map(a => a.finished)));
  const scales = await tagButtons.evaluateAll(items => items.map(el => new DOMMatrix(getComputedStyle(el.firstElementChild).transform).a));
  scales.forEach((scale, i) => assert.ok(Math.abs(scale - [1, 1.12, 1.3, 1.6, 1.3, 1.12, 1][i]) < .002));
  assert.deepEqual(await tagButtons.evaluateAll(items => items.map(el => el.getBoundingClientRect().top)), positions, 'hover never moves hit targets');
  assert.deepEqual(await home.locator('[data-asset-id="owned"]').boundingBox(), gridBeforeHover, 'hover never reflows the waterfall');
  const centerRow = await tagButtons.nth(3).boundingBox();
  await page.mouse.move(centerRow.x + centerRow.width / 2, centerRow.y + centerRow.height * .75);
  const fractionalScale = await tagButtons.nth(3).evaluate(el => Number(el.style.getPropertyValue('--tag-scale')));
  assert.ok(fractionalScale > 1.3 && fractionalScale < 1.6, 'influence follows pointer distance continuously inside a row');
  await hoverTag(home, '插画');
  await tagMenu.evaluate(async el => await Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished.catch(() => {}))));
  await hoverTag(home, '建筑');
  const beforeReverse = await longTag.evaluate(el => {
    const animation = el.getAnimations().find(a => a.transitionProperty === 'transform');
    animation.pause(); animation.currentTime = 75;
    return new DOMMatrix(getComputedStyle(el).transform).e;
  });
  await hoverTag(home, '插画');
  const afterReverse = await longTag.evaluate(el => {
    const animation = el.getAnimations().find(a => a.transitionProperty === 'transform');
    animation.pause(); animation.currentTime = 0;
    const offset = new DOMMatrix(getComputedStyle(el).transform).e;
    animation.play(); return offset;
  });
  assert.ok(Math.abs(afterReverse - beforeReverse) < .5, 'reversing mid-flight starts from the current position');
  await page.locator('.app-search input').hover();
  assert.deepEqual(await home.locator('.library-tag-menu button').evaluateAll(items => items.map(el => el.dataset.distance)), Array(7).fill('3'));
  await home.locator('.library-tag-content').waitFor({ state: 'hidden' });
  assert.ok(await home.locator('.library-tag-menu button[aria-label="平面设计"]').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).e > 18), 'text retreats behind the edge after hover leaves');
  await page.locator('.app-search input').focus();
  await page.keyboard.press('Tab');
  await home.getByRole('button', { name: '显示标签列表' }).focus();
  await tagMenu.waitFor({ state: 'visible' });
  await tagButtons.nth(0).focus(); await page.keyboard.press('ArrowDown');
  assert.equal(await tagButtons.nth(1).evaluate(el => el === document.activeElement), true);
  assert.equal(await tagButtons.nth(1).getAttribute('data-distance'), '0');
  await page.keyboard.press('End');
  assert.equal(await tagButtons.nth(6).evaluate(el => el === document.activeElement), true);
  await tagMenu.getByRole('button', { name: '插画', exact: true }).click();
  assert.equal(await page.evaluate(() => window.store.getState().smartFilter), 'tag:插画');
  await home.getByRole('button', { name: '清除标签筛选', exact: true }).click();
  assert.equal(await page.evaluate(() => window.store.getState().smartFilter), null);
  const geometry = await home.locator('.library-floating-navigation').evaluate(el => {
    const tab = el.querySelector('.library-view-switch').getBoundingClientRect();
    const trigger = el.querySelector('.library-color-control').getBoundingClientRect();
    return { gap: trigger.left - tab.right, round: trigger.width === trigger.height,
      background: getComputedStyle(el.querySelector('.library-view-switch')).backgroundColor };
  });
  assert.equal(geometry.gap, 8); assert.equal(geometry.round, true); assert.match(geometry.background, /0\.76/);
  assert.equal(await page.locator('.app-sidebar').getByText('分类标签', { exact: true }).count(), 0);
  assert.equal(await page.locator('.app-sidebar').getByText('颜色', { exact: true }).count(), 0);
  await page.evaluate(value => window.testPalette = value, fullPalette);
  const rgb = home.getByRole('button', { name: '颜色筛选', exact: true });
  await rgb.click();
  const palette = home.getByRole('dialog', { name: '颜色筛选', exact: true });
  await palette.getByRole('button', { name: '红', exact: true }).click();
  await checkColorStrip(home);
  assert.equal(await page.evaluate(() => window.store.getState().colorFilter), 'red');
  await palette.getByRole('button', { name: '红', exact: true }).click();
  assert.equal(await page.evaluate(() => window.store.getState().colorFilter), null);
  await palette.getByRole('button', { name: '重建色板', exact: true }).click();
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === 'recompute_colors').length), 1);
  await page.keyboard.press('Escape');
  assert.equal(await rgb.evaluate(el => el === document.activeElement), true);
  await rgb.click();
  await page.locator('.app-search input').click();
  assert.equal(await palette.count(), 0, 'outside click closes colors');
  await revealTags(home);
  await home.getByRole('button', { name: '管理标签', exact: true }).click();
  await page.getByRole('dialog', { name: '自动分类', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: '自动分类', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await home.getByRole('button', { name: '管理标签', exact: true }).evaluate(el => el === document.activeElement), true);
  await page.evaluate(() => window.failPalette = true);
  await rgb.click();
  await palette.getByRole('button', { name: '加载失败 · 重试', exact: true }).waitFor();
  await page.evaluate(() => { window.failPalette = false; window.testPalette = []; });
  await palette.getByRole('button', { name: '加载失败 · 重试', exact: true }).click();
  await palette.getByText('暂无色板，可尝试重建', { exact: true }).waitFor();
  await page.keyboard.press('Escape');




  assert.equal(await page.locator('.app-sidebar').getByText('目标项目', { exact: true }).count(), 0);
  await home.getByRole('tab', { name: '项目管理', exact: true }).click();
  assert.equal(await home.locator('[data-asset-id]').count(), 0, 'project page never expands inline assets');
  assert.equal(await home.locator('.library-project-folder').count(), 2, 'empty project is present');
  await home.getByRole('button', { name: '打开项目 空项目' }).waitFor();
  assert.equal(await home.locator('[data-tour="new-project"]').count(), 0);
  assert.equal(await home.getByRole('button', { name: '素材筛选', exact: true }).count(), 0);
  await page.getByRole('textbox', { name: '搜索项目', exact: true }).fill('空项目');
  assert.equal(await home.locator('.library-project-folder').count(), 1);
  await openHistory(home);
  assert.equal(await home.getByRole('tab', { name: '全局素材', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await home.locator('[data-asset-id]').count(), 4);
  await home.getByRole('tab', { name: '项目管理', exact: true }).click();
  assert.equal(await home.locator('.library-project-folder').count(), 2);
  // Project cards use the same size mapping, control and gestures as assets.
  const projectSize = home.getByRole('slider', { name: '主页素材大小', exact: true });
  const projectValue = home.getByRole('spinbutton', { name: '主页素材大小数值', exact: true });
  const initialWidth = await page.evaluate(() => window.store.getState().libraryThumbnailWidth);
  await projectValue.fill('100'); await projectValue.press('Enter');
  await page.waitForTimeout(650);
  const largest = await home.locator('.library-project-folder').first().boundingBox();
  assert.equal(await page.evaluate(() => window.store.getState().libraryThumbnailWidth), 320);
  await projectValue.fill('0'); await projectValue.press('Enter');
  await page.waitForTimeout(650);
  const smallest = await home.locator('.library-project-folder').first().boundingBox();
  assert.ok(smallest.width < largest.width / 2, 'project cards resize with the 0–100 control');
  assert.equal(await projectSize.inputValue(), '0');
  await projectValue.fill('73'); await projectValue.press('Escape');
  assert.equal(await projectValue.inputValue(), '0', 'Escape cancels numeric editing');
  await projectSize.focus(); await projectSize.press('ArrowRight');
  assert.equal(await projectSize.inputValue(), '1');
  await projectSize.fill('50');
  assert.equal(await page.evaluate(() => window.store.getState().libraryThumbnailWidth), 208);
  const wheel = await home.locator('.library-project-grid').evaluate(el => {
    const normal = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 4 });
    el.dispatchEvent(normal);
    const pinch = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -10, ctrlKey: true });
    el.dispatchEvent(pinch);
    return { normal: normal.defaultPrevented, pinch: pinch.defaultPrevented };
  });
  assert.deepEqual(wheel, { normal: false, pinch: true });
  assert.ok(await page.evaluate(() => window.store.getState().libraryThumbnailWidth) > 208);
  await home.locator('.library-project-grid').evaluate(el => {
    for (const [type, scale] of [['gesturestart', 1], ['gesturechange', 1.2], ['gestureend', 1.2]]) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'scale', { value: scale }); el.dispatchEvent(event);
    }
  });
  const projectZoom = await projectValue.inputValue();
  await openHistory(home);
  assert.equal(await home.getByRole('slider', { name: '主页素材大小', exact: true }).inputValue(), projectZoom, 'home views share size preference');
  await page.evaluate(width => window.store.getState().setThumbnailWidth('library', width), initialWidth);
  await home.getByRole('tab', { name: '项目管理', exact: true }).click();
  await page.waitForTimeout(650);
  await page.screenshot({ path: '.tmp/library-pages/projects.png' });
  await openHistory(home);
  await page.evaluate(() => {
    const store = window.store.getState(), template = store.assets[0];
    store.setAssets([...store.assets, ...Array.from({ length: 100 }, (_, i) => ({ ...template, id: `scroll-${i}` }))]);
  });
  const bar = home.locator('.library-tag-bar');
  const before = await bar.boundingBox();
  await home.locator('.library-scroller').evaluate(el => el.scrollTop = 800);
  assert.deepEqual(await bar.boundingBox(), before, 'right tag index stays fixed while assets scroll');
  await page.screenshot({ path: '.tmp/library-pages/global.png' });

  await page.addInitScript(() => {
    const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="190" height="150"><rect width="190" height="150" fill="#93a9b4"/></svg>');
    sessionStorage.setItem('reference-drafts', JSON.stringify(Array.from({ length: 90 }, (_, i) => ({
      id: `global-${i}`, name: `全局素材 ${i}`, width: 190, height: 150, store_path: image, thumb_path: image,
    }))));
  });
  await page.goto(root + 'canvas-reference/preview.html?source-library');
  await page.waitForFunction(() => document.querySelector('.canvas-workspace')?.getAttribute('aria-busy') === 'false');
  assert.equal(await page.evaluate(() => window.store.getState().canvasLibraryOpen), false, 'project opens on canvas');
  await page.evaluate(() => {
    const state = window.store.getState();
    state.setAssets(state.assets.filter(asset => ['existing', 'a'].includes(asset.id)));
    state.setTotal(2);
  });
  const stageBefore = await page.locator('.canvas-stage').boundingBox();
  await page.locator('.canvas-stage').focus();
  await page.keyboard.press('Tab');
  await libraryOpen(true);
  assert.equal(await panel.locator('[data-asset-id]').count(), 2);
  assert.equal(await page.getByRole('button', {name:'打开本机文件资源管理器',exact:true}).count(), 0);
  const tabs = () => panel.getByRole('tablist', {name:'画板素材来源'});
  const tabNames = () => tabs().getByRole('tab').allTextContents();
  assert.deepEqual(await tabNames(), ['项目素材', '全局素材']);
  await page.keyboard.press('Tab');
  await panel.getByRole('region',{name:'本机文件',exact:true}).waitFor();
  await panel.getByRole('button',{name:'原图.png',exact:true}).waitFor();
  assert.equal(await tabs().getByRole('tab',{name:'全局素材'}).getAttribute('aria-selected'), 'true');
  await panel.locator('.local-file-workspace').evaluate(async el => {
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    await Promise.all(el.getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{})));
  });
  await page.screenshot({path:'.tmp/library-pages/local-files-tab.png'});
  assert.equal(await page.locator('.app-topbar .folder-navigation').count(), 1);
  const closePlacement = await panel.evaluate(el => {
    const controls = el.querySelector('.folder-floating-controls').getBoundingClientRect();
    const back = el.querySelector('.library-return-canvas').getBoundingClientRect();
    return { separate: controls.right <= back.left || controls.bottom <= back.top, inside: back.right <= el.getBoundingClientRect().right };
  });
  assert.deepEqual(closePlacement, { separate: true, inside: true });
  await panel.getByRole('button', { name: '返回画板', exact: true }).click(); await libraryOpen(false);
  assert.equal(await page.getByRole('button', { name: '展开画板素材库', exact: true }).evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Tab'); await libraryOpen(true);
  await tabs().getByRole('tab', { name: '全局素材' }).click();
  await panel.getByRole('button',{name:'原图.png',exact:true}).waitFor();
  await page.getByRole('textbox',{name:'搜索当前文件夹'}).fill('原图');
  assert.equal(await panel.locator('.folder-media-card').count(),1);
  await page.keyboard.press('Tab');
  assert.equal(await tabs().getByRole('tab',{name:'全局素材'}).getAttribute('aria-selected'), 'true', 'typing Tab remains normal focus navigation');
  await page.getByRole('textbox',{name:'搜索当前文件夹'}).fill('');
  await panel.getByRole('button',{name:'原图.png',exact:true}).dblclick();
  await page.getByRole('dialog').waitFor(); await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(()=>window.store.getState().canvasLibraryOpen),true,'first Escape closes only local preview');
  await panel.focus(); await page.keyboard.press('Tab');
  assert.equal(await tabs().getByRole('tab',{name:'项目素材'}).getAttribute('aria-selected'), 'true');
  // A short click switches; a held drag reorders without selecting or starting an asset drag.
  const from = await tabs().getByRole('tab',{name:'全局素材'}).boundingBox();
  const to = await tabs().getByRole('tab',{name:'项目素材'}).boundingBox();
  await page.mouse.move(from.x+from.width/2,from.y+from.height/2); await page.mouse.down();
  await page.waitForFunction(()=>document.querySelector('.canvas-source-panel [data-dragging="true"]'));
  await page.mouse.move(to.x+to.width/2,to.y+to.height/2,{steps:8}); await page.mouse.up();
  assert.deepEqual(await tabNames(),['全局素材','项目素材']);
  assert.equal(await tabs().getByRole('tab',{name:'项目素材'}).getAttribute('aria-selected'),'true','sorting keeps active source');
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('bowerbird.library.tabOrder'))),['files','project']);
  const restoredContext = await browser.newContext({storageState:await page.context().storageState()});
  const restored = await restoredContext.newPage();
  await restored.goto(root + 'canvas-reference/preview.html?source-library');
  await restored.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await restored.getByRole('button',{name:'展开画板素材库',exact:true}).click();
  assert.deepEqual(await restored.getByRole('tablist',{name:'画板素材来源'}).getByRole('tab').allTextContents(),['全局素材','项目素材'],'order restores in a fresh document');
  await restoredContext.close();
  await panel.focus(); await page.keyboard.press('Shift+Tab');
  await panel.getByRole('region',{name:'本机文件',exact:true}).waitFor();
  await page.getByRole('group',{name:'文件夹地址栏'}).click({position:{x:2,y:2}});
  await page.keyboard.press('Escape'); await libraryOpen(true);
  assert.equal(await page.getByRole('textbox',{name:'文件夹路径'}).count(),0);
  await page.keyboard.press('Escape'); await libraryOpen(false);
  await page.keyboard.press('Tab'); await libraryOpen(true);
  assert.deepEqual(await tabNames(),['全局素材','项目素材'],'order survives reopening');
  // Restore order with the keyboard alternative and continue the existing library regression.
  await tabs().getByRole('tab',{name:'全局素材'}).focus();
  await page.keyboard.press('Alt+ArrowRight');
  assert.deepEqual(await tabNames(),['项目素材','全局素材']);
  await tabs().getByRole('tab',{name:'项目素材'}).click();
  const size = await page.locator('.canvas-workspace').evaluate(el => {
    const workspace = el.getBoundingClientRect(), source = el.querySelector('.canvas-source-panel').getBoundingClientRect();
    return { gaps: [source.left - workspace.left, source.top - workspace.top, workspace.right - source.right, workspace.bottom - source.bottom],
      radius: getComputedStyle(el.querySelector('.canvas-source-panel')).borderRadius,
      outline: getComputedStyle(el.querySelector('.canvas-source-panel')).outlineStyle,
      toolbarGap: source.top - document.querySelector('.app-topbar').getBoundingClientRect().bottom };
  });
  assert.equal(size.gaps[0], 0, 'drawer is attached to the left workspace edge');
  assert.equal(size.toolbarGap, 0, 'drawer top meets the app toolbar');
  assert.equal(size.gaps[1], 0);
  assert.ok(size.gaps.slice(2).every(gap => gap >= 12 && gap <= 24), 'drawer retains canvas space on the right and bottom');
  assert.equal(size.radius, '0px 0px 22px');
  assert.equal(size.outline, 'none', 'box border is not the browser black focus outline');
  assert.equal(await panel.locator('.library-browser-heading .library-return-canvas').count(), 0, 'close is separate from the floating source tabs');
  assert.equal(await panel.locator('.canvas-source-close .library-return-canvas').count(), 1);
  assert.equal(await page.locator('.canvas-board-shell').evaluate(el => el.inert), true);
  await openHistory(panel);
  await panel.locator('[data-asset-id="global-89"]').waitFor({ state: 'attached' });
  assert.equal(await panel.locator('[data-asset-id]').count(), 95);
  await page.evaluate(() => window.store.getState().selectAll());
  assert.equal(await page.evaluate(() => window.store.getState().selectedIds.size), 95, 'global selection is independent of project assets');
  const tagBefore = await panel.locator('.library-tag-bar').boundingBox();
  await panel.locator('.library-scroller').evaluate(el => el.scrollTop = 600);
  assert.deepEqual(await panel.locator('.library-tag-bar').boundingBox(), tagBefore);
  const scroll = await panel.locator('.library-scroller').evaluate(el => el.scrollTop);
  await page.screenshot({ path: '.tmp/library-pages/project-global.png' });
  await panel.focus(); await page.keyboard.press('Escape'); await libraryOpen(false);
  assert.deepEqual(await page.locator('.canvas-stage').boundingBox(), stageBefore, 'canvas does not resize during the library transition');
  const reveal = await page.locator('.canvas-source-panel').evaluate(async el => {
    const measure = Element.prototype.getBoundingClientRect;
    let cellReads = 0;
    Element.prototype.getBoundingClientRect = function() {
      if (this.classList.contains('masonry-cell')) cellReads++;
      return measure.call(this);
    };
    window.store.getState().setCanvasLibraryOpen(true);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    Element.prototype.getBoundingClientRect = measure;
    const animation = el.getAnimations().find(item => item.transitionProperty === 'transform');
    if (!animation) throw new Error('Missing drawer transform transition');
    const media = el.querySelector('.masonry-layout');
    const inertia = media.getAnimations().find(item => item.transitionProperty === 'transform');
    if (!inertia) throw new Error('Missing media inertia transition');
    animation.pause();
    inertia.pause();
    const duration = Number(animation.effect.getTiming().duration);
    const sample = fraction => {
      animation.currentTime = duration * fraction;
      const style = getComputedStyle(el);
      return { x: new DOMMatrixReadOnly(style.transform).m41, opacity: style.opacity };
    };
    const samples = [.1, .7, 1].map(sample);
    const inertiaTiming = inertia.effect.getTiming();
    const content = [0, .1, .3, .8, 1].map(fraction => {
      inertia.currentTime = Number(inertiaTiming.delay) + Number(inertiaTiming.duration) * fraction;
      return new DOMMatrixReadOnly(getComputedStyle(media).transform).m41;
    });
    animation.finish();
    inertia.finish();
    return { samples, content, cellReads, contentDelay: inertiaTiming.delay };
  });
  assert.ok(reveal.samples[0].x < -50, 'library slides in from the left');
  assert.ok(reveal.samples[1].x < 0 && reveal.samples[1].x > reveal.samples[0].x, 'drawer decelerates without pulling away from its left edge');
  assert.ok(Math.abs(reveal.samples[2].x) < .1, 'drawer settles in its inset frame');
  assert.ok(reveal.samples.every(sample => sample.opacity === '1'), 'card remains solid throughout the slide');
  assert.equal(reveal.cellReads, 0, 'opening an unchanged drawer does not remeasure every masonry tile');
  assert.equal(reveal.contentDelay, 0, 'material motion starts without a fixed pause');
  assert.ok(reveal.content[0] < -40 && reveal.content[1] < -40, 'materials initially lag behind the drawer');
  assert.ok((reveal.content[2] - reveal.content[1]) / .2 > (reveal.content[1] - reveal.content[0]) / .1,
    'materials accelerate as they catch up');
  assert.ok(reveal.content[3] > -5 && Math.abs(reveal.content[4]) < .1, 'materials catch up and settle without an offset');
  await libraryOpen(true);
  assert.equal(await panel.locator('.library-scroller').evaluate(el => el.scrollTop), scroll, 'scroll position survives close/open');
  assert.equal(await panel.getByRole('tab', { name: '全局素材', exact: true }).getAttribute('aria-selected'), 'true');
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.store.getState().setCanvasLibraryOpen(false));
    await page.waitForTimeout(70);
    await page.evaluate(() => window.store.getState().setCanvasLibraryOpen(true));
    await page.waitForTimeout(70);
  }
  await libraryOpen(true);
  assert.equal(await panel.evaluate(el => el.inert), false, 'reversing the box motion keeps the library interactive');
  assert.ok(await panel.locator('.masonry-layout').evaluate(el => Math.abs(new DOMMatrixReadOnly(getComputedStyle(el).transform).m41) < .1), 'interrupted inertia settles back into place');
  await revealTags(panel);
  await panel.getByRole('navigation', { name: '分类标签' }).getByRole('button', { name: '插画', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.canvas-source-panel [data-asset-id]').length === 1);
  assert.equal(await panel.locator('[data-asset-id]').getAttribute('data-asset-id'), 'existing');
  await panel.getByRole('navigation', { name: '分类标签' }).getByRole('button', { name: '插画', exact: true }).click();
  await panel.locator('[data-asset-id="global-89"]').waitFor({ state: 'attached' });
  await panel.getByRole('button', { name: '返回画板', exact: true }).click(); await libraryOpen(false);
  await page.getByRole('textbox', { name: '项目名称', exact: true }).focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => window.store.getState().canvasLibraryOpen), false, 'editing Tab does not toggle library');
  await page.getByRole('button', { name: '展开画板素材库', exact: true }).click(); await libraryOpen(true);
  await panel.locator('.library-scroller').evaluate(el => el.scrollTop = 0);
  await page.evaluate(() => window.store.getState().exitManage());
  await panel.locator('[data-asset-id="existing"]').click();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => window.store.getState().canvasLibraryOpen), true, 'dialog Tab does not toggle background');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  // A real mouse drag reveals the canvas and reaches the existing persistence pipeline.
  const nodeCount = await page.locator('[data-canvas-node-id]').count();
  const drag = await panel.locator('[data-asset-id="a"]').boundingBox();
  await page.mouse.move(drag.x + drag.width / 2, drag.y + drag.height / 2);
  await page.mouse.down();
  await page.mouse.move(drag.x + drag.width / 2 + 30, drag.y + drag.height / 2 + 30, { steps: 5 });
  await page.waitForFunction(() => !window.store.getState().canvasLibraryOpen);
  assert.equal(await page.locator('.canvas-source-panel').evaluate(el => getComputedStyle(el).visibility), 'hidden', 'grab hides the library immediately, without waiting for exit motion');
  assert.equal(await page.locator('.canvas-board-shell').evaluate(el => el.inert), false, 'canvas accepts the active drag immediately');
  const stage = await page.locator('.canvas-stage').boundingBox();
  await page.mouse.move(stage.x + stage.width * .7, stage.y + stage.height * .6, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(count => document.querySelectorAll('[data-canvas-node-id]').length > count, nodeCount);
  assert.equal(await page.locator('.is-library-dragging').count(), 0, 'drag state clears after drop');
  // Cancelling a grab must leave the canvas usable without creating an asset instance.
  await page.getByRole('button', { name: '展开画板素材库', exact: true }).click(); await libraryOpen(true);
  const beforeCancel = await page.locator('[data-canvas-node-id]').count();
  const cancelCard = await panel.locator('[data-asset-id="a"]').boundingBox();
  await page.mouse.move(cancelCard.x + cancelCard.width / 2, cancelCard.y + cancelCard.height / 2);
  await page.mouse.down();
  await page.mouse.move(cancelCard.x + cancelCard.width / 2 + 30, cancelCard.y + cancelCard.height / 2 + 30, { steps: 5 });
  await libraryOpen(false);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.equal(await page.locator('[data-canvas-node-id]').count(), beforeCancel);
  assert.equal(await page.locator('.is-library-dragging').count(), 0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: '展开画板素材库', exact: true }).click(); await libraryOpen(true);
  await revealTags(panel);
  await hoverTag(panel, '平面设计');
  assert.ok(await panel.locator('.library-tag-menu button').evaluateAll(items => items.every(el => parseFloat(getComputedStyle(el).transitionDuration) < .001)), 'reduced motion disables tag travel');
  await page.locator('.app-search input').hover();
  assert.ok(await panel.evaluate(el => parseFloat(getComputedStyle(el).transitionDuration) < 0.001));
  assert.ok(await panel.locator('.masonry-layout').evaluate(el => parseFloat(getComputedStyle(el).transitionDuration) < 0.001), 'reduced motion also disables media inertia');
  await page.evaluate(() => window.store.getState().setCanvasLibraryOpen(false));
  await page.locator('.canvas-workspace.is-source-collapsed').waitFor();
  const reducedClose = await page.locator('.canvas-source-panel').evaluate(el => ({ visibility: getComputedStyle(el).visibility,
    boxDuration: getComputedStyle(el).transitionDuration,
    mediaDuration: getComputedStyle(el.querySelector('.masonry-layout')).transitionDuration }));
  assert.equal(reducedClose.visibility, 'hidden');
  assert.ok(parseFloat(reducedClose.boxDuration) < .001 && parseFloat(reducedClose.mediaDuration) < .001,
    'reduced motion closes both layers immediately (global policy permits a 0.01ms transition)');
  await page.getByRole('button', { name: '展开画板素材库', exact: true }).click(); await libraryOpen(true);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.setViewportSize({ width: 900, height: 700 });
    assert.equal(await panel.evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await revealTags(panel);
    const assetArea = await panel.locator('.library-scroll-area').boundingBox();
    const tagEdge = await panel.locator('.library-tag-bar').boundingBox();
    assert.ok(Math.abs(assetArea.x + assetArea.width - tagEdge.x - tagEdge.width) < 2, 'expanded tags do not reserve project asset width');
    await hoverTag(panel, '平面设计');
    await page.screenshot({ path: `.tmp/library-pages/project-${theme}-900.png` });
    await page.locator('.app-search input').hover();
    await page.evaluate(value => window.testPalette = value, fullPalette);
    await panel.getByRole('button', { name: '颜色筛选', exact: true }).click();
    await panel.getByRole('dialog', { name: '颜色筛选' }).getByRole('button', { name: '红', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === 'palette_overview').at(-1).args.projectId), null);
    await checkColorStrip(panel);
    await page.screenshot({ path: `.tmp/library-pages/colors-${theme}-900.png` });
    // Desktop minimum window is 900px; constrain the library itself to test split-workspace widths.
    await panel.evaluate(el => el.style.width = '420px');
    await checkColorStrip(panel, false);
    await panel.getByRole('dialog', { name: '颜色筛选' }).getByRole('button', { name: '黑', exact: true }).click();
    assert.equal(await page.evaluate(() => window.store.getState().colorFilter), 'black');
    await panel.getByRole('button', { name: '清除颜色筛选', exact: true }).click();
    assert.equal(await page.evaluate(() => window.store.getState().colorFilter), null);
    await page.screenshot({ path: `.tmp/library-pages/colors-${theme}-420.png` });
    await page.keyboard.press('Escape');
    await panel.evaluate(el => el.style.removeProperty('width'));
  }
  await page.evaluate(() => {
    window.testTags = Array.from({length: 45}, (_, i) => ({id: `long-${i}`, name: `较长的分类标签 ${i + 1}`}));
    window.store.setState({autoTags: []});
  });
  const longMenu = panel.getByRole('navigation', {name:'分类标签'});
  await revealTags(panel);
  await longMenu.getByRole('button', {name:'较长的分类标签 45', exact:true}).waitFor();
  assert.equal(await longMenu.evaluate(el => el.scrollHeight > el.clientHeight), true, 'long index scrolls inside its fixed region');
  await longMenu.locator('button').first().focus(); await page.keyboard.press('End');
  assert.equal(await longMenu.locator('button').last().evaluate(el => el === document.activeElement), true);
  assert.ok(await longMenu.evaluate(el => el.scrollTop > 0));
  const edge = await panel.locator('.library-tag-bar').boundingBox();
  const last = await longMenu.locator('button').last().boundingBox();
  assert.ok(last.y >= edge.y && last.y + last.height <= edge.y + edge.height, 'last tag stays reachable');
  await page.screenshot({path:'.tmp/library-pages/tags-long.png'});
  await page.evaluate(() => { window.failTags = true; window.store.setState({autoTags: []}); });
  await longMenu.getByRole('button', {name:'标签加载失败 · 重试'}).waitFor();
  await page.evaluate(() => { window.failTags = false; window.testTags = []; });
  await longMenu.getByRole('button', {name:'标签加载失败 · 重试'}).click();
  await longMenu.getByRole('button', {name:'标签加载失败 · 重试'}).waitFor({state:'hidden'});
  assert.equal(await panel.getByRole('button', {name:'管理标签', exact:true}).count(), 1, 'empty catalogue retains management');
  // Real App routing: the existing return button retains save protection.
  await page.goto(root + 'canvas-reference/preview.html?source-library&detail-route');
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await page.evaluate(() => {
    window.savedFlush = window.store.getState().projectCanvasFlush;
    window.store.getState().registerProjectCanvasFlush(async () => { throw new Error('模拟保存失败'); });
  });
  const navigation = page.locator('.app-topbar').getByRole('button', { name: '返回素材库', exact: true });
  await navigation.click();
  await page.getByText('模拟保存失败', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.store.getState().activeProjectId), 'p');
  await page.evaluate(() => window.store.getState().registerProjectCanvasFlush(window.savedFlush));
  await navigation.click();
  await page.locator('.library-home').getByRole('tab',{name:'全局素材',exact:true}).click();
  await page.getByRole('region',{name:'本机文件',exact:true}).getByRole('button',{name:'原图.png',exact:true}).waitFor();
  const localBounds = await page.getByRole('region',{name:'本机文件',exact:true}).boundingBox();
  const workspaceBounds = await page.locator('.app-workspace').boundingBox();
  assert.ok(localBounds.y >= workspaceBounds.y, 'local file navigation is not cropped by host scrolling');
  assert.ok(localBounds.x >= 0 && localBounds.x + localBounds.width <= 901, 'local files stay within the viewport after sidebar collapse');
  await page.screenshot({path:'.tmp/library-pages/home-local-files.png'});
  // Home uses the same ordered Tab cycle, with editing and modal guards.
  const homeTabs = () => home.getByRole('tablist', { name: '主页视图' });
  await homeTabs().getByRole('tab', { name: '全局素材', exact: true }).focus();
  await page.keyboard.press('Tab');
  assert.equal(await homeTabs().getByRole('tab', { name: '项目管理', exact: true }).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Tab');
  assert.equal(await homeTabs().getByRole('tab', { name: '全局素材', exact: true }).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await homeTabs().getByRole('tab', { name: '项目管理', exact: true }).getAttribute('aria-selected'), 'true');
  await home.getByRole('spinbutton', { name: '主页素材大小数值', exact: true }).focus();
  await page.keyboard.press('Tab');
  assert.equal(await homeTabs().getByRole('tab', { name: '项目管理', exact: true }).getAttribute('aria-selected'), 'true', 'size input retains native Tab');
  await page.getByRole('textbox', { name: '搜索项目', exact: true }).focus();
  await page.keyboard.press('Tab');
  assert.equal(await homeTabs().getByRole('tab', { name: '项目管理', exact: true }).getAttribute('aria-selected'), 'true', 'search retains native Tab');
  await homeTabs().getByRole('tab', { name: '全局素材', exact: true }).focus();
  await page.keyboard.press('Alt+ArrowLeft');
  assert.deepEqual(await homeTabs().getByRole('tab').allTextContents(), ['全局素材', '项目管理']);
  await homeTabs().getByRole('tab', { name: '项目管理', exact: true }).focus();
  await page.keyboard.press('Tab');
  await home.getByRole('button', { name: '原图.png', exact: true }).waitFor();
  assert.equal(await homeTabs().getByRole('tab', { name: '全局素材', exact: true }).getAttribute('aria-selected'), 'true', 'Tab follows reordered home sources');
  await page.getByRole('group', { name: '文件夹地址栏' }).click({position:{x:2,y:2}});
  await page.getByRole('textbox', { name: '文件夹路径', exact: true }).press('Tab');
  assert.equal(await homeTabs().getByRole('tab', { name: '全局素材', exact: true }).getAttribute('aria-selected'), 'true');
  await home.getByRole('button', { name: '原图.png', exact: true }).dblclick();
  await page.getByRole('dialog').waitFor(); await page.keyboard.press('Tab');
  assert.equal(await homeTabs().getByRole('tab', { name: '全局素材', exact: true }).getAttribute('aria-selected'), 'true', 'preview keeps Tab inside the dialog');
  await page.keyboard.press('Escape');
  await homeTabs().getByRole('tab', { name: '全局素材', exact: true }).focus();
  await page.keyboard.press('Alt+ArrowRight');

  await openHistory(home);
  await page.locator('.library-home').getByRole('tab', { name: '项目管理', exact: true }).click();
  await page.locator('.library-home .library-project-folder').waitFor();
  assert.equal(await page.locator('.library-home [data-asset-id]').count(), 0);
  assert.equal(await page.evaluate(() => window.store.getState().activeProjectId), null);
  await page.locator('.library-home').getByRole('button', { name: '打开项目 引用布局合成验收', exact: true }).click();
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  assert.equal(await page.evaluate(() => window.store.getState().canvasLibraryOpen), false);
  const search = page.getByRole('textbox', { name: '搜索素材', exact: true });
  await search.pressSequentially('existing', { delay: 30 });
  assert.equal(await search.inputValue(), 'existing', 'revealing from search must retain keyboard focus');
  assert.equal(await page.evaluate(() => window.store.getState().canvasLibraryOpen), true);
  // Review the design over bundled sample artwork, rather than blank color tiles.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(root + 'project-drop/preview.html?layout');
  await openHistory(home);
  await home.locator('[data-asset-id="owned"]').waitFor();
  const sampleImages = await Promise.all(Array.from({ length: 11 }, async (_, i) =>
    'data:image/webp;base64,' + (await readFile(`src-tauri/resources/samples/preset-${String(i + 1).padStart(2, '0')}.webp`)).toString('base64')));
  const presetNames = [...(await readFile('src-tauri/resources/classification-labels.sql', 'utf8')).matchAll(/\('preset_classification_\d+', '([^']+)'/g)].map(match => match[1]);
  await page.evaluate(async ({ sampleImages, presetNames }) => {
    const template = window.store.getState().assets[0];
    const samples = await Promise.all(sampleImages.map(async src => {
      const image = new Image(); image.src = src; await image.decode();
      return { src, width: image.naturalWidth, height: image.naturalHeight };
    }));
    window.testTags = presetNames.map((name, i) => ({ id: `preset-${i}`, name }));
    window.store.setState({ autoTags: [], libraryThumbnailWidth: 160, assets: Array.from({ length: 44 }, (_, i) => {
      const sample = samples[i % samples.length];
      return { ...template, id: `visual-${i}`, name: `示例素材 ${i + 1}`, thumb_path: sample.src, store_path: sample.src, width: sample.width, height: sample.height };
    }), total: 44, libraryMemberships: [] });
  }, { sampleImages, presetNames });
  await home.locator('[data-asset-id="visual-0"]').waitFor();
  await page.waitForTimeout(500);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.locator('.app-search input').hover();
    await home.locator('.library-tag-content').waitFor({ state: 'hidden' });
    await page.screenshot({ path: `.tmp/library-pages/tag-overlay-${theme}-closed.png` });
    const before = await home.locator('.masonry-layout').boundingBox();
    await revealTags(home);
    await hoverTag(home, '角色立绘');
    if (theme === 'light') {
      await home.locator('.library-tag-menu').evaluate(el => {
        window.tagMotionFrames = el.getAnimations({ subtree: true });
        window.tagMotionFrames.forEach(a => a.pause());
      });
      for (const time of [0, 60, 140, 300]) {
        await page.evaluate(time => window.tagMotionFrames.forEach(a => a.currentTime = time), time);
        await page.screenshot({ path: `.tmp/library-pages/tag-motion-${time}.png`, clip: { x: 1160, y: 150, width: 240, height: 680 } });
      }
      await page.evaluate(() => { window.tagMotionFrames.forEach(a => a.play()); delete window.tagMotionFrames; });
    }
    await home.locator('.library-tag-menu').evaluate(async el => {
      await Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished.catch(() => {})));
    });
    assert.deepEqual(await home.locator('.masonry-layout').boundingBox(), before, 'revealing the overlay never moves the artwork');
    await page.screenshot({ path: `.tmp/library-pages/tag-overlay-${theme}-open.png` });
  }
  await page.evaluate(() => window.store.getState().enterManage());
  await revealTags(home);
  const throughGradient = await home.evaluate(el => {
    const bar = el.querySelector('.library-tag-bar').getBoundingClientRect();
    const x = bar.left + 14;
    for (const card of el.querySelectorAll('[data-asset-id]')) {
      const rect = card.getBoundingClientRect();
      const top = Math.max(rect.top, bar.top + 30), bottom = Math.min(rect.bottom, bar.bottom - 30);
      if (x <= rect.left || x >= rect.right || bottom - top < 20) continue;
      const y = (top + bottom) / 2;
      if (document.elementFromPoint(x, y)?.closest('[data-asset-id]') === card) return { x, y, id: card.dataset.assetId };
    }
    return null;
  });
  assert.ok(throughGradient, 'the transparent portion passes pointer hits to actual artwork');
  await page.mouse.click(throughGradient.x, throughGradient.y);
  assert.equal(await page.evaluate(id => window.store.getState().selectedIds.has(id), throughGradient.id), true);
  await home.locator('.library-tag-content').waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
  console.log('PASS: project/files navigation with legacy index, empty projects, home ordered Tab cycle/editing guards, shared project card sizing/control/pinch, single navigation entry, right tag index with bounded hover magnification and keyboard navigation, 28px floating controls, full canvas overlay, scoped selection, Tab/editing/dialog guards, scroll/canvas preservation, drag reveal, reduced motion and narrow themes.');
} catch (error) {
  console.error(errors);
  console.error(await page.evaluate(() => ({ project: window.store?.getState().activeProjectId,
    projects: window.store?.getState().projects, home: window.store?.getState().libraryHomeView,
    search: window.store?.getState().searchQuery, active: document.activeElement?.outerHTML,
    input: document.querySelector('.app-search')?.outerHTML, errors: window.calls?.slice(-8) })));
  throw error;
} finally { await browser.close(); await server.close(); }
