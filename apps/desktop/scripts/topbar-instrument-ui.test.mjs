import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/topbar-instrument/vite', server: { host: '127.0.0.1', port: 17966, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
page.setDefaultTimeout(6000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
try {
  await mkdir('.tmp/topbar-instrument', { recursive: true });
  await page.goto('http://127.0.0.1:17966/scripts/fixtures/canvas-reference/preview.html?source-library&detail-route&canvas-library');
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  const header = page.locator('.app-topbar');
  for (const view of ['canvas', 'library', 'projects']) {
    if (view === 'library') await page.getByRole('button', { name: '返回主页', exact: true }).click();
    if (view === 'projects') await page.getByRole('navigation', { name: '首页' }).getByRole('button', { name: '项目', exact: true }).click();
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      for (const width of [900, 1280, 1920]) {
        await page.setViewportSize({ width, height: 840 });
        const state = await header.evaluate(el => {
          const bar = el.getBoundingClientRect();
          const buttons = [...el.querySelectorAll('button')].filter(button => button.getBoundingClientRect().width);
          const boxes = buttons.map(button => button.getBoundingClientRect());
          const surfaces = [...el.querySelectorAll('.app-topbar-leading, .app-topbar-import, .app-topbar-view-controls, .library-view-segments, .home-page-navigation')];
          return {
            height: bar.height,
            transparent: buttons.every(button => getComputedStyle(button).backgroundColor === 'rgba(0, 0, 0, 0)'),
            groupSurfaces: surfaces.map(surface => ({ name: surface.className, background: getComputedStyle(surface).backgroundColor, image: getComputedStyle(surface).backgroundImage, shadow: getComputedStyle(surface).boxShadow })),
            contained: boxes.every(box => box.left >= bar.left && box.right <= bar.right && box.top >= bar.top && box.bottom <= bar.bottom),
            overlap: boxes.some((a, i) => boxes.slice(i + 1).some(b => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top)),
          };
        });
        assert.equal(state.height, 44, `${view}/${theme}/${width}: compact header`);
        assert.ok(state.transparent && state.contained && !state.overlap, JSON.stringify({ view, theme, width, state }));
        assert.ok(state.groupSurfaces.every(surface => surface.background === 'rgba(0, 0, 0, 0)' && surface.image === 'none' && surface.shadow === 'none'), `${view}/${theme}/${width}: button groups have no background boxes: ${JSON.stringify(state.groupSurfaces)}`);
      }
      const button = header.locator('.topbar-account-trigger');
      const neighbour = header.locator('button').first();
      await page.mouse.move(0, 100);
      await page.waitForTimeout(240);
      const idle = await neighbour.evaluate(el => getComputedStyle(el).color);
      await button.hover();
      await page.waitForTimeout(240);
      const final = await button.evaluate(el => ({ color: getComputedStyle(el).color, opacity: getComputedStyle(el).opacity }));
      assert.equal(final.color, theme === 'dark' ? 'rgb(143, 170, 184)' : 'rgb(73, 103, 117)');
      assert.equal(final.opacity, '1');
      assert.equal(await neighbour.evaluate(el => getComputedStyle(el).color), idle, 'neighbours do not change');
      for (const action of await header.locator('.app-topbar-leading button').all()) {
        await action.hover();
        await page.waitForTimeout(240);
        const surfaces = await action.evaluate(el => [el, el.closest('.app-topbar-leading')].map(surface => ({ background: getComputedStyle(surface).backgroundColor, image: getComputedStyle(surface).backgroundImage, shadow: getComputedStyle(surface).boxShadow })));
        assert.ok(surfaces.every(surface => surface.background === 'rgba(0, 0, 0, 0)' && surface.image === 'none' && surface.shadow === 'none'), `${view}/${theme}: hovered action and its group stay transparent`);
      }
      if (view === 'canvas') {
        const filter = header.getByRole('button', { name: '只看图片', exact: true });
        await filter.click();
        await page.mouse.move(0, 100);
        await page.waitForTimeout(240);
        assert.equal(await filter.getAttribute('aria-pressed'), 'true');
        assert.equal(await filter.evaluate(el => getComputedStyle(el).color), final.color, 'selected color survives pointer leave');
        await filter.click();
        const chrome = await page.locator('.canvas-board-toolbar > div').evaluateAll(elements => elements.map(el => ({ background: getComputedStyle(el).backgroundColor, border: getComputedStyle(el).borderTopWidth })));
        assert.ok(chrome.every(style => style.background === 'rgba(0, 0, 0, 0)' && style.border === '0px'), 'canvas title and zoom have no boxes');
      }
      await page.setViewportSize({ width: 1280, height: 840 });
      await page.screenshot({ path: `.tmp/topbar-instrument/${view}-${theme}.png` });
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const account = header.locator('.topbar-account-trigger');
  await account.focus();
  assert.equal(await account.evaluate(el => getComputedStyle(el).animationName), 'none');
  await page.keyboard.press('Enter');
  await page.getByRole('dialog', { name: '设置', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  console.log('PASS: compact transparent topbar; canvas/library/projects; dark/light; 900–1920px; hover/selection/reduced motion; account entry');
} finally { await browser.close(); await server.close(); }
