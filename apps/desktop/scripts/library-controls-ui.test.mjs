import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const output = '.tmp/library-controls';
const server = await createServer({ cacheDir: `${output}/vite`, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const reports = [], errors = [];
async function scenario(name, run) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 840 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(5000);
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  try { await run(page); reports.push({ name, passed: true }); }
  catch (e) { reports.push({ name, passed: false, error: e.stack }); }
  finally { await page.close(); }
}
try {
  await mkdir(output, { recursive: true });
  await scenario('canvas toolbar opens its existing library before showing connect', async page => {
    await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/canvas-reference/preview.html?source-library&local-files`);
    await page.locator('[data-canvas-node-id="old"]').waitFor();
    const topbar = page.locator('.app-topbar');
    assert.equal(await topbar.getByRole('button', { name: '建立连接', exact: true }).count(), 0);
    const open = topbar.getByRole('button', { name: '打开素材库', exact: true });
    await open.click();
    await page.waitForFunction(() => window.store.getState().canvasLibraryOpen);
    assert.equal(await page.locator('.canvas-source-panel').getAttribute('aria-hidden'), 'false');
    const close = topbar.getByRole('button', { name: '收起素材库', exact: true });
    const connect = topbar.getByRole('button', { name: '建立连接', exact: true });
    await connect.waitFor();
    const bounds = await close.boundingBox(), next = await connect.boundingBox();
    assert.ok(next.x > bounds.x && next.x - bounds.x - bounds.width < 20, 'connect is adjacent to library');
    await page.screenshot({ path: `${output}/canvas-open-dark.png` });
    await close.click();
    await page.waitForFunction(() => !window.store.getState().canvasLibraryOpen);
    assert.equal(await connect.count(), 0);
    await open.focus(); await page.keyboard.press('Enter'); await connect.waitFor();
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.screenshot({ path: `${output}/canvas-open-light.png` });
    await page.evaluate(() => window.setToolbarCanvasMode(false));
    await connect.waitFor();
    assert.equal(await topbar.getByRole('button', { name: '打开素材库', exact: true }).count(), 0);
  });
  await scenario('narrow collection names reclaim action width until hover, focus or menu', async page => {
    await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/connected-collections/preview.html`);
    const row = page.locator('[data-collection-id="child"]');
    await row.waitFor();
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: '重命名集合', exact: true }).click();
    await page.getByRole('textbox', { name: '集合名称' }).fill('城市建筑与街景参考素材');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await row.getByText('城市建筑与街景参考素材').waitFor();
    const resize = page.getByRole('separator', { name: '调整集合侧栏宽度' });
    await resize.focus();
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft');
    await page.mouse.move(1250, 0);
    const text = row.locator('.catalog-tree-name');
    const padding = () => text.evaluate(el => parseFloat(getComputedStyle(el).paddingRight));
    assert.equal(await padding(), 0, 'hidden actions do not truncate the label early');
    assert.equal(await row.locator('.catalog-tree-row-actions').evaluate(el => getComputedStyle(el).opacity), '0');
    const idleWidth = await text.evaluate(el => el.clientWidth - parseFloat(getComputedStyle(el).paddingRight));
    await page.screenshot({ path: `${output}/collection-idle-dark.png` });
    await row.hover();
    assert.equal(await padding(), 48);
    assert.equal(idleWidth - await text.evaluate(el => el.clientWidth - parseFloat(getComputedStyle(el).paddingRight)), 48);
    await page.screenshot({ path: `${output}/collection-hover-dark.png` });
    await row.getByRole('button', { name: /更多操作/ }).click();
    await page.getByRole('menu').waitFor();
    await page.mouse.move(1250, 0);
    assert.equal(await row.locator('.catalog-tree-row-actions').evaluate(el => getComputedStyle(el).opacity), '1', 'open menu keeps its trigger visible');
    await page.keyboard.press('Escape');
    await resize.focus();
    assert.equal(await padding(), 0);
    await row.getByRole('button', { name: /新建集合/ }).focus();
    assert.equal(await padding(), 48, 'keyboard focus reveals controls');
    await resize.focus();
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.screenshot({ path: `${output}/collection-idle-light.png` });
    assert.equal(await padding(), 0);
  });
  await writeFile(`${output}/result.json`, JSON.stringify({ reports, errors }, null, 2));
  reports.forEach(report => console.log(`${report.passed ? 'PASS' : 'FAIL'} ${report.name}${report.error ? `: ${report.error}` : ''}`));
  assert.deepEqual(errors, []);
  assert.ok(reports.every(report => report.passed));
} finally { await browser.close(); await server.close(); }
