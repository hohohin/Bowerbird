import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const output = '.tmp/library-hover';
const server = await createServer({ cacheDir: `${output}/vite`, server: { host: '127.0.0.1', port: 17938, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
try {
  await mkdir(output, { recursive: true });
  await page.goto('http://127.0.0.1:17938/scripts/fixtures/library-tactical/preview.html');
  await page.evaluate(async () => { await import('/src/components/IndustrialTheme.css'); });
  const card = page.locator('.folder-media-card').first();
  await card.waitFor();
  await card.locator('img').evaluate(img => img.decode());
  await card.hover();
  const mark = card.locator('.media-hover-mark');
  await mark.waitFor();
  const result = await mark.evaluate(el => {
    const animations = el.getAnimations({ subtree: true });
    const sample = t => {
      animations.forEach(a => { a.pause(); a.currentTime = t; });
      return { dot: Number(getComputedStyle(el, '::before').opacity), ray: getComputedStyle(el.querySelector('path')).strokeDashoffset, rayOpacity: Number(getComputedStyle(el.querySelector('path')).opacity) };
    };
    const samples = [269, 270, 308, 346, 383, 420, 900].map(sample);
    const style = getComputedStyle(el, '::before');
    return { samples, size: style.width, height: style.height, pointer: getComputedStyle(el).pointerEvents,
      paths: [...el.querySelectorAll('path')].map(p => p.getAttribute('d')),
      other: getComputedStyle(el, '::after').width,
      old: getComputedStyle(el.parentElement, '::after').content };
  });
  assert.deepEqual(result.samples.map(s => s.dot), [1, .15, 1, .15, 1, 1, 1]);
  assert.equal(result.samples[5].ray, '-1px');
  assert.equal(result.samples[6].ray, '-1px');
  assert.equal(result.samples[5].rayOpacity, 0);
  assert.equal(result.samples[6].rayOpacity, 0);
  assert.deepEqual(result.paths, ['M50 50L100 0', 'M50 50L0 100']);
  for (const size of [result.size, result.height, result.other]) assert.ok(Math.abs(parseFloat(size) - 4.8) < .01);
  assert.equal(result.pointer, 'none'); assert.equal(result.old, 'none');
  // Deliberate letterboxing: the two points must follow the painted image, including resizing.
  for (const width of [180, 240]) {
    await card.locator('.folder-media-preview').evaluate((el, w) => {
      el.style.width = `${w}px`; el.style.height = '240px';
      Object.assign(el.querySelector('img').style, { width: '100%', height: '100%', objectFit: 'contain' });
    }, width);
    await page.waitForTimeout(50);
    assert.ok(await mark.evaluate(el => {
      const preview = el.parentElement.querySelector('.folder-media-preview'), img = preview.querySelector('img');
      const fit = Math.min(img.clientWidth / img.naturalWidth, img.clientHeight / img.naturalHeight);
      const width = img.naturalWidth * fit, height = img.naturalHeight * fit;
      return Math.abs(parseFloat(el.style.width) - width) < .1 && Math.abs(parseFloat(el.style.height) - height) < .1
        && Math.abs(parseFloat(el.style.top) - (preview.clientHeight - height) / 2) < .1;
    }), 'markers follow contain bounds');
  }
  await page.mouse.move(0, 0); await mark.waitFor({ state: 'detached' });
  await card.hover(); await mark.waitFor();
  assert.equal(await page.locator('.media-hover-mark').count(), 1, 'only the active card mounts a marker');
  const root = card.locator('xpath=ancestor::*[contains(@class,"library-motion-root")][1]');
  await root.evaluate(el => el.dataset.libraryMotionPaused = 'true');
  assert.equal(await mark.locator('path').first().evaluate(el => getComputedStyle(el).opacity), '0');
  assert.equal(await mark.evaluate(el => getComputedStyle(el, '::before').opacity), '1');
  await root.evaluate(el => { delete el.dataset.libraryMotionPaused; el.dataset.libraryDragging = 'true'; });
  assert.equal(await mark.evaluate(el => getComputedStyle(el).display), 'none');
  await root.evaluate(el => delete el.dataset.libraryDragging);
  for (const theme of ['dark', 'light']) {
    await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
    await page.waitForTimeout(450);
    await page.screenshot({ path: `${output}/${theme}.png` });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await mark.locator('path').first().evaluate(el => getComputedStyle(el).animationName), 'none');
  assert.equal(await mark.evaluate(el => getComputedStyle(el, '::before').opacity), '1');
  assert.equal(await mark.locator('path').first().evaluate(el => getComputedStyle(el).strokeDashoffset), '-1px');
  await card.click({ modifiers: ['Control'] }); await mark.waitFor({ state: 'detached' });
  assert.equal(await card.locator('.library-selection-mark').count(), 1, 'selection keeps its independent marker');
  assert.deepEqual(errors, []);
  console.log('PASS: diagonal geometry, 4.8px points, 270-420ms flashes, stable final state, contain/resize, reentry, themes, reduced motion and selection');
} finally { await browser.close(); await server.close(); }
