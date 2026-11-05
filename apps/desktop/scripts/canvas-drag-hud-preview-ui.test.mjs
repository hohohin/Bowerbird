import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const output = '.tmp/canvas-drag-hud-preview';
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: `${output}/vite`,
  css: { postcss: { plugins: [] } }, esbuild: { jsx: 'automatic' },
  optimizeDeps: { entries: ['scripts/fixtures/canvas-drag-hud/preview.html'], include: ['react', 'react-dom/client', 'react/jsx-runtime'] },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
page.setDefaultTimeout(5000);
const errors = [], remote = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => { if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue(); remote.push(route.request().url()); return route.abort(); });
const app = () => page.locator('.mock-bowerbird');
const card = () => page.locator('[data-canvas-asset="image"]');
const center = async locator => { const box = await locator.boundingBox(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; };
const move = point => page.mouse.move(point.x, point.y);
const blurred = () => page.evaluate(() => { const blur = document.querySelector('.app-drag-blur'); return !!blur && getComputedStyle(blur).backdropFilter.includes('blur('); });
const hold = async () => { await move(await center(card())); await page.mouse.down(); };
try {
  await mkdir(output, { recursive: true });
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/canvas-drag-hud/preview.html`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '画布', exact: true }).waitFor();
  const initial = await card().boundingBox();
  await hold(); await page.waitForTimeout(350);
  assert.equal(await blurred(), false, 'before long-press threshold the shell remains clear');
  await page.locator('[data-carrying="canvas"]').waitFor();
  assert.equal(await blurred(), true, 'the complete app shell blurs after the threshold');
  assert.deepEqual(await page.locator('.app-drag-blur').boundingBox(), await app().boundingBox());
  assert.equal(await app().evaluate(element => getComputedStyle(element).filter), 'none', 'the shell keeps its fixed-position coordinate system');
  assert.equal(await page.locator('.carried-material').evaluate(element => getComputedStyle(element).filter), 'none');
  assert.equal(await page.getByRole('region', { name: '外部应用演示' }).evaluate(element => getComputedStyle(element).filter), 'none');
  await page.getByRole('heading', { name: '拖到其他应用中使用' }).waitFor();
  await page.waitForTimeout(550);
  assert.equal(await page.locator('.app-drag-blur').evaluate(el => getComputedStyle(el).animationDuration), '0.24s');
  await page.screenshot({ path: `${output}/carrying-dark.png` });
  await move(await center(page.locator('.receiver-target'))); await page.mouse.up();
  await page.locator('[data-received="image"]').waitFor();
  assert.equal(await blurred(), false); assert.deepEqual(await card().boundingBox(), initial, 'external drop leaves the original canvas position');
  // Movement chooses canvas movement once; pausing during that drag never switches to export.
  await hold(); const start = await center(card()); await page.mouse.move(start.x + 36, start.y + 25);
  await page.waitForTimeout(750);
  assert.equal(await blurred(), false); assert.equal(await page.locator('.carried-material').count(), 0);
  const moved = await card().boundingBox(); assert.ok(moved.x > initial.x + 30); await page.mouse.up();
  await hold(); await page.locator('[data-carrying="canvas"]').waitFor(); await page.keyboard.press('Escape'); await page.mouse.up();
  assert.equal(await blurred(), false); assert.equal(await page.locator('.carried-material').count(), 0);
  await hold(); await page.locator('[data-carrying="canvas"]').waitFor(); await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await page.mouse.up();
  assert.equal(await blurred(), false);
  await hold(); await page.mouse.up(); await page.waitForTimeout(700); assert.equal(await blurred(), false, 'release before threshold cancels the timer');
  const library = page.locator('[data-library-asset="video"]'); await move(await center(library)); await page.mouse.down();
  await page.mouse.move((await center(library)).x + 20, (await center(library)).y);
  await page.locator('[data-carrying="library"]').waitFor(); assert.equal(await blurred(), true, 'library drag shares the outgoing HUD');
  await move(await center(page.locator('.receiver-target'))); await page.mouse.up(); await page.locator('[data-received="video"]').waitFor();
  await page.getByRole('button', { name: '切换明暗主题', exact: true }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${output}/overview-light.png` });
  await hold(); await page.locator('[data-carrying="canvas"]').waitFor(); await page.waitForTimeout(550); await page.screenshot({ path: `${output}/carrying-light.png` });
  await page.keyboard.press('Escape'); await page.mouse.up();
  assert.deepEqual(errors, []); assert.deepEqual(remote, []);
  await writeFile(`${output}/result.json`, JSON.stringify({ passed: true, errors, remote, thresholdMs: 600, cancelMovementPx: 4, native: false }, null, 2));
  console.log('Canvas long-press preview passed: whole-app blur, clear payload/receiver, move cancellation, release/Escape/blur cleanup, library drag and both themes.');
} finally { await browser.close(); await server.close(); }
