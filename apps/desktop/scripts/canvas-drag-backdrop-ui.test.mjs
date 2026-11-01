import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: '.tmp/canvas-drag-backdrop/vite',
  css: { postcss: { plugins: [] } }, esbuild: { jsx: 'automatic' },
  optimizeDeps: { entries: ['scripts/fixtures/canvas-drag-out/bridge.html'], include: ['react', 'react-dom/client', 'react/jsx-runtime'] },
  server: { host: '127.0.0.1', port: 17906, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const reports = [];
const errors = [];
const remote = [];
const overlay = page => page.locator('body > .external-drag-backdrop');
const calls = page => page.evaluate(() => window.nativeCalls());
const finish = async (page, dropped = false) => {
  await page.evaluate(dropped => window.resolveDrag({ dropped }), dropped);
  await page.waitForFunction(() => window.payload() === null);
  assert.equal(await overlay(page).count(), 0);
};
async function scenario(name, test) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.setDefaultTimeout(2500);
  page.on('pageerror', error => errors.push({ name, message: error.message }));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue();
    remote.push(route.request().url()); return route.abort();
  });
  try {
    await page.goto('http://127.0.0.1:17906/scripts/fixtures/canvas-drag-out/bridge.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.ready && window.browserVisible() === true);
    await test(page);
    reports.push({ name, passed: true });
  } catch (error) {
    const state = await page.evaluate(() => ({ calls: window.calls, finished: window.finished,
      payload: window.payload?.(), backdrop: !!document.querySelector('.external-drag-backdrop') })).catch(() => null);
    reports.push({ name, passed: false, error: error.stack || String(error), state });
  } finally { await page.close(); }
}

