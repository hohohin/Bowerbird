import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ server: { host: '127.0.0.1', port: 1694, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
const panel = page.locator('.canvas-source-panel');
async function settle() {
  await panel.evaluate(async el => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
  });
}
async function frostVisible(visible) {
  const layers = await page.locator('.canvas-workspace').evaluate(el => ['::before', '::after'].map(pseudo => {
    const style = getComputedStyle(el, pseudo);
    return { content: style.content, blur: style.backdropFilter, pointer: style.pointerEvents };
  }));
  assert.ok(layers.every(layer => visible
    ? layer.content === '""' && layer.blur === 'blur(8px)' && layer.pointer === 'none'
    : layer.content === 'none'), 'frost follows drawer visibility without intercepting input');
}
try {
  await mkdir('.tmp/library-drawer', { recursive: true });
  await page.goto('http://127.0.0.1:1694/scripts/fixtures/canvas-reference/preview.html?source-library&detail-route');
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await page.mouse.move(700, 450);
  await page.locator('.app-sidebar-host.is-auto-hidden').waitFor({ state: 'attached' });
  await page.locator('.app-sidebar-host').evaluate(async el => {
    await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
  });
  await frostVisible(false);
  const stageBefore = await page.locator('.canvas-stage').boundingBox();
  await page.getByRole('button', { name: '展开画板素材库', exact: true }).click();
  await settle();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    for (const width of [1400, 900]) {
      await page.setViewportSize({ width, height: 900 });
      await settle();
      const geometry = await panel.evaluate(el => {
        const box = el.getBoundingClientRect();
        const workspace = el.parentElement.getBoundingClientRect();
        const topbar = document.querySelector('.app-topbar').getBoundingClientRect();
        const close = el.querySelector('.library-return-canvas').getBoundingClientRect();
        return { seam: box.top - topbar.bottom, left: box.left - workspace.left,
          right: workspace.right - box.right, bottom: workspace.bottom - box.bottom,
          closeTop: close.top - box.top, closeRight: box.right - close.right,
          radius: getComputedStyle(el).borderRadius, overflow: el.scrollWidth > el.clientWidth };
      });
      assert.equal(geometry.seam, 0, 'drawer meets the real app toolbar without a decorative gap');
      assert.equal(geometry.left, 0);
      assert.ok(geometry.right >= 12 && geometry.right <= 24 && geometry.bottom >= 12 && geometry.bottom <= 24);
      assert.equal(geometry.closeTop, 0);
      assert.ok(geometry.closeRight >= 0 && geometry.closeRight <= 1, 'close button is attached to the top right corner');
      assert.equal(geometry.radius, '0px 0px 22px');
      assert.equal(geometry.overflow, false);
      await frostVisible(true);
      await page.screenshot({ path: `.tmp/library-drawer/${theme}-${width}.png` });
    }
  }
  await panel.getByRole('tab', { name: '文件浏览器', exact: true }).click();
  await page.locator('.app-topbar .folder-navigation').waitFor();
  await panel.getByRole('button', { name: '返回画板', exact: true }).click();
  await settle();
  await frostVisible(false);
  assert.equal(await page.getByRole('button', { name: '展开画板素材库', exact: true }).evaluate(el => el === document.activeElement), true);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.locator('.app-sidebar-host.is-auto-hidden').waitFor({ state: 'attached' });
  await page.locator('.app-sidebar-host').evaluate(async el => {
    await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
  });
  assert.deepEqual(await page.locator('.canvas-stage').boundingBox(), stageBefore, 'drawer toggles do not resize the canvas');
  await page.getByRole('button', { name: '展开画板素材库', exact: true }).click();
  await settle();
  await panel.getByRole('tab', { name: '全局素材', exact: true }).click();
  await panel.getByRole('button', { name: '更多文件操作', exact: true }).click();
  await panel.getByRole('button', { name: '历史素材', exact: true }).click();
  await panel.locator('[data-asset-id="a"]').waitFor();
  await settle();
  const card = await panel.locator('[data-asset-id="a"]').boundingBox();
  await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
  await page.mouse.down();
  await page.mouse.move(card.x + card.width / 2 + 30, card.y + card.height / 2 + 30, { steps: 5 });
  await page.locator('.canvas-workspace.is-source-collapsed').waitFor();
  await frostVisible(false);
  assert.equal(await panel.evaluate(el => getComputedStyle(el).visibility), 'hidden');
  assert.equal(await page.locator('.canvas-board-shell').evaluate(el => el.inert), false);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.deepEqual(errors, []);
  console.log('PASS toolbar seam, corner close, light/dark 1400/900, edge frost, file address portal, focus return, unchanged canvas geometry, immediate drag reveal');
} finally { await browser.close(); await server.close(); }
