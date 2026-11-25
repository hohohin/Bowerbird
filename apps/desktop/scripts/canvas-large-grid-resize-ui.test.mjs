import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/canvas-large-grid-resize-vite',
  optimizeDeps: { entries: ['scripts/fixtures/canvas-reference/preview.html'] },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(10000);
try {
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/canvas-reference/preview.html`);
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(() => {
    const snapshot = window.snapshot();
    const cell = id => ({ id, text: id, content_type: 'text' });
    snapshot.nodes = [{ ...snapshot.nodes[0], id: 'column-card', kind: 'note', assetId: null, role: null,
      x: 130, y: 130, width: 320, height: 250, payloadJson: JSON.stringify({ schema_version: 1,
        note_type: 'text', member_ids: [], cells: [[cell('first')], [cell('second')]] }) }];
    snapshot.edges = []; snapshot.view = { ...snapshot.view, panX: 120, panY: 90, zoom: 0.55 };
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
  });
  await page.reload();
  const table = page.locator('[data-canvas-node-id="column-card"]');
  const columnInsert = index => table.getByRole('button', { name: `在第 ${index} 列位置插入`, exact: true });
  const waitForColumnOpacity = (minimum, index) => page.waitForFunction(({ minimum, index }) => {
    const buttons = [...document.querySelectorAll('[data-canvas-node-id="column-card"] .canvas-text-insert.is-column')];
    return index === undefined ? buttons.length > 0 && buttons.every(button => Number(getComputedStyle(button).opacity) >= minimum)
      : !!buttons[index] && Number(getComputedStyle(buttons[index]).opacity) >= minimum;
  }, { minimum, index }, { timeout: 2000 });
  const waitForSavedColumns = columns => page.waitForFunction(columns => JSON.parse(window.snapshot().nodes[0].payloadJson).cells[0].length === columns, columns);
  const data = () => page.evaluate(() => {
    const node = window.snapshot().nodes[0];
    return { width: node.width, columns: JSON.parse(node.payloadJson).cells[0].length };
  });
  await table.locator('textarea').first().hover();
  await waitForColumnOpacity(0.5);
  const beforeInsert = await data();
  const add = await columnInsert(2).boundingBox();
  await page.mouse.move(add.x + add.width / 2, add.y - 13);
  await page.mouse.move(add.x + add.width / 2, add.y + add.height / 2, { steps: 10 });
  await waitForColumnOpacity(0.95, 1);
  assert.notEqual(await columnInsert(2).evaluate(button => getComputedStyle(button.parentElement, '::before').content), 'none', 'hover previews the column boundary');
  await page.mouse.click(add.x + add.width / 2, add.y + add.height / 2);
  await columnInsert(3).waitFor();
  await waitForSavedColumns(2);
  assert.deepEqual(await data().then(({ width, columns }) => ({ wider: width > beforeInsert.width, columns })), { wider: true, columns: 2 });
  await table.locator('textarea').first().hover();
  const outlet = table.locator('.canvas-cell-connection[data-canvas-connect-side="output"]').first();
  assert.equal(await outlet.evaluate(element => getComputedStyle(element).pointerEvents), 'auto');
  await columnInsert(2).click();
  await columnInsert(4).waitFor();
  const remove = table.getByRole('button', { name: '删除第 2 列', exact: true });
  await remove.hover();
  assert.equal(await table.locator('.canvas-text-cell.is-removing').count(), 2);
  await remove.click();
  await columnInsert(4).waitFor({ state: 'detached' });
  await waitForSavedColumns(2);
  const bounds = await table.boundingBox();
  await page.mouse.click(bounds.x + 7, bounds.y + bounds.height / 2);
  await table.and(page.locator('.is-selected')).waitFor();
  await page.mouse.move(20, 20);
  await waitForColumnOpacity(0.5);

  for (const axis of ['row', 'column']) {
    await page.evaluate(axis => {
      const snapshot = window.snapshot(), base = snapshot.nodes[0];
      const rows = axis === 'row' ? 53 : 2, columns = axis === 'column' ? 53 : 4;
      const cells = Array.from({ length: rows }, (_, r) => Array.from({ length: columns }, (_, c) =>
        ({ id: `cell-${r}-${c}`, text: `原文 ${r}:${c}`, bold: false, italic: false, align: 'left' })));
      snapshot.nodes = [{ ...base, id: 'table', kind: 'note', assetId: null, role: null, x: 100, y: 100,
        width: columns * 150 + 74, height: rows * 64 + 46, payloadJson: JSON.stringify({ schema_version: 1,
          note_type: 'text', cells, text: cells.map(row => row.map(cell => cell.text).join('\t')).join('\n'),
          row_heights: Array(rows).fill(1), column_widths: Array(columns).fill(1) }) }];
      snapshot.edges = []; snapshot.view = { ...snapshot.view, panX: 120, panY: 90, zoom: 0.15 };
      sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
    }, axis);
    await page.reload();
    await page.locator('[data-canvas-node-id="table"]').waitFor();
    const before = await page.evaluate(() => JSON.parse(window.snapshot().nodes[0].payloadJson));
    // Mirror the native layout contract, which the general-purpose fixture does not enforce.
    await page.evaluate(() => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.gridWrites = [];
      window.__TAURI_INTERNALS__.invoke = async (command, args) => {
        if (command === 'project_canvas_note_update') {
          const note = JSON.parse(args.payloadJson); window.gridWrites.push(note);
          for (const [sizes, count] of [[note.row_heights, note.cells.length], [note.column_widths, note.cells[0].length]]) {
            if (sizes && (sizes.length !== count || sizes.some(size => !Number.isFinite(size) || size <= 0)))
              throw 'project canvas: text card grid sizes must match the table and stay positive';
          }
        }
        return invoke(command, args);
      };
    });
    const handle = page.getByRole('separator', { name: axis === 'row' ? '调整第 1 行高度' : '调整第 1 列宽度', exact: true });
    const box = await handle.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + (axis === 'column' ? 10 : 0), y + (axis === 'row' ? 10 : 0), { steps: 4 });
    await page.mouse.up();
    await page.waitForFunction(() => window.gridWrites.length > 0);
    const written = await page.evaluate(() => window.gridWrites.at(-1));
    const key = axis === 'row' ? 'row_heights' : 'column_widths';
    assert.ok(written[key].every(size => Number.isFinite(size) && size > 0), `${axis}: every persisted size must stay positive`);
    assert.ok(written[key][0] > written[key][1], `${axis}: dense grids remain resizable`);
    assert.equal(written[key].reduce((sum, size) => sum + size, 0), before[key].length);
    assert.deepEqual(written[key].slice(2), before[key].slice(2), 'unrelated dimensions stay unchanged');
    assert.deepEqual(written.cells, before.cells, 'resizing preserves all content and cell identities');
    assert.equal(await page.locator('.canvas-save-error').count(), 0);
    await page.evaluate(() => window.save());
    await page.reload();
    await page.locator('[data-canvas-node-id="table"]').waitFor();
    assert.deepEqual(await page.evaluate(() => JSON.parse(window.snapshot().nodes[0].payloadJson)), written);
  }
  console.log('Large grid resize: 53 rows and 53 columns save, preserve content and reload.');
} finally { await browser.close(); await server.close(); }
