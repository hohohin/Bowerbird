import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const output = '.tmp/library-hover-anchor';
await mkdir(output, { recursive: true });
const server = await createServer({ cacheDir: `${output}/vite`, server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(8000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
  window.total = 12;
  window.assetDimensions = i => ({ thumb_path: `/src-tauri/resources/samples/preset-${String(i % 8 + 1).padStart(2, '0')}.webp` });
});
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
async function hoverAtOriginalPoint(control, name, width) {
  const strip = page.getByRole('tablist', { name: '素材视图切换条', exact: true });
  const collapsedWidth = (await strip.boundingBox()).width;
  assert.ok(collapsedWidth < 180, 'start with the collapsed HUD');
  const box = await control.boundingBox(), point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const center = await control.evaluate(element => {
    const field = element.closest('.file-view-heading').querySelector('.library-control-projection').getBoundingClientRect();
    return field.left + field.width / 2;
  });
  await page.mouse.move(point.x, point.y);
  const frames = await page.evaluate(point => new Promise(resolve => {
    const frames = [], start = performance.now();
    const sample = () => {
      const hit = document.elementFromPoint(point.x, point.y)?.closest('button');
      const field = document.querySelector('.library-control-projection').getBoundingClientRect();
      frames.push({ hit: hit?.getAttribute('aria-label'), center: field.left + field.width / 2,
        miss: hit?.getAttribute('aria-label') === point.name ? undefined : {
          element: document.elementFromPoint(point.x, point.y)?.outerHTML.slice(0, 180),
          shift: document.querySelector('.file-view-heading').style.getPropertyValue('--library-hover-shift'),
          types: [...document.querySelectorAll('[aria-label="素材类型"] button')].map(button => { const box = button.getBoundingClientRect(); return [button.getAttribute('aria-label'), box.left, box.right]; }),
        } });
      if (performance.now() - start < 550) requestAnimationFrame(() => setTimeout(sample, 0)); else resolve(frames);
    };
    requestAnimationFrame(() => setTimeout(sample, 0));
  }), { ...point, name });
  assert.ok(frames.every(frame => frame.hit === name), `stationary pointer stays on ${name} at ${width} (${point.x}, ${point.y}): ${JSON.stringify(frames.filter(frame => frame.hit !== name))}`);
  assert.ok(frames.every(frame => Math.abs(frame.center - center) < 2), `background stays fixed while ${name} expands at ${width}: ${JSON.stringify(frames)}`);
  assert.ok((await strip.boundingBox()).width > collapsedWidth + 60, 'hover really expands the HUD');
  return point;
}
try {
  for (const width of [1440, 1024, 800, 736, 400, 320]) for (const theme of width === 1440 ? ['dark', 'light'] : ['dark']) for (const [media, name] of [['all', '全部类型'], ['images', '图片'], ['videos', '视频'], ['audios', '音频'], ['texts', '文本']]) {
    await page.setViewportSize({ width, height: 900 });
    await page.mouse.move(0, 800);
    await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/catalog-paging/preview.html?navigation`);
    await page.getByRole('tablist', { name: '素材视图切换条', exact: true }).waitFor();
    await page.evaluate(({media, theme}) => { document.documentElement.dataset.theme = theme; window.mode.getState().setMedia(media); }, {media, theme});
    await page.waitForTimeout(450);
    const more = page.getByRole('button', { name: '更多素材库控件', exact: true });
    if (await more.isVisible()) {
      const point = await hoverAtOriginalPoint(more, '更多素材库控件', width);
      if (width === 320 && media === 'images') await page.screenshot({ path: `${output}/320-overflow-target.png` });
      await page.mouse.click(point.x, point.y);
      await page.getByRole('dialog', { name: '素材库控件', exact: true }).waitFor();
    } else {
      const control = page.getByRole('group', { name: '素材类型', exact: true }).getByRole('button', { name, exact: true });
      const point = await hoverAtOriginalPoint(control, name, width);
      if (width === 1440 && media === 'texts') await page.screenshot({ path: `${output}/media-${theme}.png` });
      await page.mouse.click(point.x, point.y);
      assert.equal(await control.getAttribute('aria-pressed'), 'true', 'original-coordinate click preserves the media type');
      assert.equal(await page.evaluate(() => window.mode.getState().media), media);
    }
  }
  console.log('PASS media targets and fixed background across widths and themes');
  for (const width of [1440, 1024, 736, 400, 320]) for (const name of ['文件夹', '项目素材', '标签分类', '全部素材']) {
    await page.setViewportSize({ width, height: 900 });
    await page.mouse.move(0, 800);
    await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/catalog-paging/preview.html?navigation`);
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    const nav = page.getByRole('tablist', { name: '素材视图切换条', exact: true });
    const tab = nav.getByRole('tab', { name, exact: true });
    await tab.waitFor();
    await page.waitForTimeout(450);
    const point = await hoverAtOriginalPoint(tab, name, width);
    await page.screenshot({ path: `${output}/${width}-${name}.png` });
    // Click at the original coordinates, not a locator that aims again after expansion.
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(100);
    assert.equal(await nav.getByRole('tab', { name, exact: true }).getAttribute('aria-selected'), 'true');
    const bounds = await nav.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, 'translated strip stays inside the library');
  }
  for (const name of ['不看生成图', '颜色筛选']) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.mouse.move(0, 800);
    await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/catalog-paging/preview.html?navigation`);
    const control = page.getByRole('button', { name, exact: true });
    await control.waitFor();
    await page.evaluate(() => document.documentElement.dataset.theme = 'light');
    await page.waitForTimeout(450);
    const point = await hoverAtOriginalPoint(control, name, 1440);
    await page.mouse.click(point.x, point.y);
    assert.equal(await control.getAttribute(name === '颜色筛选' ? 'aria-expanded' : 'aria-pressed'), 'true');
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.mouse.move(0, 800);
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/catalog-paging/preview.html?navigation`);
  await page.getByRole('tablist', { name: '素材视图切换条', exact: true }).waitFor();
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; window.mode.getState().setMedia('texts'); });
  await page.waitForTimeout(450);
  await hoverAtOriginalPoint(page.getByRole('button', { name: '文本', exact: true }), '文本', 1440);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.mouse.move(0, 800);
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/catalog-paging/preview.html?navigation`);
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  const tab = page.getByRole('tab', { name: '项目素材', exact: true });
  await tab.waitFor(); await page.waitForTimeout(450);
  await tab.hover(); await page.waitForTimeout(550);
  await page.mouse.move(0, 800); await page.waitForTimeout(2400);
  assert.equal(await tab.evaluate(element => element.closest('.file-view-heading').style.getPropertyValue('--library-hover-shift')), '', 'collapse releases the pointer anchor');
  const geometry = await tab.evaluate(element => {
    const heading = element.closest('.file-view-heading'), strip = heading.querySelector('[role="tablist"]').getBoundingClientRect(), controls = heading.querySelector('.library-controls-host').getBoundingClientRect(), bounds = heading.getBoundingClientRect();
    return { groupCenter: (strip.left + controls.right) / 2, center: (bounds.left + bounds.right) / 2 };
  });
  assert.ok(Math.abs(geometry.groupCenter - geometry.center) < 2, `collapsed group returns to center: ${JSON.stringify(geometry)}`);
  await tab.hover(); await page.waitForTimeout(40); await page.mouse.move(0, 800); await page.waitForTimeout(180);
  assert.equal(await tab.evaluate(element => element.closest('.file-view-heading').hasAttribute('data-hover-anchored')), false, 'brief pass does not retain an anchor');
  assert.deepEqual(errors, []);
  console.log('PASS stationary targets for tabs, media types, filters and overflow, fixed background, dark/light and reduced motion');
} finally { await browser.close(); await server.close(); }
