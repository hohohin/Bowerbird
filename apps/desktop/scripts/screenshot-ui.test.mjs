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
async function selectionRect() { return page.locator('.snip-selection').evaluate(el => ({ x: Math.round(parseFloat(el.style.left) * 16), y: Math.round(parseFloat(el.style.top) * 12), width: Math.round(parseFloat(el.style.width) * 16), height: Math.round(parseFloat(el.style.height) * 12) })); }
async function loupePixel() { return page.locator('.snip-loupe canvas').evaluate(el => [...el.getContext('2d').getImageData(57, 57, 1, 1).data]); }
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
  // Odd-sized nearest-neighbour loupe: the labelled source pixel is its exact centre.
  await page.mouse.move(500, 150); await page.getByText('1000, 300 px', { exact: true }).waitFor();
  await page.getByText('#FF0000', { exact: true }).waitFor(); assert.deepEqual(await loupePixel(), [255, 0, 0, 255]);
  const initialPaints = await page.evaluate(() => window.basePaints);
  await page.keyboard.press('ArrowRight'); await page.getByText('1001, 300 px', { exact: true }).waitFor();
  await page.getByText('#00FF00', { exact: true }).waitFor(); assert.deepEqual(await loupePixel(), [0, 255, 0, 255]);
  assert.ok(await page.evaluate(() => window.calls.some(c => c.command === 'plugin:window|set_cursor_position' && c.args.value.position.x === 500.5 && c.args.value.position.y === 150)));
  await page.keyboard.press('a'); await page.getByText('1000, 300 px', { exact: true }).waitFor();
  await page.keyboard.down('w'); await page.keyboard.down('w'); await page.keyboard.up('w'); await page.getByText('1000, 298 px', { exact: true }).waitFor();
  await page.keyboard.press('s'); await page.keyboard.press('s'); await page.getByText('1000, 300 px', { exact: true }).waitFor();
  await page.keyboard.press('c');
  assert.ok(await page.evaluate(() => window.readbacks.some(r => r.canvasWidth === 1 && r.canvasHeight === 1)), 'colour sampling uses a one-pixel buffer');
  assert.equal(await page.evaluate(() => window.basePaints), initialPaints, 'cursor/loupe never repaint the full screenshot');
  // Loupe flips away from edges and clamps source reads at all four corners.
  for (const [x, y] of [[0, 0], [799, 0], [0, 599], [799, 599]]) {
    await page.mouse.move(x, y); await page.getByText(`${x * 2}, ${y * 2} px`, { exact: true }).waitFor();
    const box = await page.locator('.snip-loupe').boundingBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 800 && box.y + box.height <= 600);
  }
  // Retina fixture: the 400×300 CSS selection must export 800×600 source pixels.
  await drag(500, 380, 100, 80); await page.getByText('800 × 600', { exact: true }).waitFor();
  const originalRect = await selectionRect();
  await page.keyboard.press('ArrowRight'); assert.deepEqual(await selectionRect(), { ...originalRect, x: originalRect.x + 1 });
  // Real repeated keydown events must continue to move one source pixel per event.
  await page.keyboard.down('ArrowDown'); await page.keyboard.down('ArrowDown'); await page.keyboard.up('ArrowDown');
  assert.deepEqual(await selectionRect(), { ...originalRect, x: originalRect.x + 1, y: originalRect.y + 2 });
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp');
  for (const modifier of ['Control', 'Meta']) {
    await page.keyboard.press(`${modifier}+ArrowRight`); assert.equal((await selectionRect()).width, originalRect.width + 1);
    await page.keyboard.press('Shift+ArrowRight'); assert.deepEqual(await selectionRect(), originalRect);
  }
  await page.keyboard.press('Control+ArrowLeft'); assert.deepEqual(await selectionRect(), { ...originalRect, x: originalRect.x - 1, width: originalRect.width + 1 });
  await page.keyboard.press('Shift+ArrowLeft'); assert.deepEqual(await selectionRect(), originalRect);
  assert.equal(await page.evaluate(() => window.basePaints), initialPaints, 'selection movement never repaints pixels');
  await page.getByRole('button', { name: '复制截图', exact: true }).click();
  let exported = await output(); assert.equal(exported.action, 'copy');
  const base = exported.data; assert.deepEqual(await pixels(base), { width: 800, height: 600, pixel: [255, 255, 255, 255] });
  // All annotation tools produce pixels, undo returns byte-identical crop, redo restores them.
  for (const name of ['矩形', '椭圆', '箭头', '画笔', '马赛克']) {
    await page.getByRole('button', { name, exact: true }).click();
    const before = await page.evaluate(() => window.basePaints);
    await page.mouse.move(150, 160); await page.mouse.down(); await page.mouse.move(340, 260, { steps: 8 });
    await page.waitForFunction(() => document.querySelector('.snip-draft').width === 1600);
    assert.equal(await page.evaluate(() => window.basePaints), before, `${name} preview does not replay committed pixels`);
    await page.mouse.up();
    if (name === '矩形') {
      await page.mouse.move(200, 160); await page.keyboard.down('Alt');
      await page.getByText('#FF0000', { exact: true }).waitFor(); await page.keyboard.up('Alt');
      await page.getByRole('button', { name: '颜色 #4096ff', exact: true }).click(); await page.keyboard.press('c');
      assert.equal(await page.getByLabel('自定义颜色', { exact: true }).inputValue(), '#ff0000', 'C samples committed annotations as shown by the loupe');
    }
    const beforeExport = await page.evaluate(() => window.basePaints);
    await page.getByRole('button', { name: '复制截图', exact: true }).click();
    assert.equal(await page.evaluate(() => window.basePaints), beforeExport, 'export crops the cached composition');
    const drawn = (await output()).data; assert.notEqual(drawn, base, name);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    if (name === '矩形') {
      await page.keyboard.down('Alt'); await page.getByText('#FFFFFF', { exact: true }).waitFor(); await page.keyboard.up('Alt');
    }
    await page.getByRole('button', { name: '复制截图', exact: true }).click(); assert.equal((await output()).data, base, `${name} undo`);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await page.getByRole('button', { name: '复制截图', exact: true }).click(); assert.equal((await output()).data, drawn, `${name} redo`);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
  }
  await page.getByRole('button', { name: '文字', exact: true }).click();
  await page.getByRole('textbox', { name: '标注文字' }).fill('中文标注\nScreenshot'); await page.mouse.click(160, 190);
  await page.getByRole('button', { name: '复制截图', exact: true }).click(); assert.notEqual((await output()).data, base);
  const beforeTyping = await selectionRect();
  await page.getByRole('textbox', { name: '标注文字' }).focus(); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Control+ArrowRight'); await page.keyboard.type('wasd');
  assert.deepEqual(await selectionRect(), beforeTyping, 'text editing must not move selection');
  await page.getByRole('button', { name: '文字', exact: true }).click();
  await page.keyboard.down('Alt'); await page.locator('.snip-loupe').waitFor(); await page.keyboard.up('Alt'); await page.locator('.snip-loupe').waitFor({ state: 'hidden' });
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
  // Reuse the same mounted webview: cancel releases pixels and all editing state.
  await page.evaluate(() => window.nextSession(null));
  await page.waitForFunction(() => document.querySelector('.snip-stage canvas').width === 0);
  assert.equal(await page.getByRole('toolbar').count(), 0);
  await page.evaluate(() => window.nextSession('second'));
  await page.waitForFunction(() => window.calls.some(c => c.command === 'plugin:window|show' && c.args.session === 'second'));
  await drag(100, 80, 500, 380);
  assert.equal(await page.getByRole('button', { name: '撤销', exact: true }).isEnabled(), false);
  await page.getByRole('button', { name: '复制截图', exact: true }).click();
  assert.equal((await output()).data, base, 'reused window has fresh unmarked pixels');
  // A delayed old load cannot show after cancellation or replace a newer frame.
  await page.evaluate(async () => { window.imageDelay = 250; await window.nextSession('stale'); });
  await page.waitForFunction(() => window.calls.some(c => c.command === 'screenshot_image' && c.args.session === 'stale'));
  await page.evaluate(async () => { await window.nextSession(null); window.imageDelay = 0; await window.nextSession('latest'); });
  await page.waitForFunction(() => window.calls.some(c => c.command === 'plugin:window|show' && c.args.session === 'latest'));
  await page.waitForTimeout(350);
  assert.equal(await page.evaluate(() => window.calls.some(c => c.command === 'screenshot_show' && c.args.session === 'stale')), false);
  await page.goto(url + '?mode=warm');
  await page.waitForFunction(() => window.calls.some(c => c.command === 'screenshot_session'));
  assert.equal(await page.evaluate(() => window.calls.some(c => c.command === 'screenshot_image' || c.command === 'screenshot_show')), false);
  await page.evaluate(() => window.nextSession('first-warm'));
  await page.waitForFunction(() => window.calls.some(c => c.command === 'plugin:window|show' && c.args.session === 'first-warm'));
  // Fractional and unequal X/Y display scales must still resolve exact source pixels.
  for (const viewport of [{ width: 640, height: 480 }, { width: 800, height: 480 }]) {
    await page.setViewportSize(viewport); await page.mouse.move(1000 / 1600 * viewport.width, 300 / 1200 * viewport.height);
    await page.getByText('1000, 300 px', { exact: true }).waitFor(); await page.getByText('#FF0000', { exact: true }).waitFor();
    await page.keyboard.press('ArrowRight'); await page.getByText('1001, 300 px', { exact: true }).waitFor();
    assert.deepEqual(await loupePixel(), [0, 255, 0, 255]);
  }
  await page.setViewportSize({ width: 800, height: 600 });
  // Minimum one-pixel selection survives adjustment; no edge may escape the frame.
  await drag(0, 0, 1, 1);
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Control+ArrowLeft'); await page.keyboard.press('Control+ArrowUp');
  assert.deepEqual(await selectionRect(), { x: 0, y: 0, width: 2, height: 2 });
  await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowDown'); await page.keyboard.press('Shift+ArrowDown');
  assert.deepEqual(await selectionRect(), { x: 0, y: 0, width: 1, height: 1 });
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(async data => { const img = new Image(); img.src = data; await img.decode(); return img.width * img.height; }, (await output()).data), 1);
  await page.goto(url + '?mode=pin'); await page.getByAltText('置顶截图').waitFor();
  await page.getByTitle('原始尺寸', { exact: true }).click();
  assert.ok(await page.evaluate(() => window.calls.some(c => c.command === 'plugin:window|set_size' && c.args.value.size.width === 1600)));
  await page.getByTitle('复制', { exact: true }).click();
  await page.waitForFunction(() => window.calls.some(c => c.command === 'screenshot_output'));
  assert.equal((await pixels((await output()).data)).width, 1600);
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
  assert.deepEqual(errors, []); console.log('Screenshot UI passed: pixel-exact loupe/colour, edge flipping, Retina/fractional/unequal scales, native cursor IPC, repeated pixel nudges, expand/shrink/bounds/minimum size, text focus, cached base/draft rendering, Retina export, 6 tools, undo/redo, cancellation/retry, warm-window reuse/reset, stale-load rejection, pin, shortcut persistence/conflict.');
} catch (error) {
  await mkdir('.tmp/screenshot', { recursive: true });
  await page.screenshot({ path: '.tmp/screenshot/failure.png' });
  console.error(await page.evaluate(() => ({ loupe: document.querySelector('.snip-loupe')?.textContent, error: document.querySelector('.snip-error')?.textContent, viewport: [innerWidth, innerHeight], recentCalls: window.calls.slice(-4) })));
  throw error;
} finally { await browser.close(); await server.close(); }
