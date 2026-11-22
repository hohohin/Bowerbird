import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const output = '.tmp/material-catalog';
await mkdir(output, { recursive: true });
const server = await createServer({ cacheDir: `${output}/vite`, server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 840 }, reducedMotion: 'reduce' });
page.setDefaultNavigationTimeout(60000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
const source = key => page.getByRole('tablist', { name: '素材库来源' }).locator(`[data-tab-value="${key}"]`);
const tags = page.getByRole('complementary', { name: '标签分类' });
const search = page.getByRole('searchbox', { name: '搜索素材' });
const scroller = page.locator('.catalog-scroller');
const card = id => page.locator(`[data-asset-id="${id}"]`);

async function assertScopedSearch(projectId) {
  await page.getByRole('button', { name: '搜索素材', exact: true }).click();
  await search.fill('small');
  await page.waitForFunction(projectId => window.requests.some(({ command, args }) => command === 'catalog_page'
    && args.filter.kind === 'all' && args.filter.query === 'small' && args.filter.projectId === projectId), projectId);
  await card('asset-0').waitFor();
  assert.equal(await tags.isVisible(), false);
  assert.equal(await page.locator('.catalog-section-heading').count(), 0);
  assert.equal(await page.getByRole('tab', { name: '标签', selected: true }).count(), 1);
}

try {
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/catalog-paging/preview.html?navigation&home`);
  await page.getByRole('tab', { name: '标签', exact: true }).click();
  await tags.getByRole('button', { name: /Z 末尾/ }).click();
  await card('asset-299940').waitFor();
  const originalTop = await scroller.evaluate(el => el.scrollTop);
  assert.ok(originalTop > 0);
  await assertScopedSearch(null);
  assert.equal(await card('asset-299940').count(), 0);
  await search.fill('slow');
  await search.fill('empty');
  await page.getByText('没有匹配的素材。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '清空搜索' }).click();
  await tags.waitFor();
  await card('asset-299940').waitFor();
  await page.waitForFunction(top => Math.abs(document.querySelector('.catalog-scroller').scrollTop - top) < 2, originalTop);
  await search.press('Escape');
  const resize = page.getByRole('separator', { name: '调整标签侧栏宽度' });
  const before = Number(await resize.getAttribute('aria-valuenow'));
  await resize.press('ArrowRight');
  await page.waitForFunction(before => Number(document.querySelector('.catalog-sidebar-resize').getAttribute('aria-valuenow')) > before, before);
  const resized = await resize.getAttribute('aria-valuenow');
  await source('project').click();
  await page.getByRole('button', { name: '查看项目素材 项目A' }).click();
  await tags.waitFor();
  assert.equal(await resize.getAttribute('aria-valuenow'), resized);
  await assertScopedSearch('p');
  await page.getByRole('button', { name: '清空搜索' }).click();
  await tags.waitFor();
  await search.press('Escape');
  assert.ok(await page.evaluate(() => window.maxInFlight <= 3));
  assert.ok(await page.locator('.catalog-asset-card, [data-asset-id]').count() < 180);
  await page.screenshot({ path: `${output}/project-tags.png` });
  assert.deepEqual(errors, []);
  console.log('PASS 300k catalog tag jump, bounded rendering, scoped flat search, stale results, clear restores position, and remembered sidebar width');
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await server.close();
}
