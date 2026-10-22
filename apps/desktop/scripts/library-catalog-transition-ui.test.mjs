import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/catalog-transition/vite', server: { host: '127.0.0.1', port: 17881, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
await mkdir('.tmp/catalog-transition', { recursive: true });
try {
  for (const scene of ['home', 'project']) {
    const fixture = scene === 'home' ? 'project-drop/preview.html?layout' : 'canvas-reference/preview.html?source-library';
    await page.goto(`http://127.0.0.1:17881/scripts/fixtures/${fixture}`);
    if (scene === 'project') {
      await page.waitForFunction(() => document.querySelector('.canvas-workspace')?.getAttribute('aria-busy') === 'false');
      await page.locator('.canvas-stage').focus(); await page.keyboard.press('Tab');
    }
    await page.getByRole('region', { name: '按标签浏览素材', exact: true }).waitFor();
    await page.evaluate(async () => {
      window.catalogMode = (await import('/src/lib/localFileMode.ts')).useLocalFileMode;
      const previous = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
        if (command === 'material_catalog' || command === 'material_catalog_assets') {
          await new Promise(resolve => setTimeout(resolve, 100));
          if (command === 'material_catalog') return { tags: [], collections: [{ id: 'motion-collection', name: '动效测试集合', parent_id: null, kind: 'collection' }], prompts: [], tag_asset_ids: {} };
          return [{ id: 'motion-asset', name: '示意图片.png', ext: 'png', source: 'imported', width: 240, height: 160,
            store_path: '/test.png', thumb_path: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="#8fa6ad"/></svg>') }];
        }
        return previous(command, args);
      };
      window.catalogMode.getState().openBrowser();
    });
    await page.evaluate(() => window.catalogMode.getState().closeBrowser());
    await page.getByRole('button', { name: '示意图片.png', exact: true }).waitFor();
    const record = await page.evaluate(() => new Promise(resolve => {
      const before = document.querySelector('.categorized-library');
      const samples = [], started = performance.now(); let sawWipe = false, coverage = false, firstVisible = null;
      window.catalogMode.getState().toggleCatalog();
      function frame() {
        const wipe = document.querySelector('.catalog-view-wipe');
        if (wipe) {
          sawWipe = true;
          const time = performance.now() - started;
          const text = [...wipe.querySelectorAll('.catalog-wipe-text')];
          const outgoing = document.querySelector('[data-outgoing]');
          const ready = !outgoing;
          if (ready && firstVisible === null) {
            firstVisible = time;
            const { width, height } = wipe.viewBox.baseVal;
            const paths = [...wipe.querySelectorAll('.catalog-wipe-body')];
            coverage = Array.from({ length: 400 }, (_, i) => new DOMPoint((i % 20 + .5) * width / 20, (Math.floor(i / 20) + .5) * height / 20))
              .every(point => paths.some(path => path.isPointInFill(point.matrixTransform(path.getCTM().inverse()))));
          }
          samples.push({ time, ready, oldConnected: before.isConnected, inert: outgoing?.inert,
            positions: text.map(el => { const m = el.getCTM(); return [m.e, m.f]; }) });
        } else if (sawWipe) { resolve({ samples, firstVisible, coverage, duration: performance.now() - started }); return; }
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    }));
    assert.ok(record.samples.length > 8, `${scene}: actual rendered animation frames`);
    assert.ok(record.samples.some(sample => !sample.ready && sample.oldConnected && sample.inert), `${scene}: outgoing view retained and inert`);
    assert.ok(record.coverage, `${scene}: every sampled point is covered when outgoing view is removed`);
    assert.ok(record.firstVisible >= 200 && record.firstVisible < 360, `${scene}: view swaps under full cover`);
    assert.ok(record.duration >= 590 && record.duration < 850, `${scene}: 600ms animation, observed ${record.duration}`);
    for (let i = 1; i < record.samples.length; i++) {
      record.samples[i].positions.forEach(([x, y], row) => {
        const [previousX, previousY] = record.samples[i - 1].positions[row];
        assert.ok(x >= previousX - .01 && y <= previousY + .01, `${scene}: text never reverses`);
      });
    }
    assert.equal(await page.locator('.categorized-library').count(), 1);
    await page.getByRole('treeitem', { name: '动效测试集合', exact: true }).waitFor();
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; window.catalogMode.getState().toggleCatalog(); }, theme);
      await page.waitForTimeout(280);
      const typography = await page.locator('.catalog-wipe-text').first().evaluate(el => {
        const [a, b] = el.children, m = el.getCTM();
        return { label: a.textContent, weight: getComputedStyle(el).fontWeight, fill: getComputedStyle(el).fill,
          ratio: (b.x.baseVal[0].value - a.x.baseVal[0].value) / a.getComputedTextLength(), slope: m.b / m.a };
      });
      assert.match(typography.label, /^切换至(全部|标签|集合)视图$/);
      assert.equal(typography.weight, '300'); assert.equal(typography.fill, 'rgb(255, 255, 255)');
      assert.ok(Math.abs(typography.ratio - 2) < .001);
      assert.ok(Math.abs(typography.slope + Math.tan(22 * Math.PI / 180)) < .001);
      assert.equal(await page.locator('.catalog-wipe-cap').count(), 24);
      await page.screenshot({ path: `.tmp/catalog-transition/${scene}-${theme}.png` });
      await page.locator('.catalog-view-wipe').waitFor({ state: 'detached' });
    }
    if (scene === 'project') {
      await page.evaluate(() => window.catalogMode.getState().toggleCatalog());
      await page.waitForTimeout(80);
      await page.locator('.canvas-source-panel').evaluate(el => el.style.width = '430px');
      await page.waitForTimeout(80);
      const bounds = await page.locator('.catalog-view-wipe').evaluate(el => {
        const a = el.getBoundingClientRect(), b = el.closest('.canvas-source-panel').getBoundingClientRect();
        const board = document.querySelector('.canvas-stage').getBoundingClientRect();
        const hit = document.elementFromPoint(board.right - 30, board.top + board.height / 2);
        return { contained: a.left >= b.left && a.right <= b.right + 1, width: a.width, viewWidth: el.viewBox.baseVal.width, canvasUsable: !el.closest('.canvas-source-panel').contains(hit) };
      });
      assert.ok(bounds.contained && bounds.canvasUsable);
      assert.ok(Math.abs(bounds.width - bounds.viewWidth) < 1);
      await page.locator('.catalog-view-wipe').waitFor({ state: 'detached' });
      await page.locator('.canvas-source-panel').evaluate(el => el.style.removeProperty('width'));
    }
    await page.evaluate(async () => {
      for (let i = 0; i < 5; i++) { window.catalogMode.getState().toggleCatalog(); await new Promise(resolve => setTimeout(resolve, 65)); }
    });
    await page.locator('.catalog-view-wipe').waitFor({ state: 'detached' });
    const finalKind = await page.evaluate(() => window.catalogMode.getState().mode);
    assert.equal(await page.locator('.categorized-library').count(), 1);
    assert.equal(await page.locator('.categorized-library').getAttribute('aria-label'), finalKind === 'all' ? '平铺浏览全部图片' : finalKind === 'tags' ? '按标签浏览素材' : '按集合浏览素材');
    await page.evaluate(() => window.catalogMode.getState().toggleCatalog());
    await page.waitForTimeout(50);
    await page.evaluate(() => window.catalogMode.getState().openBrowser());
    await page.locator('.catalog-view-wipe').waitFor({ state: 'detached' });
    await page.evaluate(() => window.catalogMode.getState().closeBrowser());
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => window.catalogMode.getState().toggleCatalog());
    await page.waitForTimeout(50);
    assert.equal(await page.locator('.catalog-view-wipe').count(), 0);
    assert.equal(await page.locator('.categorized-library').count(), 1);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  }
  assert.deepEqual(errors, []);
  console.log('PASS: 600ms catalog wipe, covered handoff, white thin tape text, forward motion, resizing, rapid toggles, cancellation, reduced motion, both surfaces and themes');
} finally { await browser.close(); await server.close(); }
