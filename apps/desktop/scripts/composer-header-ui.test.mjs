import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
const { chromium } = await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE || '../../html-renderer/node_modules/playwright/index.mjs');
const server = await createServer({ cacheDir: '.tmp/composer-header/vite', server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const failures = [];
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await mkdir('.tmp/composer-header', { recursive: true });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/local-chat/preview.html`);
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  // This fixture predates the App-level theme imports; use the same final CSS layers as the real App.
  await page.evaluate(async () => { await import('/src/components/IndustrialTheme.css'); await import('/src/components/IndustrialCanvas.css'); });
  const dock = page.locator('.creation-dock');
  await page.getByRole('button', { name: '展开创作描述', exact: true }).click();
  if (await page.getByRole('button', { name: '项目对话记录', exact: true }).count()) failures.push('画布右上方仍存在重复对话记录入口');
  for (const width of [1440, 900, 640]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const positions = [];
    for (const name of ['图片', '视频', '对话']) {
      await page.getByRole('group', { name: '创作方式' }).getByRole('button', { name, exact: true }).click();
      // Compare settled positions, after the existing composer mode transition.
      await page.waitForTimeout(400);
      const button = dock.getByRole('button', { name: '退出创作模式', exact: true });
      const box = await button.boundingBox();
      const bounds = await dock.boundingBox();
      positions.push({ name, right: bounds.x + bounds.width - box.x - box.width, top: box.y - bounds.y });
      const modes = await dock.locator('.composer-mode-picker > button').evaluateAll(buttons => buttons.map(button => {
        const rect = button.getBoundingClientRect(); return { x: rect.x, y: rect.y, bottom: rect.bottom };
      }));
      if (!modes.every((mode, index) => Math.abs(mode.x - modes[0].x) < 1 && (!index || mode.y >= modes[index - 1].bottom))) failures.push(`${width}/${theme}/${name}: modes are not a vertical rail`);
      if (await dock.locator('.composer-mode-status').count()) failures.push(`${width}/${theme}/${name}: redundant creation status remains`);
    }
    if (positions.some(p => Math.abs(p.right - positions[0].right) > 1 || Math.abs(p.top - positions[0].top) > 1)) failures.push(`${width}/${theme}: ${JSON.stringify(positions)}`);
    await dock.locator('.ProseMirror').fill('保留的对话草稿');
    await dock.getByRole('button', { name: '退出创作模式', exact: true }).click();
    await page.waitForFunction(element => element.classList.contains('is-collapsed'), await dock.elementHandle());
    assert.equal(await dock.locator('.ProseMirror').innerText(), '保留的对话草稿');
    await dock.getByRole('button', { name: '展开创作描述', exact: true }).click();
    await dock.getByRole('button', { name: '打开对话记录', exact: true }).click();
    await page.locator('.canvas-chat-history').waitFor();
    await page.getByRole('button', { name: '关闭对话历史', exact: true }).click();
    await page.screenshot({ path: `.tmp/composer-header/${width}-${theme}.png` });
  }
  assert.deepEqual(failures, []);
  assert.deepEqual(errors, []);
  console.log('PASS: vertical mode rail and stable top-right close at three widths in both themes; one history entry, collapse and draft preserved');
} finally { await browser.close(); await server.close(); }
