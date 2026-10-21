import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/canvas-library-resize/vite', server: { host: '127.0.0.1', port: 1699, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
const panel = page.locator('.canvas-source-panel');
const handle = page.getByRole('separator', { name: '调整素材库宽度' });
const close = page.getByRole('button', { name: '关闭素材库', exact: true });
async function clickControl(name) {
  const button = panel.getByRole('button', { name, exact: true });
  if (!await button.isVisible()) await panel.getByRole('button', { name: '更多素材库控件', exact: true }).click();
  await button.click();
}
async function selectSource(name) {
  if (name === '文件浏览器') await clickControl(name);
  else await panel.getByRole('tab', { name, exact: true }).click();
  const more = panel.getByRole('button', { name: '更多素材库控件', exact: true });
  if (await more.count() && await more.getAttribute('aria-expanded') === 'true') await more.click();
}
async function settle() {
  await panel.evaluate(async el => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
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
    const tab = document.querySelector('.canvas-library-resize');
    const workspace = el.parentElement;
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
  assert.ok(samples.samples.every(sample => Math.abs(sample.seam) < 1), 'panel and pull tab stay joined throughout motion');
  const distances = samples.samples.slice(1).map((sample, i) => Math.abs(sample.x - samples.samples[i].x));
  assert.ok(opening ? distances[3] < distances[1] : distances[0] < distances[2], 'arrival decelerates and departure accelerates');
}
async function assertGrid() {
  const handleGeometry = await handle.evaluate(el => {
    const box = el.getBoundingClientRect();
    const panel = document.getElementById(el.getAttribute('aria-controls')).getBoundingClientRect();
    const workspace = el.closest('.canvas-workspace').getBoundingClientRect();
    return { outside: box.left >= panel.right - 0.5, visible: box.right <= workspace.right - 3,
      clickable: el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)) };
  });
  assert.ok(handleGeometry.outside && handleGeometry.visible && handleGeometry.clickable,
    'pull tab stays outside the panel/scrollbar/tag column and fully inside the window');
  const grid = panel.locator('.masonry-layout:visible, .folder-masonry:visible').filter({ has: page.locator('.folder-media-card, .masonry-item') }).first();
  await grid.waitFor();
  await page.waitForFunction(() => {
    const grid = [...document.querySelectorAll('.canvas-source-panel .masonry-layout, .canvas-source-panel .folder-masonry')].find(el => el.getBoundingClientRect().width && el.checkVisibility());
    if (!grid) return false;
    const cells = [...grid.children].map(child => child.getBoundingClientRect());
    return cells.every((cell, i) => cells.slice(i + 1).every(other => cell.right <= other.left + 1 || cell.left >= other.right - 1 || cell.bottom <= other.top + 1 || cell.top >= other.bottom - 1));
  });
  const result = await grid.evaluate(el => {
    const box = el.getBoundingClientRect();
    const cells = [...el.children].map(child => child.getBoundingClientRect());
    return { columns: new Set(cells.map(cell => Math.round(cell.left))).size, inBounds: cells.every(cell => cell.left >= box.left && cell.right <= box.right + 1), count: cells.length };
  });
  assert.ok(result.inBounds && result.count > 0, 'every card stays inside its resized layout');
  return result.columns;
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
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -80);
  await page.keyboard.up('Control');
  await page.waitForFunction(value => document.querySelector('.canvas-plane').style.transform !== value, scrolled);
  assert.equal(await panel.getAttribute('aria-hidden'), 'false', 'canvas interactions leave the library open');
}
try {
  await mkdir('.tmp/canvas-library-resize', { recursive: true });
  await page.goto('http://127.0.0.1:1699/scripts/fixtures/canvas-reference/preview.html?source-library&canvas-library&detail-route');
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await page.waitForFunction(() => document.activeElement?.classList.contains('canvas-stage'));
  // Exercise the actual home → project picker → project path, including modal focus restoration.
  await page.getByRole('button', { name: '返回主页', exact: true }).click();
  await page.getByRole('button', { name: '我的项目', exact: true }).click();
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
  assert.equal(await panel.getByRole('tab', { name: '全局素材', exact: true }).getAttribute('aria-selected'), 'true');
  await panel.getByRole('tab', { name: '项目素材', exact: true }).click();
  await settle();
  assert.ok(await panel.evaluate(el => {
    const workspace = el.parentElement;
    return ['::before', '::after'].every(pseudo => getComputedStyle(workspace, pseudo).content === 'none')
      && getComputedStyle(el).boxShadow !== 'none';
  }), 'drawer uses only a box shadow, without edge blur layers');
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
  await assertGrid();
  const node = page.locator('[data-canvas-node-id="old"]');
  const original = await node.boundingBox();
  await page.keyboard.down('Control');
  await page.mouse.click(original.x + original.width - 25, original.y + 50);
  await page.keyboard.up('Control');
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
  await page.keyboard.press('Control+z');
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
  for (const name of ['全局素材', '项目素材', '文件浏览器']) {
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
    await dragTo(480);
    await assertGrid();
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
    await dragTo(900);
    await assertGrid();
  }
  await page.setViewportSize({ width: 760, height: 700 });
  await settle();
  assert.ok((await panel.boundingBox()).width <= 760 - 12, 'window resize clamps the panel');
  await assertGrid();
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await page.screenshot({ path: '.tmp/canvas-library-resize/dark-760.png' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await dragTo(500);
  await assertGrid();
  await page.keyboard.press('Escape');
  await page.locator('.app-topbar input').focus();
  await page.evaluate(() => window.emitChange());
  await page.waitForTimeout(300);
  assert.ok(await page.locator('.app-topbar input').evaluate(el => el === document.activeElement), 'background updates do not steal search focus');
  assert.deepEqual(errors, []);
  console.log('PASS project entry focus/Tab, integrated pull tab/close, eased motion, resize/reflow, shadow without edge blur, canvas drag/copy/undo/context menu and pan/zoom with all three sources open, scoped keyboard focus, window bounds, dark/reduced motion and search focus');
} finally { await browser.close(); await server.close(); }
