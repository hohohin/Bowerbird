import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const evidence = '.tmp/explore-navigation';
await mkdir(evidence, { recursive: true });
const server = await createServer({ cacheDir: '.tmp/explore-navigation-vite', server: { host: '127.0.0.1', port: 1933, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [];
const disruptive = ['open_source_browser', 'hide_source_browser', 'navigate_source_browser', 'reload_source_browser', 'source_browser_back', 'source_browser_forward'];
const navigation = page => page.getByRole('navigation', { name: '首页', exact: true });
const homeButton = (page, name) => navigation(page).getByRole('button', { name, exact: true });
const panel = page => page.getByRole('complementary', { name: '探索面板', exact: true });
const canvasExplore = page => page.getByRole('button', { name: '侧边探索', exact: true });
const latestResize = page => page.waitForFunction(() => window.calls.filter(call => call.command === 'resize_source_browser').at(-1)?.args.visible === true);

async function openWorkspace(page, canvas = false, explore = true) {
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/home-navigation-live/preview.html?source-library&detail-route&canvas-library`);
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  if (!canvas) {
    await page.getByRole('button', { name: '返回主页', exact: true }).click();
    await page.getByRole('navigation', { name: '首页' }).getByRole('button', { name: '素材库', exact: true }).click();
    await page.locator('.library-home').waitFor();
  }
  if (!explore) return;
  if (canvas) await canvasExplore(page).click();
  else await homeButton(page, '探索').click();
  await page.waitForFunction(() => window.calls.some(call => call.command === 'open_source_browser'));
  await latestResize(page);
  await page.evaluate(() => {
    window.exploreOriginal = document.querySelector('[data-source-browser-viewport]');
    window.exploreCallsStart = window.calls.length;
  });
}

async function navigationLayout(page, name) {
  const nav = page.getByRole('navigation', { name: '首页' });
  for (const theme of ['dark', 'light']) for (const width of [900, 980, 1100, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.waitForTimeout(60);
    const geometry = await page.locator('.app-topbar').evaluate(element => {
      const nav = element.querySelector('.home-page-navigation').getBoundingClientRect();
      const boxes = [...element.querySelectorAll('button')].map(button => ({ ...button.getBoundingClientRect().toJSON(), label: button.getAttribute('aria-label') || button.textContent })).filter(box => box.width && box.height);
      return { centered: Math.abs(nav.x + nav.width / 2 - innerWidth / 2) < 1,
        overlap: boxes.flatMap((a, i) => boxes.slice(i + 1).filter(b => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top).map(b => [a.label, b.label, a.right - b.left])) };
    });
    assert.deepEqual(geometry, { centered: true, overlap: [] }, `${name} navigation fits ${width}px ${theme}`);
    for (const label of ['素材库', '项目', '探索']) {
      assert.equal(await nav.getByRole('button', { name: label, exact: true }).evaluate(element => {
        const rect = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      }), true, `${label} is unobstructed at ${width}px`);
    }
    if (width === 900 || width === 1440) await page.screenshot({ path: `${evidence}/${name}-${width}-${theme}.png` });
  }
}

async function unchangedBrowser(page, projectId = null, visible = true, allowHide = !visible) {
  if (visible) await latestResize(page);
  else await panel(page).waitFor({ state: 'hidden' });
  assert.equal(await panel(page).isVisible(), visible);
  assert.equal(await page.evaluate(() => window.exploreOriginal === document.querySelector('[data-source-browser-viewport]')), true, 'navigation preserves the same browser viewport');
  assert.deepEqual(await page.evaluate(commands => window.calls.slice(window.exploreCallsStart).filter(call => commands.includes(call.command)),
    allowHide ? disruptive.filter(command => command !== 'hide_source_browser') : disruptive), [], 'workspace transitions never recreate or navigate the browser');
  assert.equal(await page.evaluate(() => window.store.getState().activeProjectId), projectId, 'navigation preserves the expected capture destination');
}

const cases = {
  'asset-source-navigation': async page => {
    const source = 'https://www.pinterest.com/pin/123/';
    await page.evaluate(source => {
      const state = window.store.getState();
      const asset = state.assets.find(asset => asset.id === 'a');
      asset.source_url = source;
      state.openDetail(asset.id);
    }, source);
    const action = page.locator('.asset-detail').getByRole('button', { name: '发现更多', exact: true });
    await action.click();
    await page.waitForFunction(source => window.calls.some(call => call.command === 'open_source_browser' && call.args.url === source), source);
    assert.equal(await homeButton(page, '探索').getAttribute('aria-current'), 'page');
    await latestResize(page);
    await page.evaluate(() => {
      window.exploreCallsStart = window.calls.length;
      window.store.getState().openDetail('a');
    });
    for (const expectedCount of [1, 2]) {
      await action.click();
      await page.waitForFunction(({ source, expectedCount }) =>
        window.calls.slice(window.exploreCallsStart).filter(call =>
          call.command === 'navigate_source_browser' && call.args.url === source).length === expectedCount,
      { source, expectedCount });
    }
    const changes = await page.evaluate(commands => window.calls.slice(window.exploreCallsStart)
      .filter(call => commands.includes(call.command)).map(call => call.command), disruptive);
    assert.deepEqual(changes, ['navigate_source_browser', 'navigate_source_browser'],
      'an explicit source navigation uses the open WebView, even when the URL is repeated');
  },
  'canvas-asset-source-navigation': async page => {
    const source = 'https://www.pinterest.com/pin/456/';
    await page.evaluate(source => {
      const state = window.store.getState();
      const asset = state.assets.find(asset => asset.id === 'a');
      asset.source_url = source;
      state.openDetail(asset.id);
    }, source);
    await page.locator('.asset-detail').getByRole('button', { name: '发现更多', exact: true }).click();
    await page.waitForFunction(source => window.calls.some(call => call.command === 'open_source_browser' && call.args.url === source), source);
    await latestResize(page);
    assert.equal(await canvasExplore(page).getAttribute('aria-pressed'), 'true');
    assert.equal(await navigation(page).isVisible(), false);
    assert.equal(await page.evaluate(() => window.store.getState().activeProjectId), 'p');
  },
  'home-navigation': async page => {
    const nav = navigation(page);
    assert.equal(await nav.isVisible(), true, 'library/projects navigation remains visible while exploring');
    await homeButton(page, '探索').focus();
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.store.getState().libraryHomeView), 'explore');
    await unchangedBrowser(page);
    await nav.getByRole('button', { name: '项目', exact: true }).click();
    await page.getByRole('region', { name: '项目管理' }).waitFor();
    assert.equal(await page.evaluate(() => window.store.getState().libraryHomeView), 'projects');
    await unchangedBrowser(page, null, false);
    await nav.getByRole('button', { name: '素材库', exact: true }).click();
    await page.locator('.library-home').waitFor();
    assert.equal(await page.evaluate(() => window.store.getState().libraryHomeView), 'library');
    await unchangedBrowser(page, null, false);
    await homeButton(page, '探索').click();
    assert.equal(await homeButton(page, '探索').getAttribute('aria-current'), 'page');
    await unchangedBrowser(page, null, true, true);
    await navigationLayout(page, 'home');
  },
  'catalog-navigation': async page => {
    const sidebar = page.getByRole('complementary', { name: '素材库导航', exact: true });
    for (const label of ['层级模式', '标签模式', '全部素材']) {
      const button = sidebar.getByRole('button', { name: label, exact: true });
      await button.click();
      assert.equal(await button.getAttribute(label === '全部素材' ? 'aria-current' : 'aria-pressed'), 'true');
      await unchangedBrowser(page);
    }
    const project = sidebar.getByRole('button', { name: '山野品牌 1', exact: true });
    await project.click();
    assert.equal(await project.getAttribute('aria-current'), 'true');
    assert.equal(await homeButton(page, '探索').getAttribute('aria-current'), 'page');
    await unchangedBrowser(page);
  },
  'home-to-canvas': async page => {
    const sidebar = page.getByRole('complementary', { name: '素材库导航', exact: true });
    await sidebar.getByRole('button', { name: '山野品牌 1', exact: true }).dblclick();
    await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
    assert.equal(await navigation(page).isVisible(), false);
    assert.equal(await page.getByRole('button', { name: '打开素材库', exact: true }).getAttribute('aria-expanded'), 'false');
    await page.waitForFunction(() => {
      const viewport = document.querySelector('[data-source-browser-viewport]')?.getBoundingClientRect();
      const resize = window.calls.filter(call => call.command === 'resize_source_browser').at(-1)?.args;
      return viewport && resize?.visible && Math.abs(resize.bounds.x - viewport.x) < 1
        && Math.abs(resize.bounds.width - viewport.width) < 1;
    });
    await unchangedBrowser(page, 'p');
    assert.equal(await page.evaluate(() => window.calls.slice(window.exploreCallsStart)
      .some(call => call.command === 'resize_source_browser' && call.args.visible === false)), false, 'the canvas handoff only resizes a visible native browser');
    assert.equal(await canvasExplore(page).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: '打开素材库', exact: true }).click();
    await canvasExplore(page).focus();
    await page.keyboard.press('Escape');
    await panel(page).waitFor({ state: 'hidden' });
    await canvasExplore(page).click();
    assert.equal(await page.getByRole('button', { name: '收起素材库', exact: true }).getAttribute('aria-expanded'), 'true');
    assert.ok((await panel(page).boundingBox()).x > (await page.locator('.canvas-stage').boundingBox()).x, 'canvas exploration is to the right of the canvas');
    await unchangedBrowser(page, 'p', true, true);
    await page.evaluate(() => {
      const flush = window.store.getState().projectCanvasFlush;
      window.store.getState().registerProjectCanvasFlush(async () => {
        await new Promise(resolve => { window.releaseExploreFlush = () => {
          window.store.getState().registerProjectCanvasFlush(flush);
          resolve();
        }; });
        await flush?.();
      });
    });
    await page.getByRole('button', { name: '返回主页', exact: true }).click();
    await page.waitForFunction(() => !!window.releaseExploreFlush);
    await unchangedBrowser(page, 'p', true, true);
    assert.equal(await page.getByRole('region', { name: '项目管理' }).isVisible(), false, 'pending save does not leave the project early');
    await page.evaluate(() => window.releaseExploreFlush());
    await page.getByRole('region', { name: '项目管理' }).waitFor();
    assert.equal(await page.evaluate(() => window.nativeProject), null, 'native scope clears before the home destination is shown');
    await unchangedBrowser(page, null, false);
    await page.getByRole('button', { name: '打开项目 山野品牌 1', exact: true }).click();
    await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
    await unchangedBrowser(page, 'p', false);
    assert.equal(await page.getByRole('button', { name: '打开素材库', exact: true }).getAttribute('aria-expanded'), 'false');
  },
  'canvas-motion': async page => {
    const result = await page.evaluate(async () => {
      const stage = document.querySelector('.canvas-stage');
      const plane = stage.querySelector('.canvas-plane');
      const rect = stage.getBoundingClientRect();
      const querySelectorAll = Document.prototype.querySelectorAll;
      let scans = 0;
      let transforms = 0;
      let previous = plane.style.transform;
      Document.prototype.querySelectorAll = function (selector) {
        if (selector.includes('.external-drag-backdrop') && selector.includes('[role="listbox"]')) scans++;
        return querySelectorAll.call(this, selector);
      };
      let frames = 0;
      try {
        const start = performance.now();
        while (performance.now() - start < 10000) {
          await new Promise(resolve => requestAnimationFrame(resolve));
          if (plane.style.transform !== previous) {
            previous = plane.style.transform;
            transforms++;
          }
          const zoom = frames % 120 >= 60;
          const delta = frames % 60 < 30 ? 1 : -1;
          stage.dispatchEvent(new WheelEvent('wheel', {
            bubbles: true, cancelable: true, ctrlKey: zoom,
            clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
            deltaX: zoom ? 0 : delta, deltaY: zoom ? delta : 0,
          }));
          frames++;
        }
      } finally {
        Document.prototype.querySelectorAll = querySelectorAll;
      }
      return { scans, frames, transforms };
    });
    assert.ok(result.transforms > 10, 'the mounted canvas actually pans and zooms beside Explore');
    assert.ok(result.scans <= 2, `overlay scanning remains idle during canvas camera updates: ${JSON.stringify(result)}`);
    console.log(`Canvas beside Explore, 10s: ${JSON.stringify(result)}`);
    await unchangedBrowser(page, 'p');
  },
  'canvas-save-failure': async page => {
    await page.evaluate(() => {
      window.store.getState().registerProjectCanvasFlush(async () => { throw new Error('隔离验证：画板保存失败'); });
    });
    await page.getByRole('button', { name: '返回主页', exact: true }).click();
    await page.getByText('隔离验证：画板保存失败', { exact: true }).waitFor();
    await unchangedBrowser(page, 'p');
    assert.equal(await page.locator('.canvas-workspace').isVisible(), true, 'failed save retains the current canvas');
    assert.equal(await page.evaluate(() => window.calls.slice(window.exploreCallsStart).some(call => call.command === 'set_active_project')), false, 'failed save never changes native capture scope');
    await page.evaluate(() => window.store.getState().registerProjectCanvasFlush(null));
    await page.getByRole('button', { name: '返回主页', exact: true }).click();
    await page.getByRole('region', { name: '项目管理' }).waitFor();
    await unchangedBrowser(page, null, false);
  },
};

try {
  for (const [name, run] of Object.entries(cases)) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(10000);
    const errors = [], remote = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue();
      remote.push(route.request().url()); return route.abort();
    });
    try {
      await openWorkspace(page, name.startsWith('canvas-'), !name.endsWith('asset-source-navigation'));
      await run(page);
      assert.deepEqual(errors, []);
      assert.deepEqual(remote, []);
      results.push({ name, passed: true });
    } catch (error) {
      results.push({ name, passed: false, error: error.message,
        state: await page.evaluate(() => ({ home: window.store?.getState().libraryHomeView, mode: window.mode?.getState().mode,
          browserVisible: !!document.querySelector('.explore-workspace.is-open'), calls: window.calls?.slice(window.exploreCallsStart) })) });
      await page.screenshot({ path: `${evidence}/${name}-failure.png` });
    } finally { await page.close(); }
  }
  await writeFile(`${evidence}/result.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results.map(({ name, passed, error }) => ({ name, passed, error })), null, 2));
  assert.equal(results.filter(result => !result.passed).length, 0, 'all real App exploration navigation cases pass');
} finally { await browser.close(); await server.close(); }