try {
  await mkdir('.tmp/canvas-drag-backdrop', { recursive: true });
  await scenario('canvas paints the full-window backdrop for two frames before native start', async page => {
    const now = new Date(); await page.clock.install({ time: now }); await page.clock.pauseAt(now);
    const before = await page.locator('#fixed-reference').boundingBox();
    await page.evaluate(() => { window.pauseFrames(); window.begin(); });
    assert.equal(await overlay(page).count(), 1, 'canvas trigger adds a body-owned backdrop');
    assert.equal((await calls(page)).length, 0, 'native start waits for paint');
    const css = await overlay(page).evaluate(element => {
      const style = getComputedStyle(element);
      return { position: style.position, pointerEvents: style.pointerEvents, filter: style.backdropFilter,
        rootFilter: getComputedStyle(document.getElementById('root')).filter, z: Number(style.zIndex),
        rect: { x: element.getBoundingClientRect().x, y: element.getBoundingClientRect().y,
          width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height } };
    });
    assert.equal(css.position, 'fixed'); assert.equal(css.pointerEvents, 'none'); assert.equal(css.filter, 'blur(6px)');
    assert.equal(css.rootFilter, 'none'); assert.ok(css.z > 1500);
    assert.deepEqual(css.rect, { x: 0, y: 0, width: 1200, height: 800 });
    assert.deepEqual(await page.locator('#fixed-reference').boundingBox(), before, 'fixed coordinates do not move');
    await page.evaluate(() => window.stepFrame());
    assert.equal((await calls(page)).length, 0, 'one frame is insufficient');
    await page.evaluate(() => window.stepFrame());
    await page.waitForFunction(() => window.nativeCalls().length === 1);
    await page.evaluate(() => window.restoreFrames());
    await finish(page);
  });

  await scenario('canvas rejects internal drops, preserves native blur, and restores the child browser', async page => {
    await page.evaluate(() => window.begin());
    await page.waitForFunction(() => window.nativeCalls().length === 1);
    assert.equal(await overlay(page).count(), 1);
    await page.waitForFunction(() => window.browserVisible() === false);
    assert.deepEqual(await page.evaluate(() => window.fireInternalDrop()), { effect: 'none', prevented: true, count: 0 });
    await page.evaluate(() => { window.nativePhase = 'started'; window.dispatchEvent(new Event('blur')); });
    await page.waitForFunction(() => window.cancelCalls().length === 1);
    assert.equal(await overlay(page).count(), 1, 'target activation must not clear an already started drag');
    await finish(page, true);
    await page.waitForFunction(() => window.browserVisible() === true);
    assert.equal(await page.evaluate(() => window.ended), 1);
    assert.equal(await page.evaluate(() => window.fireInternalDrop().count), 1, 'terminal cleanup removes the drop interceptor');
  });

  for (const reason of ['blur', 'escape', 'abort']) {
    await scenario(`pending ${reason} acknowledgement restores visuals while retaining the native payload lock`, async page => {
      await page.evaluate(() => window.begin());
      await page.waitForFunction(() => window.nativeCalls().length === 1);
      assert.equal(await overlay(page).count(), 1);
      await page.evaluate(reason => {
        if (reason === 'abort') window.abort();
        else if (reason === 'escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        else window.dispatchEvent(new Event('blur'));
      }, reason);
      await page.waitForFunction(() => window.cancelCalls().length === 1);
      await page.waitForFunction(() => !document.querySelector('.external-drag-backdrop'));
      assert.deepEqual(await page.evaluate(() => window.payload()), ['image', 'video']);
      assert.equal(await page.evaluate(() => window.ended), 0, 'slow resolver still owns the in-flight session');
      await page.evaluate(() => window.begin());
      assert.equal((await calls(page)).length, 1, 'a cancelled but unfinished native request keeps the session lock');
      await finish(page);
      const before = await page.evaluate(() => window.cancelCalls().length);
      await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new MouseEvent('mouseup')); });
      assert.equal(await page.evaluate(() => window.cancelCalls().length), before, 'terminal cleanup removes listeners');
    });
  }

  await scenario('abort during paint finishes without ever invoking native drag', async page => {
    await page.evaluate(() => { window.pauseFrames(); window.begin(); window.abort(); });
    await page.waitForFunction(() => window.finished === 1);
    assert.equal((await calls(page)).length, 0);
    assert.equal(await overlay(page).count(), 0);
    assert.equal(await page.evaluate(() => window.payload()), null);
    await page.evaluate(() => window.restoreFrames());
  });

  await scenario('an already aborted intent creates no native operation or backdrop', async page => {
    await page.evaluate(() => window.begin('canvas', true));
    await page.waitForFunction(() => window.finished === 1);
    assert.equal((await calls(page)).length, 0);
    assert.equal(await overlay(page).count(), 0);
  });

  await scenario('suppressed animation frames cancel instead of starting before the backdrop can paint', async page => {
    await page.evaluate(() => { window.pauseFrames(); window.begin(); });
    await page.waitForFunction(() => window.finished === 1, null, { timeout: 1200, polling: 20 });
    assert.equal((await calls(page)).length, 0);
    assert.equal(await overlay(page).count(), 0);
    assert.equal(await page.evaluate(() => window.payload()), null);
    await page.evaluate(() => window.restoreFrames());
  });

  await scenario('acknowledged preparation cancellation suppresses a late resolver error', async page => {
    await page.evaluate(() => window.begin());
    await page.waitForFunction(() => window.nativeCalls().length === 1);
    await page.evaluate(() => window.abort());
    await page.waitForFunction(() => !document.querySelector('.external-drag-backdrop'));
    await page.evaluate(() => window.rejectDrag('部分原文件不可用，请重新定位后再拖出'));
    await page.waitForFunction(() => window.payload() === null);
    assert.deepEqual(await page.evaluate(() => window.notices), []);
  });

  await scenario('acknowledged cancellation stops consuming Escape while a slow resolver finishes', async page => {
    await page.evaluate(() => window.begin());
    await page.waitForFunction(() => window.nativeCalls().length === 1);
    await page.evaluate(() => window.abort());
    await page.waitForFunction(() => !document.querySelector('.external-drag-backdrop'));
    const delivered = await page.evaluate(() => {
      let count = 0;
      const key = () => count++;
      window.addEventListener('keydown', key);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      window.removeEventListener('keydown', key);
      return count;
    });
    assert.equal(delivered, 1, 'restored menus may handle Escape');
    await finish(page);
  });

  await scenario('native errors remain visible after target activation rejects pending cancellation', async page => {
    await page.evaluate(() => window.begin());
    await page.waitForFunction(() => window.nativeCalls().length === 1);
    await page.evaluate(() => { window.nativePhase = 'started'; window.dispatchEvent(new Event('blur')); });
    await page.waitForFunction(() => window.cancelCalls().length === 1);
    await page.evaluate(() => window.rejectDrag('native_failure C:/private/path'));
    await page.waitForFunction(() => window.payload() === null);
    assert.deepEqual(await page.evaluate(() => window.notices.map(notice => notice.message)), ['无法拖出素材，请重试']);
    assert.equal(await overlay(page).count(), 0);
  });

  await scenario('a late old cancellation acknowledgement cannot clear a newer canvas drag', async page => {
    await page.evaluate(() => { window.deferCancelAck = true; window.begin(); });
    await page.waitForFunction(() => window.nativeCalls().length === 1);
    await page.evaluate(() => window.abort());
    await page.waitForFunction(() => window.cancelCalls().length === 1);
    await finish(page);
    await page.evaluate(() => { window.nativePhase = 'preparing'; window.begin(); });
    await page.waitForFunction(() => window.nativeCalls().length === 2);
    await page.evaluate(() => window.resolveCancel());
    assert.equal(await overlay(page).count(), 1);
    assert.deepEqual(await page.evaluate(() => window.fireInternalDrop()), { effect: 'none', prevented: true, count: 0 });
    await finish(page);
  });

  await scenario('native startup failure cleans the backdrop and preserves error presentation', async page => {
    await page.evaluate(() => window.begin());
    await page.waitForFunction(() => window.nativeCalls().length === 1);
    assert.equal(await overlay(page).count(), 1);
    await page.evaluate(() => window.rejectDrag('native_failure C:/private/path'));
    await page.waitForFunction(() => window.payload() === null);
    assert.equal(await overlay(page).count(), 0);
    assert.deepEqual(await page.evaluate(() => window.notices.map(notice => notice.message)), ['无法拖出素材，请重试']);
    await page.waitForFunction(() => window.browserVisible() === true);
  });

  await scenario('library source keeps immediate native start and internal copy delivery', async page => {
    await page.evaluate(() => { window.pauseFrames(); window.begin('library'); });
    assert.equal((await calls(page)).length, 1);
    assert.equal(await overlay(page).count(), 0);
    assert.deepEqual(await page.evaluate(() => window.fireInternalDrop()), { effect: 'copy', prevented: true, count: 1 });
    assert.deepEqual(await page.evaluate(() => window.drops), [['image', 'video']]);
    await finish(page);
    await page.evaluate(() => window.restoreFrames());
  });

  for (const theme of ['light', 'dark']) {
    await scenario(`${theme} formal bridge visual evidence`, async page => {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await page.screenshot({ path: `.tmp/canvas-drag-backdrop/${theme}-clear.png` });
      await page.evaluate(() => window.begin());
      await page.waitForFunction(() => window.nativeCalls().length === 1 && window.browserVisible() === false);
      assert.equal(await overlay(page).evaluate(element => getComputedStyle(element).backdropFilter), 'blur(6px)');
      await page.screenshot({ path: `.tmp/canvas-drag-backdrop/${theme}-blur.png` });
      await finish(page);
    });
  }

  await writeFile('.tmp/canvas-drag-backdrop/result.json', JSON.stringify({ reports, errors, remote, boundary: 'Real frontend bridge and SourceBrowserPanel with controlled native IPC; no OS acceptance claim.' }, null, 2));
  for (const report of reports) console.log(`${report.passed ? 'PASS' : 'FAIL'} ${report.name}${report.error ? `: ${report.error}` : ''}`);
  assert.deepEqual(errors, []); assert.deepEqual(remote, []);
  assert.equal(reports.filter(report => !report.passed).length, 0, 'outgoing canvas drag backdrop behavior');
} finally { await browser.close(); await server.close(); }
