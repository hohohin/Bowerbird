import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const output = '.tmp/connected-context-style';
const server = await createServer({ cacheDir: `${output}/vite`, server: { host: '127.0.0.1', port: 17940, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
try {
  await mkdir(output, { recursive: true });
  await page.goto('http://127.0.0.1:17940/scripts/fixtures/connected-collections/preview.html');
  await page.evaluate(async () => {
    await import('/src/components/TacticalProjection.css');
    await import('/src/components/TacticalMenus.css');
    await import('/src/components/IndustrialMenus.css');
  });
  const card = page.locator('[data-connection-entry="root-0"] .folder-media-card');
  await card.waitFor();
  for (const theme of ['dark', 'light']) {
    await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
    for (const target of [card, page.locator('[data-collection-id="root"]')]) {
      await target.click({ button: 'right' });
      const menu = page.getByRole('menu');
      await menu.waitFor();
      const geometry = await menu.evaluate(el => {
        const content = el.querySelector('.context-menu-content').getBoundingClientRect();
        return { width: content.width, radius: getComputedStyle(el).borderRadius, items: [...el.querySelectorAll('[role="menuitem"]')].map(item => {
          const r = item.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height, radius: getComputedStyle(item).borderRadius };
        }) };
      });
      assert.ok(geometry.items.length >= 4);
      for (const [i, item] of geometry.items.entries()) {
        assert.ok(item.height >= 32, `${theme}: menu item has a full-height hit area, got ${item.height}`);
        assert.ok(item.width >= geometry.width - 16, 'each item occupies a full row');
        assert.equal(item.radius, '0px');
        if (i) assert.ok(item.y >= geometry.items[i - 1].y + geometry.items[i - 1].height, 'items do not wrap or overlap');
      }
      assert.equal(geometry.radius, '0px');
      await page.keyboard.press('End');
      assert.equal(await menu.getByRole('menuitem').last().evaluate(el => el === document.activeElement), true);
      await page.screenshot({ path: `${output}/${theme}-${target === card ? 'asset' : 'folder'}.png` });
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'detached' });
    }
  }
  assert.equal(await card.getAttribute('aria-pressed'), 'false', 'right click does not select the asset');
  console.log('PASS: connected asset/folder menus have full-width stacked hit areas, industrial corners and keyboard dismissal in both themes');
} finally { await browser.close(); await server.close(); }
