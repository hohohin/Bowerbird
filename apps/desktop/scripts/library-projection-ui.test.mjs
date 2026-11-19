import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const output = '.tmp/library-projection';
const server = await createServer({ cacheDir: `${output}/vite`, server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
page.setDefaultTimeout(8000);
const errors = [], measurements = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
  window.total = 30;
  window.assetDimensions = i => ({ thumb_path: `/src-tauri/resources/samples/preset-${String(i % 8 + 1).padStart(2, '0')}.webp` });
});
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
const primary = () => page.getByRole('tablist', { name: '素材视图切换条', exact: true });
async function assertSelectionContrast(control) {
  // Theme/pressed changes may still be completing the short foreground transition.
  await control.page().waitForTimeout(180);
  const ratio = await control.evaluate(element => {
    const style = getComputedStyle(element);
    const luminance = color => {
      const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
      return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
    };
    const ink = luminance(style.color), paper = luminance(style.backgroundImage.match(/rgba?\([^)]+\)/)[0]);
    return (Math.max(ink, paper) + .05) / (Math.min(ink, paper) + .05);
  });
  assert.ok(ratio >= 4.5, `selected label has readable contrast: ${ratio}`);
}
async function assertFieldCentered() {
  const geometry = await primary().evaluate(async nav => {
    // Layout observers update the optical field before the frame is presented.
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
    const heading = nav.closest('.file-view-heading');
    const bounds = heading.getBoundingClientRect();
    const field = heading.querySelector('.library-control-projection').getBoundingClientRect();
    return { libraryCenter: (bounds.left + bounds.right) / 2, fieldCenter: field.left + field.width / 2 };
  });
  assert.ok(Math.abs(geometry.libraryCenter - geometry.fieldCenter) < 2, `field stays at the library center: ${JSON.stringify(geometry)}`);
}
try {
  await mkdir(output, { recursive: true });
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/catalog-paging/preview.html?navigation&home`);
  await primary().waitFor();
  assert.equal(await page.locator('.library-control-field').evaluate(el => getComputedStyle(el).opacity), '0.8');
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await page.locator('.folder-media-card img').first().waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.folder-media-card img')].some(image => image.complete && image.naturalWidth > 0));
  for (const name of ['文件夹', '项目素材', '标签分类', '全部素材']) {
    assert.equal(await primary().getByRole('tab', { name, exact: true }).locator('svg').count(), 1, `${name} has its own icon`);
  }
  await page.mouse.move(0, 800);
  const compactWidth = (await primary().boundingBox()).width;
  assert.ok(compactWidth < 180, 'idle strip shows compact icons');
  await primary().hover();
  await page.waitForTimeout(150);
  assert.ok((await primary().boundingBox()).width > compactWidth + 150, 'hover expands labels');
  await assertFieldCentered();
  await page.screenshot({ path: `${output}/expanded-dark.png` });
  await page.mouse.move(0, 800);
  await page.waitForTimeout(1000);
  assert.ok((await primary().boundingBox()).width > compactWidth, 'leaving keeps labels for two seconds');
  await page.waitForTimeout(1150);
  assert.equal((await primary().boundingBox()).width, compactWidth, 'leaving restores icon strip');
  assert.equal(await page.getByRole('group', {name:'素材类型', exact:true}).getByRole('button').count(), 1, 'collapsed types show only selection');
  await page.getByRole('group', {name:'素材类型', exact:true}).hover(); await page.waitForTimeout(150);
  await page.getByRole('button', { name: '全部类型', exact: true }).click();
  await page.waitForFunction(() => window.requests.filter(r => r.command === 'catalog_overview').at(-1)?.args.filter.media === 'all');
  await page.getByRole('button', { name: '图片', exact: true }).click();
  await page.mouse.move(0, 800);
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(2100);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await primary().hover();
  await page.waitForTimeout(180);
  const during = (await primary().boundingBox()).width;
  await assertFieldCentered();
  await page.waitForTimeout(300);
  const after = (await primary().boundingBox()).width;
  await assertFieldCentered();
  assert.ok(during > compactWidth + 1 && during < after - 1, 'opening passes through intermediate widths');
  await page.mouse.move(0, 800); await page.waitForTimeout(2500);
  assert.ok(Math.abs((await primary().boundingBox()).width - compactWidth) < 1, 'closing animation returns to icon width');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [1440, 1024, 736, 400, 320]) {
    await page.setViewportSize({ width, height: 900 });
    // Let the measured overflow settle after the container query changes tab width.
    await page.waitForTimeout(100);
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      const tabs = await primary().getByRole('tab').all();
      const boxes = await Promise.all(tabs.map(tab => tab.boundingBox()));
      assert.ok(boxes.every((box, i) => box.x >= 0 && box.x + box.width <= width && (!i || box.x >= boxes[i - 1].x + boxes[i - 1].width)), `separate tabs fit at ${width}`);
      const more = page.getByRole('button', { name: '更多素材库控件' });
      if (width >= 1024) assert.equal(await more.isVisible(), false, 'controls remain inline when their expanded width fits');
      if (await more.isVisible()) {
        if (await more.getAttribute('aria-expanded') !== 'true') await more.click();
        await page.getByRole('dialog', { name: '素材库控件', exact: true }).waitFor();
      }
      const media = page.getByRole('group', { name: '素材类型', exact: true });
      const bounds = await media.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, `media controls fit at ${width}`);
      await assertSelectionContrast(primary().getByRole('tab', { selected: true }));
      await assertSelectionContrast(media.getByRole('button', { pressed: true }));
      assert.equal(await page.getByRole('group', { name: '生成图显示模式', exact: true }).getByRole('button').count(), 1, 'one generated-image toggle');
      const filter = page.getByRole('button', { name: '不看生成图', exact: true });
      await filter.click();
      assert.equal(await filter.getAttribute('aria-pressed'), 'true');
      await page.waitForFunction(() => window.mode.getState().generatedFilter === 'source:!generated' && window.requests.some(r => r.command === 'catalog_overview' && r.args.filter.generated === false));
      await assertSelectionContrast(filter);
      await filter.click();
      await page.waitForFunction(() => window.mode.getState().generatedFilter === null && window.requests.some(r => r.command === 'catalog_overview' && r.args.filter.generated === null));
      await page.locator('.folder-media-card img').first().waitFor();
      await page.screenshot({ path: `${output}/${width}-${theme}.png` });
      if (await more.isVisible()) {
        await page.keyboard.press('Escape');
        assert.equal(await more.getAttribute('aria-expanded'), 'false');
        assert.equal(await more.evaluate(el => el === document.activeElement), true);
      }
      measurements.push({ width, theme, boxes });
    }
  }
  await page.evaluate(() => window.mode.getState().setGeneratedFilter('source:generated'));
  await page.waitForFunction(() => window.mode.getState().generatedFilter === null);
  await page.setViewportSize({ width: 1440, height: 900 });
  await primary().hover(); await page.waitForTimeout(150);
  await primary().getByRole('tab', { name: '标签分类', exact: true }).click();
  const scope = page.getByRole('tablist', { name: '标签素材范围', exact: true });
  await scope.waitFor();
  await page.screenshot({ path: `${output}/tag-scope-light.png` });
  await primary().getByRole('tab', { name: '标签分类', exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await scope.getByRole('tab', { selected: true }).evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Escape');
  assert.equal(await scope.count(), 0);
  await primary().getByRole('tab', { name: '全部素材', exact: true }).click();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.mouse.move(900, 200);
  const near = page.locator('.library-control-crosses').first();
  await near.waitFor();
  const first = await near.evaluate(el => getComputedStyle(el).transform);
  await page.mouse.move(1200, 400);
  await page.waitForTimeout(80);
  assert.notEqual(await near.evaluate(el => getComputedStyle(el).transform), first, 'depth matrix responds to pointer movement');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await near.evaluate(el => getComputedStyle(el).animationName), 'none');

  // Check the same shared controls in the production App, with isolated synthetic IPC.
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/library-creation-parity/preview.html?source-library&detail-route&canvas-library`);
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  const openLibrary = page.locator('.app-topbar').getByRole('button', { name: '打开素材库', exact: true });
  if (await openLibrary.isVisible()) await openLibrary.click();
  await primary().waitFor();
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.screenshot({ path: `${output}/app-canvas-${theme}.png` });
  }
  await page.getByRole('button', { name: '返回主页', exact: true }).click();
  await page.getByRole('navigation', { name: '首页' }).getByRole('button', { name: '素材库', exact: true }).click();
  await page.locator('.library-home [data-asset-id]').first().waitFor();
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.screenshot({ path: `${output}/app-home-${theme}.png` });
  }
  assert.deepEqual(errors, []);
  console.log('PASS projection controls: grouped tabs, selection contrast, responsive overflow, single generated toggle, scope keyboard and reduced motion');
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` });
  throw error;
} finally {
  await writeFile(`${output}/result.json`, JSON.stringify({ errors, measurements }, null, 2));
  await browser.close(); await server.close();
}
