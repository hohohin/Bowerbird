import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1589, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.setDefaultTimeout(10000);
await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const root = "http://127.0.0.1:1589/scripts/fixtures/";
const ids = scope => scope.locator('[data-asset-id]').evaluateAll(elements => elements.map(el => el.dataset.assetId).sort());
async function expectIds(scope, expected) {
  await page.waitForFunction(({ selector, expected }) => JSON.stringify([...document.querySelectorAll(`${selector} [data-asset-id]`)].map(el => el.dataset.assetId).sort()) === JSON.stringify(expected), { selector: scope, expected: [...expected].sort() });
}
try {
  // Main library: actual video path wins over the image poster, including project covers.
  await page.goto(root + "project-drop/preview.html?layout");
  await page.locator('[data-asset-id="one"]').waitFor();
  await page.evaluate(() => {
    const state = window.store.getState();
    state.setAssets(state.assets.map(asset => ["owned", "one"].includes(asset.id) ? { ...asset, store_path: `/fixtures/${asset.id}.MP4` } : asset));
    state.setSearchQuery("保留搜索");
  });
  const top = page.locator('.app-topbar');
  await top.getByRole('button', { name: '只看视频', exact: true }).click();
  await expectIds('.library-home', ['one', 'owned']);
  assert.equal(await page.locator('.library-project-folder').count(), 0);
  await page.evaluate(() => window.store.getState().selectAll());
  assert.deepEqual(await page.evaluate(() => [...window.store.getState().selectedIds].sort()), ['one', 'owned']);
  await top.getByRole('button', { name: '只看图片', exact: true }).click();
  await expectIds('.library-home', ['three', 'two']);
  assert.equal(await page.locator('.library-project-folder').count(), 0);
  assert.deepEqual(await page.evaluate(() => [window.store.getState().searchQuery, window.store.getState().selectedIds.size]), ['保留搜索', 0]);
  await top.getByRole('button', { name: '只看图片', exact: true }).click();
  await expectIds('.library-home', ['one', 'owned', 'three', 'two']);

  // Project and central sources share both media controls without changing their source.
  await page.addInitScript(() => {
    const poster = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="190" height="150"><rect width="190" height="150" fill="#64748b"/></svg>');
    sessionStorage.setItem('reference-drafts', JSON.stringify([
      { id: 'video', name: '视频素材', store_path: '/fixtures/clip.MP4', thumb_path: poster, width: 190, height: 150 },
      { id: 'generated-video', name: '生成视频', store_path: '/fixtures/generated.mp4', thumb_path: poster, width: 190, height: 150, generation_session_id: 'generated' },
    ]));
  });
  await page.goto(root + 'canvas-reference/preview.html?source-library');
  const panel = page.getByRole('complementary', { name: '画板素材库' });
  await page.getByRole('button', { name: '展开画板素材库', exact: true }).click();
  await panel.locator('[data-asset-id="existing"]').waitFor();
  await page.evaluate(() => window.store.getState().setTotal(7));
  assert.deepEqual((await panel.getByRole('tab').allTextContents()).map(text => text.trim()), ['项目素材', '全局素材']);
  for (const source of ['项目素材', '全局素材']) {
    await panel.getByRole('tab', { name: source }).click();
    await top.getByRole('button', { name: '只看视频', exact: true }).click();
    await expectIds('.canvas-source-panel', ['generated-video', 'video']);
    assert.equal(await top.getByRole('button', { name: '只看视频', exact: true }).getAttribute('aria-pressed'), 'true');
    await top.getByRole('button', { name: '只看生成图', exact: true }).click();
    await expectIds('.canvas-source-panel', ['generated-video']);
    await top.getByRole('button', { name: '不看生成图', exact: true }).click();
    await expectIds('.canvas-source-panel', ['video']);
    await top.getByRole('button', { name: '不看生成图', exact: true }).click();
    await top.getByRole('button', { name: '只看图片', exact: true }).click();
    await expectIds('.canvas-source-panel', ['a', 'b', 'c', 'd', 'existing']);
    assert.equal(await top.getByRole('button', { name: '只看图片', exact: true }).getAttribute('aria-pressed'), 'true');
    await top.getByRole('button', { name: '只看图片', exact: true }).click();
    assert.equal((await ids(panel)).length, 7);
  }
  await panel.getByRole('navigation', { name: '分类标签' }).getByRole('button', { name: '插画', exact: true }).click();
  await expectIds('.canvas-source-panel', ['existing']);
  await top.getByRole('button', { name: '只看视频', exact: true }).click();
  await panel.getByText('没有匹配的素材', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.store.getState().smartFilter), 'tag:插画');
  await panel.getByRole('button', { name: '清除筛选', exact: true }).click();
  await expectIds('.canvas-source-panel', ['a', 'b', 'c', 'd', 'existing', 'video', 'generated-video']);
  assert.equal(await top.getByRole('button', { name: '只看生成图', exact: true }).textContent(), '');
  assert.equal(await top.locator('.generated-filter-off > svg').count(), 2);

  await mkdir('.tmp/library-media-filter', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    for (const width of [900, 1100, 1400]) {
      await page.setViewportSize({ width, height: 800 });
      assert.equal(await panel.getByRole('group', { name: '素材类型筛选' }).count(), 0);
      assert.equal(await panel.getByRole('button', { name: '全部', exact: true }).count(), 0);
      assert.equal(await panel.evaluate(el => el.scrollWidth <= el.clientWidth), true);
      await page.screenshot({ path: `.tmp/library-media-filter/${theme}-${width}.png` });
    }
  }
  assert.deepEqual(errors, []);
  console.log('PASS: media filters, synchronized controls, project/central, generated/tag combinations, poster detection, selection, clear and narrow layout.');
} finally { await browser.close(); await server.close(); }
