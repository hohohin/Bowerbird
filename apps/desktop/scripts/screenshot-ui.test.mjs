import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ server: { host: '127.0.0.1', port: 1579, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const errors = []; page.on('pageerror', e => errors.push(e.message));
const url = 'http://127.0.0.1:1579/scripts/fixtures/screenshot/preview.html';
async function drag(x1, y1, x2, y2) {
  await page.mouse.move(x1, y1); await page.mouse.down(); await page.mouse.move(x2, y2, { steps: 8 }); await page.mouse.up();
}
async function output() { return page.evaluate(() => window.calls.filter(c => c.command === 'screenshot_output').at(-1)?.args); }
async function pixels(data) {
  return page.evaluate(async data => {
    const image = new Image(); image.src = data; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    return { width: canvas.width, height: canvas.height, pixel: [...ctx.getImageData(20, 20, 1, 1).data] };
  }, data);
}
try {
  await page.goto(url); await page.waitForFunction(() => window.calls.some(c => c.command === 'plugin:window|show'));
  // Retina fixture: the 400×300 CSS selection must export 800×600 source pixels.
  await drag(500, 380, 100, 80); await page.getByText('800 × 600', { exact: true }).waitFor();
  await page.getByRole('button', { name: '复制截图', exact: true }).click();
  let exported = await output(); assert.equal(exported.action, 'copy');
  const base = exported.data; assert.deepEqual(await pixels(base), { width: 800, height: 600, pixel: [255, 255, 255, 255] });
  // All annotation tools produce pixels, undo returns byte-identical crop, redo restores them.
  for (const name of ['矩形', '椭圆', '箭头', '画笔', '马赛克']) {
    await page.getByRole('button', { name, exact: true }).click(); await drag(150, 160, 340, 260);
    await page.getByRole('button', { name: '复制截图', exact: true }).click();
    const drawn = (await output()).data; assert.notEqual(drawn, base, name);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await page.getByRole('button', { name: '复制截图', exact: true }).click(); assert.equal((await output()).data, base, `${name} undo`);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await page.getByRole('button', { name: '复制截图', exact: true }).click(); assert.equal((await output()).data, drawn, `${name} redo`);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
  }
  await page.getByRole('button', { name: '文字', exact: true }).click();
  await page.getByRole('textbox', { name: '标注文字' }).fill('中文标注\nScreenshot'); await page.mouse.click(160, 190);
  await page.getByRole('button', { name: '复制截图', exact: true }).click(); assert.notEqual((await output()).data, base);
  await page.getByRole('button', { name: '调整选区', exact: true }).click();
  await drag(250, 300, 300, 320); await page.getByText('800 × 600', { exact: true }).waitFor();
  // Resize a corner after moving selection.
  await drag(550, 400, 590, 420); await page.getByText('880 × 640', { exact: true }).waitFor();
  await page.evaluate(() => { window.cancelSave = true; }); await page.getByRole('button', { name: '保存截图', exact: true }).click();
  assert.equal((await output()).action, 'save'); await page.getByRole('toolbar').waitFor();
  await page.evaluate(() => { window.failOutput = true; }); await page.getByRole('button', { name: '复制截图', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '剪贴板暂时不可用' }).waitFor();
  await page.evaluate(() => { window.failOutput = false; }); await page.getByRole('button', { name: '置顶贴图', exact: true }).click();
  assert.equal((await output()).action, 'pin');
  await mkdir('.tmp/screenshot', { recursive: true }); await page.screenshot({ path: '.tmp/screenshot/editor.png' });
  await page.keyboard.press('Escape'); assert.ok(await page.evaluate(() => window.calls.some(c => c.command === 'screenshot_cancel')));
  await page.goto(url + '?mode=pin'); await page.getByAltText('置顶截图').waitFor();
  await page.getByTitle('原始尺寸', { exact: true }).click();
  assert.ok(await page.evaluate(() => window.calls.some(c => c.command === 'plugin:window|set_size' && c.args.value.size.width === 1600)));
  await page.getByTitle('复制', { exact: true }).click(); assert.equal((await pixels((await output()).data)).width, 1600);
  await page.getByTitle('关闭贴图', { exact: true }).click(); assert.ok(await page.evaluate(() => window.calls.some(c => c.command === 'plugin:window|close')));
  await page.goto(url + '?mode=settings'); const capture = page.getByRole('button', { name: '区域截图快捷键' });
  await capture.waitFor(); assert.equal(await capture.textContent(), 'F1');
  await capture.click(); await page.keyboard.press('Control+Shift+S'); await page.waitForFunction(() => window.settings.screenshot_shortcuts.capture === 'Control+Shift+KeyS');
  await page.evaluate(() => { window.conflict = true; }); await capture.click(); await page.keyboard.press('F6');
  await page.getByRole('alert').filter({ hasText: '已被占用' }).waitFor(); assert.equal(await capture.textContent(), 'Ctrl + Shift + S');
  await page.evaluate(() => { window.conflict = false; });
  await page.getByRole('button', { name: '停用', exact: true }).first().click(); await page.waitForFunction(() => window.settings.screenshot_shortcuts.capture === '');
  await page.getByRole('button', { name: '恢复默认', exact: true }).click(); await page.waitForFunction(() => window.settings.screenshot_shortcuts.capture === 'F1');
  await capture.click(); await page.keyboard.press('Escape'); assert.equal(await capture.textContent(), 'F1');
  await page.getByRole('button', { name: '立即截图', exact: true }).click();
  assert.ok(await page.evaluate(() => window.calls.some(c => c.command === 'screenshot_start')));
  await page.screenshot({ path: '.tmp/screenshot/settings.png' });
  assert.deepEqual(errors, []); console.log('Screenshot UI passed: Retina export, 6 tools, undo/redo, selection move/resize, cancellation, retry, pin, shortcut persistence/conflict.');
} finally { await browser.close(); await server.close(); }
