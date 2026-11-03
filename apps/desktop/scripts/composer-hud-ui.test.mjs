import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const output = '.tmp/composer-hud';
await mkdir(output, { recursive: true });
const server = await createServer({ cacheDir: `${output}/vite`, server: { host: '127.0.0.1', port: 18967, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
const url = `${server.resolvedUrls.local[0]}scripts/fixtures/library-creation-parity/preview.html?source-library&detail-route&canvas-library`;
const settle = () => page.waitForTimeout(400);
async function bottomGap(dock) {
  return dock.evaluate(element => innerHeight - element.getBoundingClientRect().bottom);
}
async function singleRow(dock) {
  const centers = await dock.locator('.composer-toolbar').evaluate(toolbar => [...toolbar.querySelectorAll('.composer-video-fields > *, .composer-add-material, .composer-help, .composer-send')]
    .map(element => element.getBoundingClientRect()).filter(rect => rect.width && rect.height).map(rect => rect.y + rect.height / 2));
  assert.ok(centers.every(center => Math.abs(center - centers[0]) < 1), `single footer row: ${centers}`);
}
try {
  await page.goto(url);
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await page.getByRole('button', { name: '返回主页', exact: true }).click();
  const home = page.locator('.library-composer .creation-dock');
  await home.waitFor(); await settle();
  assert.ok(Math.abs(await bottomGap(home)) < 1, 'inactive home composer touches the window bottom');
  await home.getByRole('button', { name: '展开创作描述', exact: true }).click();
  await home.locator('.ProseMirror').fill('清晨的薄雾掠过山脊，镜头缓慢推进。\n第二行内容仍保留在草稿中。');
  await home.getByRole('button', { name: '退出创作模式', exact: true }).click(); await settle();
  assert.ok(Math.abs(await bottomGap(home)) < 1);
  assert.equal(await home.locator('.composer-editor-scroll .collection-scroll-viewport').evaluate(element => element.clientHeight), 36);
  assert.match(await home.locator('.ProseMirror').innerText(), /清晨的薄雾/);
  await page.screenshot({ path: `${output}/home-rest.png` });
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await home.getByRole('button', { name: '展开创作描述', exact: true }).click();
    const motion = await home.evaluate(element => ({ name: getComputedStyle(element).animationName, filter: getComputedStyle(element).filter }));
    assert.equal(motion.name, 'composer-hud-rise'); assert.equal(motion.filter, 'none', 'text is never blurred');
    await settle();
    await home.getByRole('button', { name: '图片', exact: true }).click();
    await home.locator('.ProseMirror').fill('清晨的薄雾掠过山脊，镜头缓慢推进。'); await settle();
    const writingGap = await home.evaluate(element => element.querySelector('.ProseMirror').getBoundingClientRect().top - element.querySelector('.composer-heading').getBoundingClientRect().bottom);
    assert.ok(writingGap >= 0 && writingGap <= 18, `no extra decoration/title row above writing: ${writingGap}`);
    assert.equal(await home.locator('.composer-mode-status').isVisible(), true);
    if (theme === 'dark') {
      await home.getByRole('button', { name: '放大编辑文本', exact: true }).click();
      const document = page.getByRole('textbox', { name: '文档正文', exact: true });
      await document.waitFor(); assert.match(await document.innerText(), /清晨的薄雾/);
      await page.getByRole('button', { name: '返回', exact: true }).click();
      await document.waitFor({ state: 'detached' });
    }
    const project = home.getByRole('combobox', { name: '选择项目', exact: true });
    await project.click({ position: { x: 12, y: 6 } });
    const projects = page.getByRole('listbox', { name: '选择项目', exact: true });
    await projects.waitFor();
    assert.ok(await projects.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.top >= 0 && rect.right <= innerWidth; }));
    await page.keyboard.press('Escape'); await projects.waitFor({ state: 'detached' });
    assert.equal(await project.evaluate(element => element === document.activeElement), true, 'project tab restores focus');
    await project.press('Enter'); await projects.waitFor();
    const destination = await projects.getByRole('option').nth(1).innerText();
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    await projects.waitFor({ state: 'detached' });
    assert.equal(await project.innerText(), destination, 'project tab selects the keyboard destination');
    await project.press('Home'); await projects.waitFor(); await page.keyboard.press('Enter');
    await projects.waitFor({ state: 'detached' });
    assert.equal(await project.innerText(), '选择项目');
    await home.locator('.ProseMirror').focus(); await settle();
    assert.ok(await bottomGap(home) >= 12, 'expanded composer floats above the edge');
    await page.screenshot({ path: `${output}/home-${theme}.png` });
    const bounds = await home.boundingBox();
    await page.screenshot({ path: `${output}/hud-tabs-${theme}.png`, clip: { x: bounds.x - 20, y: bounds.y - 20, width: bounds.width + 40, height: Math.min(bounds.height + 40, 900 - bounds.y + 20) } });
    await home.getByRole('button', { name: '视频', exact: true }).click(); await settle();
    await home.locator('.ProseMirror').fill('清晨的薄雾掠过山脊，镜头缓慢推进。');
    for (const width of [1440, 900]) {
      await page.setViewportSize({ width, height: 900 }); await settle(); await singleRow(home);
      assert.ok(await home.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth; }));
      const headings = await home.locator('.composer-heading').evaluate(element => [...element.children].map(child => child.getBoundingClientRect()).filter(rect => rect.width && rect.height).map(rect => rect.y + rect.height / 2));
      assert.ok(headings.every(center => Math.abs(center - headings[0]) < 1), 'HUD tabs, project, profile and collapse control share one center line');
    }
    await home.locator('.model-select-trigger').click();
    const menu = page.getByRole('dialog', { name: '视频模型', exact: true });
    await menu.waitFor();
    assert.ok(await menu.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.top >= 0 && rect.right <= innerWidth; }));
    await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' });
    assert.equal(await home.locator('.model-select-trigger').evaluate(element => element === document.activeElement), true);
    await home.locator('.ProseMirror').focus();
    await page.mouse.move(20, 160); await settle();
    await home.screenshot({ path: `${output}/video-${theme}.png` });
    await page.setViewportSize({ width: 1440, height: 900 });
    await home.getByRole('button', { name: '退出创作模式', exact: true }).click(); await settle();
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await home.getByRole('button', { name: '展开创作描述', exact: true }).click();
  assert.equal(await home.evaluate(element => getComputedStyle(element).animationName), 'none');
  assert.equal(await home.locator('.composer-hud-acquire').evaluate(element => getComputedStyle(element).animationName), 'none');
  await home.getByRole('button', { name: '退出创作模式', exact: true }).click();
  assert.ok(Math.abs(await bottomGap(home)) < 1);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(url);
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  const canvas = page.locator('.canvas-workspace .creation-dock');
  await canvas.locator('.ProseMirror').fill('将光线、留白与材质组织成一个安静的镜头。'); await settle();
  assert.equal(await canvas.evaluate(element => getComputedStyle(element).animationName), 'composer-hud-rise');
  await page.screenshot({ path: `${output}/canvas.png` });
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');
  assert.match(await canvas.locator('.composer-hud-surface').evaluate(element => getComputedStyle(element).filter), /52, 70, 78/, 'only the decorative plane casts the lighter directional shadow');
  await page.screenshot({ path: `${output}/canvas-light.png` });
  await canvas.getByRole('button', { name: '视频', exact: true }).click();
  await page.setViewportSize({ width: 900, height: 900 }); await settle(); await singleRow(canvas);
  assert.ok(await canvas.locator('.composer-toolbar').evaluate(element => element.scrollWidth <= element.clientWidth), 'canvas footer does not overflow at 900px');
  await page.waitForTimeout(200);
  assert.equal(await canvas.locator('.composer-hud-acquire').evaluate(element => getComputedStyle(element).opacity), '0', 'edge motion settles without looping');
  assert.deepEqual(errors, []);
  console.log('PASS HUD home/canvas, project tab pointer/keyboard/Escape, bottom attachment, first-line draft, video single row, clear text and reduced motion');
} finally { await browser.close(); await server.close(); }
