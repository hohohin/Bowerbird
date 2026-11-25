import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/explore-layout-vite', server: { host: '127.0.0.1', hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const tab = name => page.getByRole('navigation', { name: '首页', exact: true }).getByRole('button', { name, exact: true });
const native = page.locator('[data-source-browser-viewport]');
const middle = page.locator('.explore-home-content [data-explore-middle]');
const directory = page.locator('.explore-home-content [data-explore-directory]');
const grip = page.getByRole('separator', { name: '调整素材流宽度' });
const panel = page.getByRole('complementary', { name: '探索面板', exact: true });

async function openExplore() {
  const back = page.getByRole('button', { name: '返回主页', exact: true });
  await page.waitForFunction(() => document.querySelector('.home-page-navigation, .canvas-workspace[aria-busy="false"]'));
  if (await back.isVisible()) await back.click();
  const explore = tab('探索');
  if (await explore.getAttribute('aria-current') !== 'page') await explore.click();
  await page.waitForFunction(() => window.calls.filter(call => call.command === 'resize_source_browser').at(-1)?.args.visible);
}

const readMiddle = () => middle.evaluate(el => Math.round(el.getBoundingClientRect().width));

try {
  await page.goto(new URL('scripts/fixtures/home-navigation-live/preview.html?source-library&detail-route&canvas-library', server.resolvedUrls.local[0]).href);
  await openExplore();
  assert.equal(await readMiddle(), 360);
  const initial = await native.boundingBox();
  assert.ok(initial.width / 1440 >= .60 && initial.width / 1440 <= .65, 'the website gets 60–65% at the reference desktop width');
  assert.ok((await middle.boundingBox()).x >= (await directory.boundingBox()).width - 1);
  await grip.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await readMiddle(), 380);
  const box = await grip.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 66, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  assert.equal(await readMiddle(), 446);
  await page.waitForFunction(() => localStorage.getItem('bowerbird.explorer.middleWidth') === '446');

  await middle.getByRole('button', { name: '关闭素材流' }).click();
  await panel.getByRole('button', { name: '展开素材流' }).waitFor();
  assert.ok((await native.boundingBox()).width > initial.width + 350);
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === 'open_source_browser').length), 1);
  await panel.getByRole('button', { name: '展开素材流' }).click();
  assert.equal(await readMiddle(), 446);
  await page.reload();
  await openExplore();
  assert.equal(await readMiddle(), 446);
  await page.setViewportSize({ width: 900, height: 800 });
  await page.waitForFunction(() => document.querySelector('[data-source-browser-viewport]').getBoundingClientRect().width >= 319);
  assert.ok(await readMiddle() < 446);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => Math.round(document.querySelector('.explore-home-content [data-explore-middle]').getBoundingClientRect().width) === 446);
  await grip.dblclick();
  assert.equal(await readMiddle(), 360);

  await middle.getByRole('button', { name: '关闭素材流' }).click();
  await directory.getByRole('button', { name: '收起侧栏' }).click();
  const full = await native.boundingBox();
  assert.ok(full.x < 2 && full.width > 1438, 'closing both panes gives the site the full width');
  const drag = { id: '0123456789abcdef0123456789abcdef', imageUrl: 'https://img.example.org/collected.png', pageUrl: 'https://www.pinterest.com/', mediaKind: 'image' };
  await page.evaluate(payload => window.emitFixtureEvent('source-browser://drag', { ...payload, phase: 'start' }), drag);
  await directory.waitFor();
  assert.ok((await native.boundingBox()).x >= (await directory.boundingBox()).width - 1, 'the native viewport yields real space to the drop dock');
  const row = directory.getByRole('button', { name: '山野品牌 1', exact: true });
  await row.evaluate((element, payload) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('application/x-bowerbird-explorer', JSON.stringify({ version: 1, imageUrl: payload.imageUrl, pageUrl: payload.pageUrl, dragId: payload.id }));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientX: 55, clientY: 150 }));
  }, drag);
  await directory.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => window.calls.some(call => call.command === 'capture_source_browser_image' && call.args.projectId === 'p'));
  assert.equal(await page.evaluate(() => window.store.getState().activeProjectId), null);
  await page.evaluate(payload => window.emitFixtureEvent('source-browser://drag', { ...payload, phase: 'start' }), drag);
  await directory.waitFor();
  await page.evaluate(payload => window.emitFixtureEvent('source-browser://drag', { ...payload, phase: 'end' }), drag);
  await directory.waitFor({ state: 'hidden' });
  await page.reload();
  await openExplore();
  assert.equal(await directory.isVisible(), false);
  assert.equal(await panel.getByRole('button', { name: '展开素材流' }).isVisible(), true);
  await panel.getByRole('button', { name: '展开侧栏' }).click();
  await directory.waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS three-column Explore, independent width and visibility memory, fit on resize, and temporary full-width drop dock');
} finally {
  await browser.close();
  await server.close();
}
