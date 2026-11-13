import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/canvas-edit-undo/vite', server: { host: '127.0.0.1', port: 17943, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
page.setDefaultTimeout(10000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
const card = id => page.locator(`[data-canvas-node-id="${id}"]`);
const undo = () => page.getByRole('button', { name: '撤销画布操作', exact: true }).click();
const note = () => page.evaluate(() => JSON.parse(window.snapshot().nodes.find(n => n.id === 'content').payloadJson));
const saved = predicate => page.waitForFunction(predicate);
try {
  await page.goto('http://127.0.0.1:17943/scripts/fixtures/canvas-reference/preview.html');
  await card('old').waitFor();
  await page.evaluate(() => {
    const snapshot = window.snapshot(), base = snapshot.nodes[0];
    snapshot.nodes = [{ ...base, id: 'content', kind: 'note', assetId: null, role: null, x: 150, y: 150, width: 600, height: 380,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', text: '\t原文字\n第二行\t保留', member_ids: [],
        cells: [[{ id: 'image-cell', text: '', content_type: 'image', image_refs: [{ token: '图1', asset_id: 'a' }] }, { id: 'text-cell', text: '原文字' }],
          [{ id: 'row2-a', text: '第二行' }, { id: 'row2-b', text: '保留' }]] }) },
      { ...base, id: 'image-a', assetId: 'b', x: 900, y: 200 }, { ...base, id: 'image-b', assetId: 'c', x: 1200, y: 200 }];
    snapshot.edges = []; snapshot.view = { ...snapshot.view, panX: 0, panY: 0, zoom: 1 };
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
  });
  await page.reload(); await card('content').waitFor();
  const snap = page.getByRole('button', { name: '吸附对齐', exact: true });
  if (await snap.getAttribute('aria-pressed') === 'true') await snap.click();
  const original = await note();
  const name = page.locator('[data-card-name="content"] input');
  const originalName = await name.inputValue();
  await name.fill('可以撤销的名称'); await name.press('Enter');
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.cardNames.content === '可以撤销的名称');
  await undo();
  await page.waitForFunction(expected => document.querySelector('[data-card-name="content"] input').value === expected, originalName);
  await card('content').getByRole('button', { name: '清空第 1 行第 1 列图片', exact: true }).click({ force: true });
  await saved(() => !JSON.parse(window.snapshot().nodes.find(n => n.id === 'content').payloadJson).cells[0][0].image_refs.length);
  await card('content').getByRole('textbox', { name: '第 1 行第 1 列', exact: true }).focus();
  await page.keyboard.press('Control+z');
  await saved(() => JSON.parse(window.snapshot().nodes.find(n => n.id === 'content').payloadJson).cells[0][0].image_refs?.length === 1);
  assert.deepEqual((await note()).cells, original.cells, 'cleared image restored while the new text cell has focus');
  assert.equal(await card('content').locator('[data-canvas-cell="image-cell"] img').count(), 1);

  await page.evaluate(() => {
    const bridge = window.__TAURI_INTERNALS__, invoke = bridge.invoke;
    window.undoWriteCount = window.calls.filter(call => call.command === 'project_canvas_note_update').length;
    let fail = true;
    bridge.invoke = (command, args) => {
      if (fail && command === 'project_canvas_note_update') { fail = false; return Promise.reject(new Error('isolated write failure')); }
      return invoke(command, args);
    };
  });
  await card('content').getByRole('button', { name: '清空第 1 行第 1 列图片', exact: true }).click({ force: true });
  await page.getByRole('button', { name: '重试保存画板', exact: true }).waitFor();
  await undo(); await page.getByRole('button', { name: '重试保存画板', exact: true }).click();
  await saved(() => window.calls.filter(call => call.command === 'project_canvas_note_update').length >= window.undoWriteCount + 2);
  assert.deepEqual((await note()).cells, original.cells, 'retry preserves clear-then-undo write ordering');

  await card('content').getByRole('textbox', { name: '第 1 行第 2 列', exact: true }).fill('修改文字');
  await card('content').getByRole('button', { name: '加粗', exact: true }).click();
  await undo();
  assert.equal((await note()).cells[0][1].bold, undefined);
  await undo();
  assert.equal((await note()).cells[0][1].text, '原文字');

  await card('content').getByRole('button', { name: '删除第 2 行', exact: true }).click({ force: true });
  await saved(() => JSON.parse(window.snapshot().nodes.find(n => n.id === 'content').payloadJson).cells.length === 1);
  await page.keyboard.press('Control+z');
  await saved(() => JSON.parse(window.snapshot().nodes.find(n => n.id === 'content').payloadJson).cells.length === 2);
  assert.deepEqual((await note()).cells, original.cells, 'row deletion restored from focused textarea');
  await card('content').getByRole('button', { name: '在第 3 列位置插入', exact: true }).click({ force: true });
  await saved(() => JSON.parse(window.snapshot().nodes.find(n => n.id === 'content').payloadJson).cells[0].length === 3);
  await undo();
  assert.deepEqual((await note()).cells, original.cells);

  await page.mouse.click(1550, 700);
  await card('image-a').click({ modifiers: ['Control'], position: { x: 50, y: 50 } });
  await card('image-a').focus(); await page.keyboard.press('ArrowRight');
  await saved(() => window.snapshot().nodes.find(n => n.id === 'image-a').x > 900);
  await undo(); await saved(() => window.snapshot().nodes.find(n => n.id === 'image-a').x === 900);

  const a = await card('image-a').boundingBox(), b = await card('image-b').boundingBox();
  await page.mouse.move(a.x + 80, a.y + 80); await page.mouse.down();
  await page.mouse.move(b.x + 90, b.y + 70, { steps: 12 });
  await page.waitForTimeout(1150); await page.mouse.up();
  await page.locator('.canvas-node.is-folder').waitFor();
  await saved(() => window.snapshot().groups.length === 1);
  await undo(); await card('image-a').waitFor(); await card('image-b').waitFor();
  await saved(() => window.snapshot().groups.length === 0);
  assert.equal(await page.evaluate(() => window.snapshot().nodes.find(n => n.id === 'image-a').x), 900);

  // A fresh group can also be ungrouped and restored through the same history.
  await page.mouse.move(a.x + 80, a.y + 80); await page.mouse.down();
  await page.mouse.move(b.x + 90, b.y + 70, { steps: 12 });
  await page.waitForTimeout(1150); await page.mouse.up();
  const folder = page.locator('.canvas-node.is-folder'); await folder.waitFor();
  await folder.click({ button: 'right', position: { x: 60, y: 60 } });
  await page.getByRole('menuitem', { name: '删除', exact: true }).hover();
  await page.getByRole('menuitem', { name: /解散素材组|解散分组|解组|展开为独立/ }).click();
  await card('image-a').waitFor(); await undo(); await folder.waitFor();
  await saved(() => window.snapshot().groups.length === 1 && window.snapshot().groupItems.length === 2);
  await undo(); await card('image-a').waitFor();

  // Toolbar creation, removal and repeated undo share one chronological stack.
  await page.getByRole('button', { name: '气泡便签工具', exact: true }).click();
  await page.mouse.click(950, 650);
  const bubble = page.locator('[data-canvas-node-id^="bubble-"]'); await bubble.waitFor();
  const bubbleId = await bubble.getAttribute('data-canvas-node-id');
  await undo(); await saved(() => !document.querySelector('[data-canvas-node-id^="bubble-"]'));
  await page.waitForFunction(id => window.snapshot().nodes.find(n => n.id === id)?.hiddenAt != null, bubbleId);
  await card('content').locator('.canvas-text-handle').click();
  await page.keyboard.press('Delete');
  await saved(() => window.snapshot().nodes.find(n => n.id === 'content').hiddenAt != null);
  await undo(); await card('content').waitFor();
  assert.deepEqual((await note()).cells, original.cells);
  await page.evaluate(() => sessionStorage.setItem('reference-fixture', JSON.stringify(window.snapshot())));
  await page.reload(); await card('content').waitFor();
  assert.deepEqual((await note()).cells, original.cells, 'restored image and cells survive reload');
  await page.screenshot({ path: '.tmp/canvas-edit-undo/canvas.png' });
  assert.deepEqual(errors, []);
  console.log('Canvas undo: image/text/style/grid edits, keyboard movement, grouping/ungrouping, creation/removal and reload passed.');
} finally { await browser.close(); await server.close(); }
