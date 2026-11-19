import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ server: { host: '127.0.0.1', port: 17935, strictPort: false, hmr: false, watch: null }, cacheDir: '.tmp/library-pane-actions-vite' });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
page.setDefaultTimeout(10000);
const errors = [];
page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
const ids = () => page.locator('[data-library-pane]').evaluateAll(elements => elements.map(el => el.dataset.libraryPane));
const pane = id => page.locator(`[data-library-pane="${id}"]`);
async function checkControls() {
  const split = await page.locator('[data-library-pane]').count() > 1;
  for (const host of await page.locator('[data-library-pane]').all()) {
    const rect = await host.boundingBox();
    const add = await host.getByRole('button', { name: split ? '关闭此栏' : '向右分栏', exact: true }).boundingBox();
    assert.ok(Math.abs(rect.x + rect.width - add.x - add.width - (split ? 16 : 8)) < 2);
    assert.ok(Math.abs(add.y - rect.y - 12) < 2);
    assert.equal(await host.locator('.library-controls-host').getByRole('button', { name: '向右分栏', exact: true }).count(), 0);
    if (split) assert.equal(await host.getByRole('button', { name: '向右分栏', exact: true }).count(), 0);
  }
  for (const boundary of await page.locator('.library-split-boundary').all()) {
    const rect = await boundary.boundingBox();
    const button = boundary.getByRole('button');
    const add = await button.boundingBox();
    assert.ok(Math.abs(rect.x + rect.width / 2 - add.x - add.width / 2) < 1, 'split icon must straddle the boundary equally');
    assert.equal(await button.locator('.lucide-columns2').count(), 1);
    const bothHalves = await button.evaluate(button => {
      const r = button.getBoundingClientRect();
      return [.25, .75].every(fraction => document.elementFromPoint(r.left + r.width * fraction, r.top + r.height / 2)?.closest('button') === button);
    });
    assert.ok(bothHalves, 'both halves of the split button must be clickable');
    const previousClose = await boundary.locator('xpath=preceding-sibling::*[@class="library-split-pane"][1]').locator('.library-pane-close').evaluate(element => element.getBoundingClientRect().right);
    assert.ok(previousClose < add.x, 'close and split click targets must not overlap');
  }
}
try {
  await mkdir('.tmp/library-pane-actions', { recursive: true });
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/library-pane-actions/preview.html${process.argv.includes('--preview') ? '' : '?live'}`);
  await page.locator('[data-asset-id]').first().waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-asset-id] img')].filter(img => img.complete && img.naturalWidth).length >= 8);
  assert.equal(await page.getByRole('button', { name: '关闭此栏', exact: true }).count(), 0);
  await checkControls();
  await page.screenshot({ path: '.tmp/library-pane-actions/single-dark.png' });
  await page.getByRole('button', { name: '向右分栏', exact: true }).click();
  assert.deepEqual(await ids(), ['home-left', 'home-pane-1']);
  await checkControls();
  await page.screenshot({ path: '.tmp/library-pane-actions/two-dark.png' });
  await page.getByRole('button', { name: '在第 1、2 栏之间分栏', exact: true }).click();
  assert.deepEqual(await ids(), ['home-left', 'home-pane-2', 'home-pane-1']);
  await checkControls();
  await page.screenshot({ path: '.tmp/library-pane-actions/three-dark.png' });
  await page.getByRole('button', { name: '在第 2、3 栏之间分栏', exact: true }).focus();
  await page.keyboard.press('Enter');
  assert.deepEqual(await ids(), ['home-left', 'home-pane-2', 'home-pane-3', 'home-pane-1']);
  await pane('home-pane-3').getByRole('button', { name: '关闭此栏', exact: true }).click();
  await pane('home-pane-2').getByRole('button', { name: '关闭此栏', exact: true }).click();
  await pane('home-left').getByRole('button', { name: '关闭此栏', exact: true }).click();
  assert.deepEqual(await ids(), ['home-pane-1']);
  assert.equal(await page.getByRole('button', { name: '关闭此栏', exact: true }).count(), 0);
  await page.getByRole('button', { name: '向右分栏', exact: true }).focus();
  await page.keyboard.press('Enter');
  assert.deepEqual(await ids(), ['home-pane-1', 'home-pane-4']);
  const divider = page.getByRole('separator');
  await divider.focus(); await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => Number(document.querySelector('[role="separator"]')?.getAttribute('aria-valuenow')) > 50);
  assert.ok(Number(await divider.getAttribute('aria-valuenow')) > 50);
  await page.keyboard.press('Home');
  const dividerBox = await divider.boundingBox();
  await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + 100);
  await page.mouse.down(); await page.mouse.move(dividerBox.x + dividerBox.width / 2 + 40, dividerBox.y + 100); await page.mouse.up();
  await page.waitForFunction(() => Number(document.querySelector('[role="separator"]')?.getAttribute('aria-valuenow')) > 50);
  assert.ok(Number(await divider.getAttribute('aria-valuenow')) > 50);
  await divider.dblclick({ position: { x: 3, y: 120 } });
  await page.setViewportSize({ width: 900, height: 700 });
  await checkControls();
  await page.screenshot({ path: '.tmp/library-pane-actions/two-narrow-dark.png' });
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');
  await checkControls();
  await page.screenshot({ path: '.tmp/library-pane-actions/two-narrow-light.png' });
  for (const name of ['标签分类', '文件夹', '全部']) {
    for (const host of await page.locator('[data-library-pane]').all()) await host.getByRole('tab', { name, exact: true }).click();
    await checkControls();
    await page.screenshot({ path: `.tmp/library-pane-actions/narrow-${name}.png` });
    const blocked = await page.locator('.file-view-heading button').evaluateAll(buttons => buttons.filter(button => {
      const rect = button.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.right <= 0 || rect.left >= innerWidth || button.closest('[aria-hidden="true"]')) return false;
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit?.closest('button') !== button;
    }).map(button => button.getAttribute('aria-label') || button.textContent));
    assert.deepEqual(blocked, [], `${name}: controls must remain clickable`);
  }
  assert.deepEqual(errors, []);
  console.log('PASS single split control, centered boundary icon with two clickable halves, adjacent insertion, close-to-single restoration, keyboard/drag resizing and narrow themes');
} catch(error) { await page.screenshot({ path: '.tmp/library-pane-actions/failure.png' }); throw error; }
finally { await browser.close(); await server.close(); }
