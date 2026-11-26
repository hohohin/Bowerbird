import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/canvas-library-resize/vite', server: { host: '127.0.0.1', port: 1699, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.setDefaultTimeout(10000);
page.setDefaultNavigationTimeout(60000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
const panel = page.locator('.canvas-source-panel');
const handle = page.getByRole('separator', { name: '调整素材库宽度' });
const close = page.getByRole('button', { name: '关闭素材库', exact: true });
const scroller = panel.locator('.catalog-scroller:visible');
async function clickControl(name) {
  const button = panel.getByRole('button', { name, exact: true });
  if (!await button.isVisible()) await panel.getByRole('button', { name: '更多素材库控件', exact: true }).click();
  await button.click();
}
async function selectSource(name) {
  const button = panel.getByRole('button', { name, exact: true });
  if (await button.getAttribute('aria-current') !== 'true') await button.click();
  const more = panel.getByRole('button', { name: '更多素材库控件', exact: true });
  if (await more.count() && await more.getAttribute('aria-expanded') === 'true') await more.click();
}
async function settle() {
  await panel.evaluate(async el => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(el.getAnimations({ subtree: true }).filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {})));
  });
}
async function dragTo(width) {
  const box = await handle.boundingBox();
  const before = await panel.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  assert.equal(await handle.evaluate(el => getComputedStyle(el).cursor), 'grabbing');
  await page.mouse.move(box.x + box.width / 2 + width - before.width, box.y + box.height / 2, { steps: 15 });
  await page.mouse.up();
  assert.equal(await handle.evaluate(el => getComputedStyle(el).cursor), 'grab');
  await settle();
}
async function sampleMotion(opening) {
  const samples = await panel.evaluate(async (el, opening) => {
    const workspace = el.parentElement;
    const tab = workspace.querySelector(':scope > .canvas-library-resize');
    const animations = workspace.getAnimations({ subtree: true }).filter(animation => animation.transitionProperty === 'transform');
    const panelAnimation = animations.find(animation => animation.effect.target === el);
    if (!panelAnimation) throw new Error('Expected an interruptible drawer transition');
    const duration = panelAnimation.effect.getTiming().duration;
    animations.forEach(animation => animation.pause());
    const samples = [];
    for (const fraction of [0, .25, .5, .75, 1]) {
      animations.forEach(animation => { animation.currentTime = duration * fraction; });
      const panelBox = el.getBoundingClientRect(); const tabBox = tab.getBoundingClientRect();
      samples.push({ x: panelBox.x, seam: tabBox.left - panelBox.right });
    }
    animations.forEach(animation => animation.finish());
    return { duration, samples };
  }, opening);
  assert.equal(samples.duration, opening ? 480 : 300);
  assert.ok(samples.samples.every(sample => Math.abs(sample.seam) < 1), `panel and pull tab stay joined throughout motion: ${JSON.stringify(samples.samples)}`);
  const distances = samples.samples.slice(1).map((sample, i) => Math.abs(sample.x - samples.samples[i].x));
  assert.ok(opening ? distances[3] < distances[1] : distances[0] < distances[2], 'arrival decelerates and departure accelerates');
}
async function assertGrid(minimumColumns = 1, maximumCardWidth = 320) {
  const handleGeometry = await handle.evaluate(el => {
    const box = el.getBoundingClientRect();
    const panel = document.getElementById(el.getAttribute('aria-controls')).getBoundingClientRect();
    const workspace = el.closest('.canvas-workspace').getBoundingClientRect();
    return { outside: box.left >= panel.right - 0.5, visible: box.right <= workspace.right - 3,
      clickable: el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)) };
  });
  assert.ok(handleGeometry.outside && handleGeometry.visible && handleGeometry.clickable,
    'pull tab stays outside the panel/scrollbar/tag column and fully inside the window');
  const grid = panel.locator('[data-catalog-page][data-columns]:visible').filter({ has: page.locator('.folder-media-card') }).first();
  await grid.waitFor();
  const result = await scroller.evaluate(view => {
    const box = view.getBoundingClientRect();
    const pages = [...view.querySelectorAll('[data-catalog-page][data-columns]')];
    const cells = pages.flatMap(page => [...page.children].filter(child => child.matches('.folder-media-card, .connected-media, .catalog-positioned-card, .catalog-generation-group'))
      .map(child => child.getBoundingClientRect()));
    return {
      columns: Number(pages[0]?.dataset.columns),
      renderedColumns: new Set(cells.map(cell => Math.round(cell.left))).size,
      count: cells.length, widest: Math.max(...cells.map(cell => cell.width)),
      inBounds: view.scrollWidth <= view.clientWidth && cells.every(cell => cell.left >= box.left && cell.right <= box.right + 1),
      overlaps: cells.some((cell, index) => cells.slice(index + 1).some(other =>
        cell.right > other.left + 1 && cell.left < other.right - 1 && cell.bottom > other.top + 1 && cell.top < other.bottom - 1)),
    };
  });
  assert.ok(result.inBounds && result.count > 0, 'every card stays inside its resized layout');
  assert.equal(result.overlaps, false, 'cards never overlap, including across pages');
  assert.ok(result.columns >= minimumColumns && result.renderedColumns >= minimumColumns, JSON.stringify(result));
  assert.ok(result.widest <= maximumCardWidth + 1, JSON.stringify(result));
  return result.columns;
}
async function visibleAnchor() {
  return scroller.evaluate(view => {
    const viewport = view.getBoundingClientRect();
    return [...view.querySelectorAll('[data-asset-id]')].map(card => {
      const box = card.getBoundingClientRect();
      return { id: card.dataset.assetId, offset: box.top - viewport.top, bottom: box.bottom - viewport.top };
    }).filter(card => card.bottom > 0 && card.offset < viewport.height)
      .sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset))[0];
  });
}
async function assertAnchor(anchor) {
  const offset = await scroller.evaluate((view, id) => {
    const card = view.querySelector(`[data-asset-id="${id}"]`);
    return card ? card.getBoundingClientRect().top - view.getBoundingClientRect().top : null;
  }, anchor.id);
  assert.ok(offset !== null && Math.abs(offset - anchor.offset) <= 30, `lost anchor ${anchor.id}: ${anchor.offset} → ${offset}`);
}
async function assertCanvasInteractive() {
  const stage = page.locator('.canvas-stage');
  const plane = page.locator('.canvas-plane');
  const transform = () => plane.evaluate(el => el.style.transform);
  assert.equal(await stage.evaluate(el => !!el.closest('[inert], [aria-hidden="true"]')), false);
  await panel.focus();
  await page.keyboard.down('Space');
  assert.equal(await stage.evaluate(el => el.classList.contains('is-pan-ready')), false, 'library focus does not activate canvas shortcuts');
  await page.keyboard.up('Space');
  const before = await transform();
  await page.mouse.click(1100, 650);
  assert.equal(await stage.evaluate(el => el === document.activeElement), true);
  await page.keyboard.down('Space');
  await page.waitForFunction(() => document.querySelector('.canvas-stage').classList.contains('is-pan-ready'));
  await page.mouse.move(1100, 650);
  await page.mouse.down();
  await page.mouse.move(1160, 680, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  assert.notEqual(await transform(), before, 'space-drag pans the exposed canvas');
  const panned = await transform();
  await page.mouse.wheel(0, 80);
  await page.waitForFunction(value => document.querySelector('.canvas-plane').style.transform !== value, panned);
  const scrolled = await transform();
  await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
  await page.mouse.wheel(0, -80);
  await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
  await page.waitForFunction(value => document.querySelector('.canvas-plane').style.transform !== value, scrolled);
  assert.equal(await panel.getAttribute('aria-hidden'), 'false', 'canvas interactions leave the library open');
}
try {
  await mkdir('.tmp/canvas-library-resize', { recursive: true });
  await page.goto('http://127.0.0.1:1699/scripts/fixtures/canvas-reference/preview.html?source-library&canvas-library&detail-route&resize-library');
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await page.waitForFunction(() => document.activeElement?.classList.contains('canvas-stage'));
  // Exercise the actual home → project picker → project path, including modal focus restoration.
  await page.getByRole('button', { name: '返回主页', exact: true }).click();
  const homeNav = page.getByRole('navigation', { name: '首页' });
  await homeNav.getByRole('button', { name: '素材库', exact: true }).click();
  const homeGallery = page.locator('.library-home .catalog-gallery:visible');
  const homeSize = homeGallery.locator('input[type="range"][aria-label="主页素材大小"]');
  await homeGallery.locator('.folder-media-card').first().waitFor();
  await homeGallery.evaluate(el => {
    for (let notch = 0; notch < 6; notch++) {
      el.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -12, bubbles: true, cancelable: true }));
    }
  });
  assert.equal(await homeSize.inputValue(), '100');
  await homeNav.getByRole('button', { name: '项目', exact: true }).click();
  await page.getByRole('button', { name: '打开项目 引用布局合成验收', exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.classList.contains('canvas-stage'));
  const stage = await page.locator('.canvas-stage').boundingBox();
  await page.keyboard.press('Tab');
  await handle.waitFor();
  await sampleMotion(true);
  assert.equal(await panel.getByRole('button', { name: '返回画板', exact: true }).count(), 0);
  assert.equal(await handle.evaluate(el => getComputedStyle(el).cursor), 'grab');
  const closeBox = await close.boundingBox(); const gripBox = await handle.boundingBox();
  assert.ok(closeBox.y + closeBox.height <= gripBox.y && gripBox.width === 24, 'close icon sits above the narrow six-dot grip');
  const sidebar = panel.getByRole('complementary', { name: '素材库导航', exact: true });
  assert.equal(await sidebar.getAttribute('data-collapsed'), null);
  const canvasSize = panel.getByRole('slider', { name: '项目素材大小', exact: true });
  assert.equal(await canvasSize.inputValue(), '41', 'the canvas keeps its 160px default despite the 320px home preference');
  await selectSource('引用布局合成验收');
  await settle();
  assert.ok(await panel.evaluate(el => {
    const workspace = el.parentElement;
    return ['::before', '::after'].every(pseudo => {
      const style = getComputedStyle(workspace, pseudo);
      return style.content === 'none' || (style.pointerEvents === 'none' && style.filter === 'none');
    }) && getComputedStyle(el).backdropFilter === 'none';
  }), 'industrial drawer decorations do not intercept input or blur the canvas');
  const fullWidth = (await panel.boundingBox()).width;
  const fullColumns = await assertGrid();
  await dragTo(620);
  assert.ok(Math.abs((await panel.boundingBox()).width - 620) < 2, 'drag sets the actual panel boundary');
  assert.ok(await assertGrid() < fullColumns, 'narrower panel lays out fewer columns');
  assert.deepEqual(await page.locator('.canvas-stage').boundingBox(), stage, 'resizing does not resize the canvas');
  await close.click();
  await sampleMotion(false);
  await settle();
  assert.equal(await page.getByRole('button', { name: '展开画板素材库', exact: true }).evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Tab');
  await settle();
  assert.ok(Math.abs((await panel.boundingBox()).width - 620) < 2, 'closing and reopening retains width');
  await handle.focus();
  await page.keyboard.press('ArrowLeft');
  await settle();
  assert.equal(await handle.getAttribute('aria-valuenow'), '588');
  await page.keyboard.press('Home');
  await settle();
  assert.equal(await handle.getAttribute('aria-valuenow'), await handle.getAttribute('aria-valuemin'));
  await assertGrid(2, 112);
  await canvasSize.press('Home');
  assert.equal(await page.evaluate(() => window.store.getState().canvasThumbnailWidth), 48);
  await assertGrid(3, 65);
  await scroller.evaluate(el => el.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -12, bubbles: true, cancelable: true })));
  assert.ok(await page.evaluate(() => window.store.getState().canvasThumbnailWidth) > 48);
  await canvasSize.press('End');
  await assertGrid(2, 112);
  const node = page.locator('[data-canvas-node-id="old"]');
  const original = await node.boundingBox();
  await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
  await page.mouse.click(original.x + original.width - 25, original.y + 50);
  await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
  assert.ok(await node.evaluate(el => el.classList.contains('is-selected')));
  await page.mouse.move(original.x + original.width - 25, original.y + 50);
  await page.mouse.down();
  await page.mouse.move(original.x + original.width + 55, original.y + 80, { steps: 8 });
  await page.mouse.up();
  assert.ok((await node.boundingBox()).x > original.x + 60, 'canvas cards can be dragged while drawer is open');
  assert.ok(await node.evaluate(el => el.classList.contains('is-selected')));
  const copied = await node.evaluate(el => {
    const data = new DataTransfer();
    el.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data }));
    return data.getData('text/plain');
  });
  assert.ok(copied.includes('existing'), 'focused canvas selection can be copied while drawer is open');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await page.waitForFunction(x => Math.abs(document.querySelector('[data-canvas-node-id="old"]').getBoundingClientRect().x - x) < 1, original.x);
  await assertCanvasInteractive();
  await page.mouse.click(1100, 650, { button: 'right' });
  await page.getByRole('menu').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('menu').waitFor({ state: 'hidden' });
  assert.equal(await panel.getAttribute('aria-hidden'), 'false', 'Escape dismisses the canvas menu without closing the drawer');
  await page.screenshot({ path: '.tmp/canvas-library-resize/project-480.png' });
  await handle.dblclick();
  await settle();
  assert.ok(Math.abs((await panel.boundingBox()).width - fullWidth) < 2);
  // Reverse a close in flight: both pieces must reverse together without a seam.
  await close.click();
  await page.waitForTimeout(70);
  await page.keyboard.press('Tab');
  await settle();
  await assertGrid();
  await dragTo(620);
  for (const name of ['全部素材', '引用布局合成验收', '全部文件夹素材', '标签模式']) {
    await selectSource(name);
    await panel.locator('.folder-media-card').first().waitFor();
    await settle();
    await assertGrid();
    await close.click();
    await settle();
    assert.equal(await panel.getAttribute('aria-hidden'), 'true');
    await page.keyboard.press('Tab');
    await settle();
    await selectSource(name);
    await panel.locator('.folder-media-card').first().waitFor();
    await dragTo(370);
    const minimum = await assertGrid(2, 112);
    assert.equal(await sidebar.getAttribute('data-collapsed'), null, 'narrowing preserves the sidebar preference');
    await dragTo(480);
    const narrow = await assertGrid(2, 152);
    await assertCanvasInteractive();
    assert.ok(await panel.locator('.library-controls-host > button, .folder-floating-controls > button, .library-color-control > button').evaluateAll(buttons => buttons.filter(button => button.checkVisibility() && getComputedStyle(button).visibility === "visible" && !button.closest("[inert], [aria-hidden=\"true\"]")).every(button => {
      const box = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    })), 'narrow controls remain clickable');
    await clickControl('颜色筛选');
    const colors = panel.getByRole('dialog', { name: '颜色筛选', exact: true });
    await colors.waitFor();
    assert.ok(await colors.evaluate(el => {
      const box = el.getBoundingClientRect();
      const panel = document.querySelector('.canvas-source-panel').getBoundingClientRect();
      return box.left >= panel.left && box.right <= panel.right;
    }), 'expanded color controls stay inside a narrow drawer');
    await page.keyboard.press('Escape');
    await page.screenshot({ path: `.tmp/canvas-library-resize/${name}-480.png` });
    await dragTo(620);
    const medium = await assertGrid(2);
    await dragTo(900);
    const wide = await assertGrid(2);
    await handle.dblclick();
    await settle();
    const full = await assertGrid(2);
    assert.ok(minimum <= narrow && narrow <= medium && medium <= wide && wide <= full);
  }
  await dragTo(480);
  await scroller.evaluate(view => { view.scrollTop = 2400; });
  await settle();
  const anchor = await visibleAnchor();
  assert.ok(anchor && await scroller.evaluate(view => view.scrollTop) > 1000);
  const columnsBeforeHide = await assertGrid(2, 152);
  await scroller.evaluate(view => { view.style.display = 'none'; });
  await settle();
  assert.equal(await panel.locator('[data-catalog-page][data-columns]').first().getAttribute('data-columns'), String(columnsBeforeHide));
  await panel.locator('.catalog-scroller').evaluate(view => { view.style.display = ''; });
  await settle();
  await assertAnchor(anchor);
  await dragTo(900);
  await assertAnchor(anchor);
  const beforeWindowResize = await visibleAnchor();
  await page.setViewportSize({ width: 760, height: 700 });
  await settle();
  assert.ok((await panel.boundingBox()).width <= 760 - 12, 'window resize clamps the panel');
  await assertGrid(2);
  await assertAnchor(beforeWindowResize);
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await page.screenshot({ path: '.tmp/canvas-library-resize/dark-760.png' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await dragTo(500);
  await assertGrid();
  await page.keyboard.press('Escape');
  await page.locator('.canvas-board-title').focus();
  await page.evaluate(() => window.emitChange());
  await page.waitForTimeout(300);
  assert.ok(await page.locator('.canvas-board-title').evaluate(el => el === document.activeElement), 'background updates do not steal input focus');
  await page.getByRole('button', { name: '返回主页', exact: true }).click();
  await homeNav.getByRole('button', { name: '素材库', exact: true }).click();
  assert.equal(await homeSize.inputValue(), '100', 'changing the canvas slider preserves the home preference');
  assert.deepEqual(errors, []);
  console.log('PASS drawer motion and canvas interactions, four responsive library views, independent thumbnail controls, anchored resize and hidden viewport, dark/reduced motion and input focus');
} finally { await browser.close(); await server.close(); }
