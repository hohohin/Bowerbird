import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ server: { host: '127.0.0.1', port: 1599, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const origin = 'http://127.0.0.1:1599';

async function drag(x1, y1, x2, y2) {
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 5 });
  await page.mouse.up();
}

async function expectDock(anchor, toolbar, placement, container = null) {
  await anchor.waitFor();
  await toolbar.waitFor();
  const target = await anchor.boundingBox();
  const bar = await toolbar.boundingBox();
  const area = container ? await container.boundingBox() : { x: 0, y: 0, ...page.viewportSize() };
  const minX = area.x + 8;
  const minY = area.y + 8;
  const maxX = area.x + area.width - 8 - bar.width;
  const maxY = area.y + area.height - 8 - bar.height;
  const right = target.x + target.width;
  const bottom = target.y + target.height;
  const left = right - bar.width - (placement === 'inside' ? 8 : 0);
  const top = placement === 'below' ? bottom + 8 : placement === 'above' ? target.y - bar.height - 8 : bottom - bar.height - 8;
  assert.ok(Math.abs(bar.x - Math.max(minX, Math.min(maxX, left))) < 1, `${placement}: right alignment with horizontal safety margin`);
  assert.ok(Math.abs(bar.y - Math.max(minY, Math.min(maxY, top))) < 1, `${placement}: vertical docking with safety margin`);
  return bar;
}

try {
  await page.goto(`${origin}/scripts/fixtures/screenshot/preview.html`);
  await page.waitForFunction(() => window.calls.some(call => call.command === 'plugin:window|show'));
  const selection = page.locator('.snip-selection');
  const snipToolbar = page.getByRole('toolbar', { name: '截图工具' });
  await drag(8, 80, 98, 200);
  assert.equal((await expectDock(selection, snipToolbar, 'below')).x, 8, 'a narrow crop near the left edge preserves the viewport margin');
  await drag(160, 120, 760, 350);
  const before = await expectDock(selection, snipToolbar, 'below');
  await page.keyboard.press('ArrowRight');
  const nudged = await expectDock(selection, snipToolbar, 'below');
  assert.ok(Math.abs(nudged.x - before.x - 0.5) < 0.02, 'one source-pixel nudge updates the dock in a 2× viewport');

  await drag(80, 140, 760, 600 - 21 - before.height);
  await expectDock(selection, snipToolbar, 'below');
  await snipToolbar.getByRole('button', { name: '矩形', exact: true }).click();
  await page.waitForFunction(() => {
    const toolbar = document.querySelector('.snip-toolbar').getBoundingClientRect();
    const selection = document.querySelector('.snip-selection').getBoundingClientRect();
    return toolbar.bottom < selection.top;
  });
  assert.ok((await expectDock(selection, snipToolbar, 'above')).height > before.height, 'the expanded options row triggers a flip');

  await snipToolbar.getByRole('button', { name: '调整选区', exact: true }).click();
  await page.mouse.move(760, 600 - 21 - before.height);
  await page.mouse.down();
  await snipToolbar.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.snip-toolbar').evaluate(toolbar => getComputedStyle(toolbar).pointerEvents), 'none');
  await page.mouse.move(766, 580, { steps: 4 });
  await page.mouse.up();
  await expectDock(selection, snipToolbar, 'above');
  await drag(0, 0, 799, 599);
  await expectDock(selection, snipToolbar, 'inside');

  await page.setViewportSize({ width: 1040, height: 780 });
  await page.goto(`${origin}/scripts/fixtures/canvas-reference/preview.html`);
  await page.waitForFunction(() => window.store);
  await page.evaluate(() => window.store.getState().openDraftAnnotator(async (_data, meta) => { window.cropOutput = meta.image; }));
  const dialog = page.getByRole('dialog', { name: '草稿' });
  await dialog.locator('img').waitFor();
  const overlay = dialog.locator('svg.cursor-crosshair');
  const stage = dialog.locator('.annotation-stage');
  const cropFrame = overlay.locator('rect[stroke="#ffffff"]');
  const cropToolbar = dialog.getByRole('toolbar', { name: '裁剪操作' });
  const ratios = cropToolbar.getByRole('combobox', { name: '裁剪比例' });
  await dialog.getByRole('button', { name: '裁剪', exact: true }).click();
  const initialCropBar = await expectDock(cropFrame, cropToolbar, 'below', stage);
  await page.mouse.move(500, 300);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(480, 310, { steps: 4 });
  await page.mouse.up({ button: 'middle' });
  const pannedCropBar = await expectDock(cropFrame, cropToolbar, 'below', stage);
  assert.ok(Math.abs(pannedCropBar.x - initialCropBar.x + 20) < 1, 'panning moves the crop toolbar with the image');

  async function selectRatio(name) {
    await ratios.click();
    await page.getByRole('option', { name, exact: true }).click();
    await ratios.getByText(name, { exact: true }).waitFor();
  }
  async function expectRatio(ratio) {
    const { width, height } = await cropFrame.evaluate(frame => {
      const { width, height } = frame.ownerSVGElement.viewBox.baseVal;
      return { width: frame.width.baseVal.value / width * 1600, height: frame.height.baseVal.value / height * 1200 };
    });
    assert.ok(Math.abs(width - height * ratio) < 0.01, `crop ratio ${ratio} is preserved in source pixels (${width} × ${height})`);
  }
  await selectRatio('1:1');
  await expectRatio(1);
  const handle = await overlay.locator('rect[fill="#ffffff"]').first().boundingBox();
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await cropToolbar.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.annotation-crop-toolbar').evaluate(toolbar => getComputedStyle(toolbar).pointerEvents), 'none');
  await page.mouse.move(x + 95, y + 52, { steps: 5 });
  await page.mouse.up();
  await cropToolbar.waitFor();
  await expectRatio(1);

  await selectRatio('16:9');
  await expectRatio(16 / 9);
  const image = await overlay.boundingBox();
  await drag(image.x + 12, image.y + 12, image.x + 440, image.y + 210);
  await expectRatio(16 / 9);
  await selectRatio('原图比例');
  await expectRatio(4 / 3);
  await selectRatio('自由');
  await cropToolbar.getByRole('button', { name: '取消裁剪', exact: true }).click();
  await cropToolbar.waitFor({ state: 'hidden' });
  assert.ok(await dialog.isVisible());
  await dialog.getByRole('button', { name: '裁剪', exact: true }).click();
  await selectRatio('3:4');
  await cropToolbar.getByRole('button', { name: '应用裁剪', exact: true }).click();
  await dialog.getByRole('button', { name: '保存到画板', exact: true }).click();
  await page.waitForFunction(() => window.cropOutput);
  const { width, height } = await page.evaluate(() => window.cropOutput);
  assert.ok(Math.abs(width - height * 3 / 4) <= 1, `locked ratio is exported (${width} × ${height})`);

  console.log('PASS selection and crop toolbars dock, flip, stay in bounds, hide during dragging, and preserve locked crop ratios');
} finally {
  await browser.close();
  await server.close();
}
