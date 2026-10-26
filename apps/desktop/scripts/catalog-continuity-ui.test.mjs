import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/catalog-continuity/vite', server: { host: '127.0.0.1', port: 17931, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 960, height: 840 }, reducedMotion: 'reduce' });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
  window.total = 1320;
  const thumbnails = new Map();
  window.assetWithHeight = height => {
    if (!thumbnails.has(height)) thumbnails.set(height, 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="${height}"><rect width="240" height="${height}" fill="#7b9eaa"/></svg>`));
    return { width: 240, height, thumb_path: thumbnails.get(height) };
  };
  // The first portrait overlaps several later pages. Every later page also ends
  // with uneven column tails, so resetting columns at a page boundary is visible.
  window.assetDimensions = i => window.assetWithHeight(i === 59 ? 19200 : i % 60 === 59 ? 960 : 240);
});
const scroller = () => page.locator('.catalog-scroller');
async function settle() {
  // Wait for the scroll RAF, page responses and the layout update they trigger.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  let previous = -1;
  for (let attempt = 0; attempt < 20; attempt++) {
    await page.waitForFunction(() => window.inFlight === 0 && !document.querySelector('.catalog-virtual-page [role="status"]'));
    await page.waitForTimeout(40);
    const count = await page.evaluate(() => window.requests.length);
    if (count === previous) return;
    previous = count;
  }
  assert.fail('Catalog did not settle');
}
async function scrollTo(top) {
  await scroller().evaluate((el, value) => { el.scrollTop = value; }, top);
  await settle();
}
async function checkMounted(label, section = 'all', first = 0, count = 1320, headings = false) {
  const result = await page.evaluate(({ section, first, count, headings }) => {
    const viewport = document.querySelector('.catalog-scroller');
    const group = document.querySelector(`[data-catalog-section="${section}"]`);
    const target = window.store.getState().libraryThumbnailWidth;
    const columns = Math.max(1, Math.floor((viewport.clientWidth - 8) / (target + 8)));
    const width = (viewport.clientWidth - 16 - 8 * (columns - 1)) / columns;
    const tails = Array(columns).fill(headings ? 48 : 8);
    const expected = new Map();
    // Independent one-pass reference: deliberately has no page boundaries.
    for (let i = first; i < first + count; i++) {
      const dimensions = window.assetDimensions(i);
      const height = width / (dimensions.width / dimensions.height);
      let column = 0;
      for (let c = 1; c < columns; c++) if (tails[c] < tails[column] - 1e-7) column = c;
      expected.set(`asset-${i}`, { left: 8 + column * (width + 8), top: tails[column], width, height });
      tails[column] += height + 8;
    }
    const origin = group.getBoundingClientRect();
    const cards = [...group.querySelectorAll('[data-asset-id]')];
    const mismatches = cards.flatMap(card => {
      const wanted = expected.get(card.dataset.assetId);
      if (!wanted) return [{ id: card.dataset.assetId, error: 'asset belongs to another section' }];
      const rect = card.getBoundingClientRect();
      const actual = { left: rect.left - origin.left, top: rect.top - origin.top, width: rect.width, height: rect.height };
      return Object.keys(wanted).some(key => Math.abs(wanted[key] - actual[key]) > 0.5)
        ? [{ id: card.dataset.assetId, wanted, actual }] : [];
    });
    return { cards: cards.length, mismatches: mismatches.slice(0, 4), top: viewport.scrollTop, height: viewport.scrollHeight };
  }, { section, first, count, headings });
  assert.ok(result.cards > 0, `${label}: no mounted cards`);
  assert.deepEqual(result.mismatches, [], `${label}: ${JSON.stringify(result)}`);
  return result;
}

try {
  await mkdir('.tmp/catalog-continuity', { recursive: true });
  await page.goto('http://127.0.0.1:17931/scripts/fixtures/catalog-paging/preview.html');
  await page.locator('[data-asset-id="asset-0"]').waitFor();
  await settle();
  await checkMounted('initial');
  let inspected = 0;
  let sawLongPortraitBesideLaterPage = false;
  // Traverse continuously so all preceding dimensions are known when comparing
  // the real DOM with the complete one-pass layout, including offsets 60/120.
  for (let top = 0; ; top += 600) {
    await scrollTo(top);
    const state = await checkMounted(`continuous scroll ${top}`);
    inspected++;
    if (!sawLongPortraitBesideLaterPage) {
      sawLongPortraitBesideLaterPage = await page.evaluate(() => {
        const portrait = document.querySelector('[data-asset-id="asset-59"]');
        const later = document.querySelector('[data-catalog-page="all:3"] [data-asset-id]');
        const viewport = document.querySelector('.catalog-scroller').getBoundingClientRect();
        if (!portrait || !later) return false;
        const rect = portrait.getBoundingClientRect();
        return rect.top < viewport.bottom && rect.bottom > viewport.top;
      });
      if (sawLongPortraitBesideLaterPage) {
        const point = await page.evaluate(() => {
          const portrait = document.querySelector('[data-asset-id="asset-59"]').getBoundingClientRect();
          const viewport = document.querySelector('.catalog-scroller').getBoundingClientRect();
          const x = portrait.left + portrait.width / 2;
          const y = (Math.max(portrait.top, viewport.top + 80) + Math.min(portrait.bottom, viewport.bottom - 40)) / 2;
          return { x, y, hit: document.elementFromPoint(x, y)?.closest('[data-asset-id]')?.dataset.assetId };
        });
        assert.equal(point.hit, 'asset-59', 'Later page wrappers must not intercept the earlier portrait');
        await page.keyboard.down('Control');
        await page.mouse.click(point.x, point.y);
        await page.keyboard.up('Control');
        await page.waitForFunction(() => document.querySelector('[data-asset-id="asset-59"]')?.getAttribute('aria-pressed') === 'true');
        await page.getByRole('button', { name: '取消选择', exact: true }).click();
        await page.mouse.move(0, 0);
        await page.screenshot({ path: '.tmp/catalog-continuity/overlapping-pages.png' });
      }
    }
    if (state.top + 840 >= state.height - 1) break;
    assert.ok(inspected < 200, 'Continuous traversal did not reach the end');
  }
  assert.ok(sawLongPortraitBesideLaterPage, 'Early portrait must remain visible beside page 4');
  await page.locator('[data-asset-id="asset-1319"]').waitFor();
  assert.ok(Number(await page.locator('.catalog-virtual').getAttribute('data-cached-pages')) <= 16);
  const requestsBeforeReturn = await page.evaluate(() => window.requests.filter(r => r.command === 'catalog_page' && r.args.offset === 0).length);
  await scrollTo(0);
  await checkMounted('return after cache eviction');
  assert.ok(await page.evaluate(() => window.requests.filter(r => r.command === 'catalog_page' && r.args.offset === 0).length) > requestsBeforeReturn, 'First page should have been evicted and fetched again');
  await scrollTo(1800);
  await checkMounted('reloaded page boundary');
  await page.screenshot({ path: '.tmp/catalog-continuity/page-boundary.png' });

  // Geometry must be recomputed from retained ratios at a new column count.
  await page.setViewportSize({ width: 680, height: 840 });
  await settle();
  await checkMounted('narrow resize');
  await scrollTo(4200);
  await checkMounted('narrow later boundary');
  await page.screenshot({ path: '.tmp/catalog-continuity/narrow-boundary.png' });
  await page.setViewportSize({ width: 960, height: 840 });
  await settle();
  await checkMounted('wide resize');

  // A tag starts fresh columns; its first page must not inherit another tag's
  // portrait tails, even when jumping over pages that have never been fetched.
  await page.evaluate(() => window.changeKind('tags'));
  await settle();
  await page.locator('.catalog-tag-list').getByRole('button', { name: /Z 末尾/ }).first().click();
  await page.locator('[data-tag-section="last"] [data-asset-id="asset-1260"]').waitFor();
  await settle();
  await checkMounted('tag jump', 'last', 1260, 60, true);
  await page.screenshot({ path: '.tmp/catalog-continuity/tag-jump.png' });
  await page.locator('.catalog-tag-list').getByRole('button', { name: /A 素材/ }).first().click();
  await page.locator('[data-tag-section="first"] [data-asset-id="asset-0"]').waitFor();
  await settle();
  await checkMounted('return to first tag', 'first', 0, 1320, true);

  // Refresh a visible earlier page while its long portrait spans the current
  // row. Preserve the nearest visible short card, rather than the old page top.
  await page.evaluate(() => window.changeKind('all'));
  await settle();
  await scrollTo(4200);
  const anchor = await page.evaluate(() => {
    const view = document.querySelector('.catalog-scroller').getBoundingClientRect();
    const cards = [...document.querySelectorAll('[data-asset-id]')]
      .map(card => ({ id: card.dataset.assetId, rect: card.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom >= view.top && rect.top <= view.bottom)
      .sort((a, b) => Math.abs(a.rect.top - view.top) - Math.abs(b.rect.top - view.top));
    return { id: cards[0].id, top: cards[0].rect.top, scrollTop: document.querySelector('.catalog-scroller').scrollTop, requests: window.requests.length };
  });
  assert.notEqual(anchor.id, 'asset-59', 'Refresh anchor should be a nearby card, not the earlier long portrait');
  await page.evaluate(() => {
    const original = window.assetDimensions;
    window.assetDimensions = i => i === 0 ? window.assetWithHeight(1920) : original(i);
    window.delay = 120;
    window.refresh();
  });
  await page.waitForFunction(previous => window.requests.length > previous && window.inFlight > 0, anchor.requests);
  await settle();
  const refreshed = await page.evaluate(id => ({
    top: document.querySelector(`[data-asset-id="${id}"]`)?.getBoundingClientRect().top,
    scrollTop: document.querySelector('.catalog-scroller').scrollTop,
  }), anchor.id);
  assert.ok(Math.abs(refreshed.top - anchor.top) < 1.5, `Refresh moved visible anchor: ${JSON.stringify({ anchor, refreshed })}`);
  assert.ok(Math.abs(refreshed.scrollTop - anchor.scrollTop) > 1, 'The refreshed dimensions must actually change the preceding layout');
  await checkMounted('refreshed dimensions');
  await page.screenshot({ path: '.tmp/catalog-continuity/refresh-anchor.png' });
  assert.ok(await page.evaluate(() => window.maxInFlight) <= 3);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, inspected, sawLongPortraitBesideLaterPage, maxInFlight: await page.evaluate(() => window.maxInFlight) }));
} finally {
  await browser.close();
  await server.close();
}
