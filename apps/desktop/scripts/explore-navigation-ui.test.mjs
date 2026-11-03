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

async function openWorkspace(page, canvas = false) {
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/home-navigation-live/preview.html?source-library&detail-route&canvas-library`);
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  if (!canvas) {
    await page.getByRole('button', { name: '返回主页', exact: true }).click();
    await page.locator('.library-home').waitFor();
  }
  const catalog = await page.evaluate(() => ({ open: window.mode.getState().open, mode: window.mode.getState().mode }));
  await page.getByRole('button', { name: '探索', exact: true }).click();
  await page.waitForFunction(() => window.calls.some(call => call.command === 'open_source_browser'));
  await page.waitForTimeout(200);
  assert.deepEqual(await page.evaluate(() => ({ open: window.mode.getState().open, mode: window.mode.getState().mode })), catalog, 'opening exploration preserves the material browser state');
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
    for (const label of ['素材库', '项目']) {
      assert.equal(await nav.getByRole('button', { name: label, exact: true }).evaluate(element => {
        const rect = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      }), true, `${label} is unobstructed at ${width}px`);
    }
    if (width === 900 || width === 1440) await page.screenshot({ path: `${evidence}/${name}-${width}-${theme}.png` });
  }
}

async function unchangedBrowser(page, projectId = null) {
  await page.waitForTimeout(200);
  assert.equal(await page.getByRole('complementary', { name: '探索面板' }).isVisible(), true, 'navigation preserves the visible exploration panel');
  assert.equal(await page.evaluate(() => window.exploreOriginal === document.querySelector('[data-source-browser-viewport]')), true, 'navigation preserves the same browser viewport');
  assert.deepEqual(await page.evaluate(commands => window.calls.slice(window.exploreCallsStart).filter(call => commands.includes(call.command)), disruptive), [], 'navigation neither hides nor recreates nor navigates the browser');
  assert.equal(await page.evaluate(() => window.store.getState().activeProjectId), projectId, 'navigation preserves the expected capture destination');
}

const cases = {
  'home-navigation': async page => {
    const nav = page.getByRole('navigation', { name: '首页' });
    assert.equal(await nav.isVisible(), true, 'library/projects navigation remains visible while exploring');
    await nav.getByRole('button', { name: '项目', exact: true }).click();
    await page.getByRole('region', { name: '项目管理' }).waitFor();
    assert.equal(await page.evaluate(() => window.store.getState().libraryHomeView), 'projects');
    await unchangedBrowser(page);
    await nav.getByRole('button', { name: '素材库', exact: true }).click();
    await page.locator('.library-home').waitFor();
    assert.equal(await page.evaluate(() => window.store.getState().libraryHomeView), 'library');
    await unchangedBrowser(page);
    await navigationLayout(page, 'home');
  },
  'catalog-navigation': async page => {
    for (const [label, mode] of [['集合分类', 'collections'], ['标签分类', 'tags'], ['全部', 'all']]) {
      await page.getByRole('tab', { name: label, exact: true }).click();
      await page.waitForFunction(mode => window.mode.getState().mode === mode, mode);
      assert.equal(await page.getByRole('tab', { name: label, exact: true }).getAttribute('aria-selected'), 'true');
      await unchangedBrowser(page);
    }
    await page.getByRole('button', { name: '收起浏览器', exact: true }).click();
    await page.waitForFunction(() => window.calls.slice(window.exploreCallsStart).some(call => call.command === 'hide_source_browser'));
    assert.equal(await page.getByRole('complementary', { name: '探索面板' }).isVisible(), false, 'explicit close still hides exploration');
    for (const [label, mode] of [['集合分类', 'collections'], ['标签分类', 'tags']]) {
      await page.getByRole('tab', { name: label, exact: true }).click();
      for (const open of [true, false]) {
        await page.getByRole('button', { name: '探索', exact: true }).click();
        await page.waitForTimeout(100);
        assert.equal(await page.getByRole('complementary', { name: '探索面板' }).isVisible(), open);
        assert.deepEqual(await page.evaluate(() => ({ open: window.mode.getState().open, mode: window.mode.getState().mode })), { open: true, mode }, 'exploration toggle preserves the selected catalog');
      }
    }
  },
  'canvas-home-navigation': async page => {
    const nav = page.getByRole('navigation', { name: '首页' });
    assert.equal(await nav.isVisible(), true, 'canvas exploration exposes library/projects navigation');
    await navigationLayout(page, 'canvas');
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
    await nav.getByRole('button', { name: '项目', exact: true }).click();
    await page.waitForFunction(() => !!window.releaseExploreFlush);
    await unchangedBrowser(page, 'p');
    assert.equal(await page.getByRole('region', { name: '项目管理' }).isVisible(), false, 'pending save does not leave the project early');
    assert.equal(await nav.getByRole('button', { name: '素材库', exact: true }).isDisabled(), true, 'pending route disables a second navigation');
    await page.evaluate(() => window.releaseExploreFlush());
    await page.getByRole('region', { name: '项目管理' }).waitFor();
    assert.equal(await page.evaluate(() => window.nativeProject), null, 'native scope clears before the home destination is shown');
    await unchangedBrowser(page);
    await page.getByRole('button', { name: '打开项目 山野品牌 1', exact: true }).click();
    await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
    await unchangedBrowser(page, 'p');
    await nav.getByRole('button', { name: '素材库', exact: true }).click();
    await page.locator('.library-home').waitFor();
    await unchangedBrowser(page);
  },
  'canvas-save-failure': async page => {
    const nav = page.getByRole('navigation', { name: '首页' });
    assert.equal(await nav.isVisible(), true, 'canvas exploration exposes library/projects navigation');
    await page.evaluate(() => {
      window.store.getState().registerProjectCanvasFlush(async () => { throw new Error('隔离验证：画板保存失败'); });
    });
    await nav.getByRole('button', { name: '项目', exact: true }).click();
    await page.getByText('隔离验证：画板保存失败', { exact: true }).waitFor();
    await unchangedBrowser(page, 'p');
    assert.equal(await page.locator('.canvas-workspace').isVisible(), true, 'failed save retains the current canvas');
    assert.equal(await page.evaluate(() => window.calls.slice(window.exploreCallsStart).some(call => call.command === 'set_active_project')), false, 'failed save never changes native capture scope');
    await page.evaluate(() => window.store.getState().registerProjectCanvasFlush(null));
    await page.getByRole('button', { name: '返回主页', exact: true }).click();
    await page.locator('.library-home').waitFor();
    await unchangedBrowser(page);
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
      await openWorkspace(page, name.startsWith('canvas-'));
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
