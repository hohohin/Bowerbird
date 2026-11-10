import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const output = '.tmp/canvas-library-projection';
await mkdir(output, { recursive: true });
const server = await createServer({ cacheDir: `${output}/vite`, server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(8000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => localStorage.setItem('bowerbird.canvasLibraryWidth', new URL(location.href).searchParams.get('test-library-width') ?? '480'));
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
const panel = page.locator('.canvas-source-panel');
const nav = panel.getByRole('tablist', { name: '素材视图切换条', exact: true });
const more = panel.getByRole('button', { name: '更多素材库控件', exact: true });
const types = panel.locator('.library-media-switch[aria-label="素材类型"]');
async function assertClosedControlsHidden() {
  const ghosts = await panel.locator('.library-controls-host.is-compact:not(.is-open) .folder-floating-controls button').evaluateAll(buttons => buttons.filter(button => getComputedStyle(button).visibility === 'visible').map(button => button.getAttribute('aria-label')));
  assert.deepEqual(ghosts, [], 'closed overflow must not expose inert type buttons over the gallery');
}
async function openControls() {
  if (await more.isVisible()) {
    if (await more.getAttribute('aria-expanded') !== 'true') await more.click();
  } else await types.hover();
  await page.waitForTimeout(450);
}
async function assertIconVisible(button) {
  const icon = await button.locator('svg').evaluate(svg => {
    const style = getComputedStyle(svg), box = svg.getBoundingClientRect();
    return { visibility: style.visibility, display: style.display, opacity: Number(style.opacity), stroke: style.stroke, width: box.width, height: box.height };
  });
  assert.equal(icon.visibility, 'visible');
  assert.notEqual(icon.display, 'none');
  assert.ok(icon.width >= 8 && icon.height >= 8 && icon.opacity > 0 && icon.stroke !== 'none', `active icon remains rendered: ${JSON.stringify(icon)}`);
}
try {
  for (const width of [480, 1200]) for (const theme of ['dark', 'light']) {
    await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/library-creation-parity/preview.html?source-library&detail-route&canvas-library&test-library-width=${width}`);
    await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
    const open = page.locator('.app-topbar').getByRole('button', { name: '打开素材库', exact: true });
    if (await open.isVisible()) await open.click();
    await nav.waitFor();
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await nav.hover(); await page.waitForTimeout(550);
    assert.equal(await more.isVisible(), width === 480, 'exercise both overflow and inline controls');
    await assertClosedControlsHidden();
    await assertIconVisible(nav.getByRole('tab', { selected: true }));
    await page.screenshot({ path: `${output}/${width}-${theme}-closed.png` });
    for (const name of ['全部类型', '视频', '音频', '文本', '图片']) {
      await openControls();
      const button = types.locator(`button[aria-label="${name}"]`);
      const hit = await button.evaluate(button => {
        const box = button.getBoundingClientRect();
        return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest('button') === button && !button.closest('[inert]');
      });
      assert.equal(hit, true, `${name} receives the pointer instead of the gallery`);
      const box = await button.boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(350);
      assert.equal(await button.getAttribute('aria-pressed'), 'true', `raw coordinate click selects ${name}`);
      await assertClosedControlsHidden();
      await openControls();
      await assertIconVisible(types.locator('button[aria-pressed="true"]'));
      await assertIconVisible(nav.getByRole('tab', { selected: true }));
    }
    await page.screenshot({ path: `${output}/${width}-${theme}-open.png` });
    if (await more.isVisible()) {
      await page.keyboard.press('Escape');
      assert.equal(await more.getAttribute('aria-expanded'), 'false');
      await assertClosedControlsHidden();
      assert.equal(await more.evaluate(button => button === document.activeElement), true);
    }
  }
  assert.deepEqual(errors, []);
  console.log('PASS actual canvas library: no visible inert controls, raw clicks for all five types, active icons, dark/light, inline/overflow and Escape');
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` }); throw error;
} finally { await browser.close(); await server.close(); }
