import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const { PNG } = createRequire(createRequire(import.meta.url).resolve('qrcode/package.json'))('pngjs');
const output = '.tmp/composer-contour';
await mkdir(output, { recursive: true });
const server = await createServer({ cacheDir: `${output}/vite`, server: { host: '127.0.0.1', port: 18989, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
const url = `${server.resolvedUrls.local[0]}scripts/fixtures/library-creation-parity/preview.html?source-library&detail-route&canvas-library`;
try {
  for (const location of ['home', 'canvas']) {
    await page.goto(url);
    await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
    if (location === 'home') {
      await page.getByRole('button', { name: '返回主页', exact: true }).click();
      await page.getByRole('navigation', { name: '首页' }).getByRole('button', { name: '素材库', exact: true }).click();
    }
    const dock = page.locator(location === 'home' ? '.library-composer .creation-dock' : '.canvas-workspace .creation-dock');
    if (location === 'home') await dock.getByRole('button', { name: '展开创作描述', exact: true }).click();
    await dock.locator('.ProseMirror').fill('让清晨的光线落在柔和的材质上，保留细腻纹理与安静的空间层次。');
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.waitForTimeout(350);
      const ink = await dock.locator('.ProseMirror p').first().evaluate(el => getComputedStyle(el).color);
      assert.equal(ink, theme === 'dark' ? 'rgb(220, 220, 220)' : 'rgb(44, 53, 76)', `${location}/${theme}: input text uses the film's contrasting ink`);
      await page.screenshot({ path: `${output}/${location}-${theme}.png` });
    }
    // Put a known moving image behind the real composer, outside its subtree.
    // A screenshot verifies actual backdrop sampling, not just CSS support.
    const sample = await dock.evaluate(el => {
      const host = el.closest('.library-composer') ?? el.closest('.canvas-composer-host');
      const pattern = document.createElement('div'); pattern.id = 'contour-test-pattern';
      Object.assign(pattern.style, { position: 'absolute', inset: '0', zIndex: String(Number(getComputedStyle(host).zIndex) - 1), pointerEvents: 'none', background: 'repeating-linear-gradient(90deg,white 0 40px,black 40px 80px)' });
      host.before(pattern);
      const style = document.createElement('style'); style.id = 'contour-test-style';
      style.textContent = '.composer-projection-dots,.composer-cross-matrix {visibility:hidden!important}.composer-projection-surface::after{display:none!important}';
      document.head.append(style);
      const rect = el.querySelector('.ProseMirror').getBoundingClientRect();
      return { x: Math.ceil(rect.left + 50), y: Math.ceil(rect.bottom + 7), width: 240, height: 1 };
    });
    const row = async () => {
      const { data, width } = PNG.sync.read(await page.screenshot({ clip: sample }));
      return Array.from({ length: width }, (_, i) => (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3);
    };
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.waitForTimeout(100);
      const pixels = await row(), sorted = [...pixels].sort((a, b) => a - b), median = sorted[120];
      assert.ok(theme === 'dark' ? median < 60 : median > 225, `${location}/${theme}: reading surface suppresses bright and dark imagery (${median})`);
      const edges = pixels.filter(v => Math.abs(v - median) > 14);
      assert.ok(edges.length >= 3 && edges.length < 24, `${location}/${theme}: only narrow image contours remain, got ${edges.length} edge pixels`);
      await page.locator('#contour-test-pattern').evaluate(el => el.style.backgroundPositionX = '17px');
      assert.notDeepEqual(await row(), pixels, `${location}/${theme}: contours follow the live background`);
      await page.locator('#contour-test-pattern').evaluate(el => el.style.backgroundPositionX = '0px');
      await page.screenshot({ path: `${output}/${location}-${theme}-contrast.png` });
    }
    await page.evaluate(() => { document.querySelector('#contour-test-pattern').remove(); document.querySelector('#contour-test-style').remove(); });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
    await page.waitForTimeout(350);
    const fallback = await dock.locator('.composer-projection-surface').evaluate(el => ({ filter: getComputedStyle(el).backdropFilter, color: getComputedStyle(el).backgroundColor, glare: getComputedStyle(el, '::after').display }));
    assert.deepEqual(fallback, { filter: 'none', color: 'rgb(240, 242, 247)', glare: 'none' }, 'reduced transparency keeps an opaque reading surface');
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    await cdp.detach();
    await page.emulateMedia({ forcedColors: 'active' });
    assert.equal(await dock.locator('.composer-projection').isVisible(), false, 'high contrast retains the native reading surface');
    await page.emulateMedia({ forcedColors: 'none' });
  }
  assert.deepEqual(errors, []);
  console.log('PASS: contour readability, live background edges, both themes and composer entry points');
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` });
  throw error;
} finally { await browser.close(); await server.close(); }
