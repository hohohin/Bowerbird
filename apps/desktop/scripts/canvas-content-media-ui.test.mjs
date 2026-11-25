import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/content-media-vite', server: { host: '127.0.0.1', port: 1648, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
const errors = [];
page.on('pageerror', error => errors.push(error.stack));
const card = page.locator('[data-canvas-node-id="media-table"]');
const saved = () => page.waitForFunction(() => !document.querySelector('.canvas-save-state.is-visible'));
const state = () => page.evaluate(() => window.snapshot().nodes.find(node => node.id === 'media-table'));
async function fitted() {
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.canvas-image-content')).every(content => {
    const row = content.closest('.canvas-text-row');
    return content.getBoundingClientRect().height <= row.getBoundingClientRect().height + 1;
  }));
  await saved();
}
try {
  await page.goto('http://127.0.0.1:1648/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(() => {
    const snapshot = window.snapshot();
    const text = (id, value = '') => ({ id, text: value, content_type: 'text', bold: false, italic: false, align: 'left' });
    const media = (id, assets) => ({ ...text(id), content_type: 'image', image_refs: assets.map((asset_id, i) => ({ asset_id, token: `@图片${i + 1}` })) });
    snapshot.nodes = [{ ...snapshot.nodes[0], id: 'media-table', kind: 'note', assetId: null, role: null, x: 130, y: 80, width: 640, height: 300,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', text: '', member_ids: [], row_heights: [1, 1], column_widths: [1, 1],
        cells: [[media('portrait', ['b']), media('video', ['video'])], [media('multiple', ['a', 'video-no-poster']), { ...text('plain', '**原样文字** @图片1'), image_refs: [{ asset_id: 'a', token: '@图片1' }] }]] }) }];
    snapshot.groups = []; snapshot.groupItems = []; snapshot.edges = [];
    snapshot.view = { ...snapshot.view, panX: 30, panY: 25, zoom: 0.65 };
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
    sessionStorage.setItem('canvas-media-dimensions', '1');
    const poster = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#0d9488"/></svg>')}`;
    sessionStorage.setItem('reference-drafts', JSON.stringify([
      { id: 'video', name: '合成视频', ext: 'mp4', store_path: '/synthetic/video.mp4', thumb_path: poster, width: 640, height: 360 },
      { id: 'video-no-poster', name: '无封面视频', ext: 'mp4', store_path: '/synthetic/no-poster.mp4', width: 640, height: 360 },
    ]));
  });
  await page.reload();
  await card.waitFor();
  await card.locator('.canvas-image-preview img').first().waitFor();
  await fitted();
  const portrait = card.locator('[data-canvas-cell="portrait"] img');
  const dimensions = await portrait.boundingBox();
  assert.ok(Math.abs(dimensions.height / dimensions.width - 4) < 0.02, 'portrait keeps source ratio');
  assert.ok(dimensions.height > 500, 'portrait is not capped at the old 170px height');
  assert.ok((await state()).height > 1000, 'card grows to contain its media');
  const scrollbars = await card.locator('.canvas-image-content').evaluateAll(elements => elements.map(element => ({
    overflow: getComputedStyle(element).overflowY, client: element.clientHeight, scroll: element.scrollHeight,
  })));
  assert.ok(scrollbars.every(item => item.overflow !== 'auto' && item.scroll <= item.client + 1), 'no inner media scrollers');
  const stack = card.locator('[data-canvas-cell="multiple"] .canvas-image-preview');
  const first = await stack.nth(0).boundingBox(), second = await stack.nth(1).boundingBox();
  assert.ok(second.y >= first.y + first.height, 'multiple media expand in separate complete rows');
  assert.equal(await card.locator('[data-canvas-cell="video"] img').getAttribute('src').then(src => src.startsWith('data:image/svg+xml')), true);
  assert.equal(await card.getByRole('button', { name: '播放视频：无封面视频', exact: true }).count(), 1);

  // Asset context must not inherit the library's managed selection or target the note.
  await page.evaluate(() => window.store.setState({ mode: 'manage', selectedIds: new Set(['a', 'b']) }));
  await portrait.click({ button: 'right' });
  let menu = await page.evaluate(() => window.store.getState().contextMenu);
  assert.equal(menu.assetId, 'b'); assert.equal(menu.singleAsset, true); assert.deepEqual(menu.canvasSelection.nodeIds, []); assert.deepEqual(menu.canvasSelection.assetIds, ['b']);
  await page.getByRole('menuitem', { name: '打开图片详情', exact: true }).waitFor();
  await page.getByRole('menuitem', { name: '添加到对话框', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await card.getByRole('button', { name: '播放视频：合成视频', exact: true }).click({ button: 'right' });
  menu = await page.evaluate(() => window.store.getState().contextMenu);
  assert.equal(menu.assetId, 'video');
  await page.getByRole('menuitem', { name: '用系统程序打开', exact: true }).click();
  assert.ok(await page.evaluate(() => window.calls.some(call => call.command === 'open_path_with_system' && call.args.path === '/synthetic/video.mp4')));
  await card.locator('[data-canvas-cell="plain"] [data-asset-id="a"]').click({ button: 'right' });
  assert.equal(await page.evaluate(() => window.store.getState().contextMenu.assetId), 'a', 'inline reference gets its media menu');
  await page.keyboard.press('Escape');
  await card.locator('.canvas-text-handle').click({ button: 'right' });
  assert.equal(await page.evaluate(() => window.store.getState().contextMenu), null, 'card background retains the card menu');
  assert.equal(await page.getByRole('menu').count(), 1);
  await page.keyboard.press('Escape');
  const original = await state();
  await page.evaluate(() => { window.store.setState({ mode: 'browse' }); window.save(); });
  await page.reload();
  await card.waitFor(); await fitted();
  assert.ok(Math.abs((await state()).height - original.height) < 1, 'reload does not repeatedly grow media rows');
  assert.deepEqual(JSON.parse((await state()).payloadJson).cells, JSON.parse(original.payloadJson).cells, 'layout preserves cell identities and source text');

  // Wider columns require more image height; resizing grows the row and persists the fit.
  await card.locator('.canvas-text-handle').click();
  const handle = card.getByRole('separator', { name: '调整第 1 列宽度', exact: true });
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 45, box.y + box.height / 2, { steps: 6 }); await page.mouse.up();
  await fitted();
  assert.ok((await state()).height > original.height + 100, 'row follows changed media width at canvas zoom');
  const stable = (await state()).height;
  await page.waitForTimeout(250);
  assert.ok(Math.abs((await state()).height - stable) < 1, 'media fitting converges');
  // A cancelled whole-card resize must not persist auto-fit geometry or weights.
  await page.getByRole('button', { name: '适应内容', exact: true }).click();
  await card.locator('.canvas-text-handle').click();
  await fitted();
  const beforeCancel = await state();
  const knob = await card.getByRole('button', { name: '调整内容卡片大小', exact: true }).boundingBox();
  await page.mouse.move(knob.x + knob.width / 2, knob.y + knob.height / 2); await page.mouse.down();
  await page.mouse.move(knob.x + knob.width / 2 + 100, knob.y + knob.height / 2, { steps: 6 });
  await page.waitForTimeout(120);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await fitted();
  assert.equal((await state()).width, beforeCancel.width);
  assert.equal((await state()).height, beforeCancel.height);
  assert.deepEqual(JSON.parse((await state()).payloadJson).row_heights, JSON.parse(beforeCancel.payloadJson).row_heights);
  await page.evaluate(() => window.save()); await page.reload(); await card.waitFor(); await fitted();
  assert.equal((await state()).width, beforeCancel.width);
  assert.ok(Math.abs((await state()).height - beforeCancel.height) < 1);
  // Media gestures use the same reference event and preview as standalone images.
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    api.generationHistory = async () => ({ turns: [], references: [] });
    window.picked = [];
    window.addEventListener('bowerbird://board-asset-picked', event => window.picked.push(event.detail));
    window.store.setState({ boardOpen: true, mode: 'browse' });
  });
  await portrait.dblclick();
  assert.deepEqual(await page.evaluate(() => window.picked), ['b']);
  await page.waitForTimeout(600);
  assert.equal(await page.getByRole('dialog', { name: '图片与生成记录预览' }).count(), 0);
  await portrait.click();
  await page.waitForTimeout(800);
  await page.getByRole('dialog', { name: '图片与生成记录预览' }).waitFor();
  await page.keyboard.press('Escape');
  await portrait.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '添加到对话框', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.picked), ['b', 'b']);
  await page.evaluate(() => window.store.setState({ boardOpen: false }));

  const socket = card.locator('[data-canvas-cell="portrait"] .canvas-cell-connection.is-output');
  await portrait.hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-canvas-cell="portrait"] .canvas-cell-connection')).opacity === '1');
  const rect = await socket.boundingBox();
  const zoom = await socket.evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el.closest('.canvas-plane')).transform).a);
  assert.ok(Math.abs(rect.width - 28 * zoom) < .1 && Math.abs(rect.height - 32 * zoom) < .1, 'cell hit box scales with the canvas');
  await socket.click();
  const downstream = page.getByRole('menu', { name: '添加下游', exact: true });
  await downstream.waitFor();
  assert.equal(await card.locator('[data-canvas-cell="portrait"][data-canvas-connection-source="output"]').count(), 1);
  await downstream.getByRole('menuitem', { name: '图片生成', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.some(node => node.inputs.image?.some(input => input.cellId === 'portrait')));
  const input = card.locator('[data-canvas-cell="portrait"] .canvas-cell-connection.is-input');
  await input.focus(); await input.press('Enter');
  await page.getByRole('menu', { name: '添加上游', exact: true }).waitFor();
  assert.equal(await card.locator('[data-canvas-cell="portrait"][data-canvas-connection-source="input"]').count(), 1);
  await page.getByRole('menu', { name: '添加上游', exact: true }).getByRole('menuitem', { name: '图片生成', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.some(node => node.textTarget?.cellId === 'portrait'));
  await portrait.hover();
  const start = await socket.boundingBox();
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2); await page.mouse.down();
  await page.waitForTimeout(220);
  await page.locator('.workflow-wires .is-draft').waitFor({ state: 'attached' });
  assert.equal(await card.locator('[data-canvas-cell="portrait"][data-canvas-connection-dragging="output"]').count(), 1);
  const anchor = await page.locator('.workflow-wires .is-draft').evaluate(path => {
    const point = path.getPointAtLength(0), screen = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM());
    const cell = document.querySelector('[data-canvas-cell="portrait"]').getBoundingClientRect();
    return { x: screen.x - cell.right, y: screen.y - (cell.top + cell.height / 2) };
  });
  assert.ok(Math.abs(anchor.x) < 2 && Math.abs(anchor.y) < 2, 'draft starts at the cell edge');
  await page.keyboard.press('Escape'); await page.mouse.up();
  await page.waitForFunction(() => !document.querySelector('.canvas-plane[data-canvas-connecting]'));

  await portrait.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '移出画布', exact: true }).click();
  await page.waitForFunction(() => !JSON.parse(window.snapshot().nodes.find(node => node.id === 'media-table').payloadJson).cells[0][0].image_refs.length);
  assert.equal(JSON.parse((await state()).payloadJson).cells[0][1].image_refs[0].asset_id, 'video', 'removing a cell image preserves the table and other cells');
  await mkdir('.tmp/content-media', { recursive: true });
  await page.screenshot({ path: '.tmp/content-media/expanded.png' });

  // Keep the same textarea mounted while a preceding image column is removed and restored.
  await page.evaluate(() => {
    const snapshot = window.snapshot();
    const node = snapshot.nodes.find(item => item.id === 'media-table');
    const value = JSON.parse(node.payloadJson);
    const fields = (id, text) => ({ id, text, content_type: 'text' });
    value.cells = [
      [{ id: 'mixed-image', text: '', content_type: 'image' }, fields('first', '第一格'), fields('second', '第二格')],
      [fields('middle-first', '中行首格'), fields('middle-second', '中行第二格'), fields('middle-third', '中行第三格')],
      [fields('last-first', '末行首格'), fields('last-second', '末行第二格'), fields('target', '目标格')],
    ];
    delete value.row_heights;
    delete value.column_widths;
    node.height = 360;
    node.payloadJson = JSON.stringify(value);
    sessionStorage.removeItem('workflow-p');
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
  });
  await page.reload();
  const field = card.locator('[data-canvas-cell="target"] textarea');
  await field.focus();
  await field.evaluate(element => { window.originalField = element; });
  const remove = async (axis, position) => {
    const control = card.getByRole('button', { name: `删除第 ${position} ${axis}`, exact: true });
    await control.hover();
    await control.click();
  };
  async function checkFocus(label) {
    await page.waitForFunction(() => document.activeElement?.closest('[data-canvas-cell]')?.dataset.canvasCell === 'target');
    assert.equal(await field.getAttribute('aria-label'), label);
    assert.equal(await field.inputValue(), '目标格');
    assert.equal(await field.evaluate(element => element === window.originalField), true);
  }
  const undo = card.getByRole('button', { name: '撤销删除行列', exact: true });
  await remove('行', 2);
  await checkFocus('第 2 行第 3 列');
  await undo.click();
  await checkFocus('第 3 行第 3 列');
  await remove('列', 1);
  await checkFocus('第 3 行第 2 列');
  await undo.click();
  await checkFocus('第 3 行第 3 列');
  await remove('列', 2);
  await checkFocus('第 3 行第 2 列');
  await undo.click();
  await checkFocus('第 3 行第 3 列');

  assert.deepEqual(errors, []);
  console.log('PASS cell ports and media, fit/reload/resize, and stable mixed-table focus after row/column deletions and undo');
} finally {
  await browser.close();
  await server.close();
}
