import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/industrial-hover/vite', server: { host: '127.0.0.1', port: 17939, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
try {
  await page.goto('http://127.0.0.1:17939/scripts/fixtures/library-tactical/preview.html');
  await page.evaluate(async () => {
    await import('/src/components/TacticalProjection.css');
    await import('/src/components/CanvasSecondaryTactical.css');
    await import('/src/components/IndustrialTheme.css');
    await import('/src/components/IndustrialMenus.css');
    const samples = document.createElement('section');
    samples.style.cssText = 'position:fixed;bottom:20px;left:20px;z-index:9999;background:var(--bb-bg);display:flex;gap:20px';
    samples.innerHTML = '<button class="app-button-secondary" data-hover-sample>普通按钮</button><button class="app-button-primary" data-hover-sample>重点按钮</button><div class="composer-glass"><button class="composer-add-material" data-hover-sample>添加素材</button></div><div class="app-popover"><button class="app-popover-option" data-hover-sample>菜单选项</button></div><button class="app-modal-button is-danger" data-danger>删除</button>';
    document.body.append(samples);
  });
  const tab = page.locator('.library-view-switch button').first();
  const project = page.locator('.library-projects-trigger');
  for (const theme of ['dark', 'light']) {
    await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
    for (const control of [tab, project, page.locator('.library-filter-trigger:not(:disabled)').first(), ...await page.locator('[data-hover-sample]').all()]) {
      await page.mouse.move(0, 0);
      await page.waitForTimeout(250);
      const idleColor = await control.evaluate(el => getComputedStyle(el).color);
      await control.hover();
      await page.waitForTimeout(350);
      const state = await control.evaluate(el => ({ color: getComputedStyle(el).color, accent: getComputedStyle(document.documentElement).getPropertyValue('--industrial-accent-rgb').trim(), opacity: getComputedStyle(el).opacity }));
      assert.equal(state.color, `rgb(${state.accent.split(/\s+/).join(', ')})`, `${theme}: ${await control.evaluate(el => el.outerHTML)} hover settles in accent`);
      assert.equal(state.opacity, '1', 'pulse ends fully visible');
      await page.mouse.move(0, 0);
      await page.waitForTimeout(250);
      assert.equal(await control.evaluate(el => getComputedStyle(el).color), idleColor, 'pointer leave restores original state');
    }
    await page.mouse.move(0, 0);
    await page.waitForTimeout(250);
    const danger = page.locator('[data-danger]');
    const dangerColor = await danger.evaluate(el => getComputedStyle(el).color);
    await danger.hover();
    await page.waitForTimeout(250);
    assert.equal(await danger.evaluate(el => getComputedStyle(el).color), dangerColor, 'danger retains semantic color');
    await project.focus();
    await page.waitForTimeout(250);
    assert.equal(await project.evaluate(el => getComputedStyle(el).color), theme === 'dark' ? 'rgb(143, 170, 184)' : 'rgb(73, 103, 117)', 'keyboard focus uses accent');
    await project.evaluate(el => el.blur());
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await project.hover();
  await page.waitForTimeout(250);
  assert.equal(await project.evaluate(el => getComputedStyle(el).color), 'rgb(73, 103, 117)', 'reduced motion uses the same final color');
  console.log('PASS: dark/light hover final accent, opacity, pointer leave and reduced motion');
} finally { await browser.close(); await server.close(); }
