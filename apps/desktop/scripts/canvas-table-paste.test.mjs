import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 1596, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const card = page.locator('[data-canvas-node-id="paste"]');
const cell = (r, c) => card.getByRole('textbox', { name: `第 ${r} 行第 ${c} 列`, exact: true });
const read = () => page.evaluate(() => JSON.parse(window.snapshot().nodes.find(node => node.id === 'paste').payloadJson));
async function paste(r, c, text, html) {
  await cell(r, c).focus();
  await page.evaluate(async ({ text, html }) => {
    const data = { 'text/plain': new Blob([text], { type: 'text/plain' }) };
    if (html) data['text/html'] = new Blob([html], { type: 'text/html' });
    await navigator.clipboard.write([new ClipboardItem(data)]);
  }, { text, html });
  await page.keyboard.press('Control+v');
}
async function saved(r, c, text) {
  await page.waitForFunction(({ r, c, text }) => {
    const node = window.snapshot().nodes.find(node => node.id === 'paste');
    return JSON.parse(node.payloadJson).cells[r - 1]?.[c - 1]?.text === text;
  }, { r, c, text });
}
try {
  await page.goto('http://127.0.0.1:1596/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(() => {
    const snapshot = window.snapshot();
    const cell = (id, text) => ({ id, text, content_type: 'text', bold: false, italic: false, align: 'left' });
    snapshot.nodes = [{ ...snapshot.nodes[0], id: 'paste', kind: 'note', role: null, assetId: null, x: 80, y: 80, width: 500, height: 300,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', text: '', member_ids: [], row_heights: [2, 1], column_widths: [1, 2],
        cells: [[cell('keep', '保留内容'), cell('outside', '邻格')], [cell('left', '左侧'), { ...cell('anchor', '@图片1'), image_refs: [{ token: '@图片1', asset_id: 'a' }] }]] }) }];
    snapshot.view = { ...snapshot.view, zoom: 1, panX: 50, panY: 50 };
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
  });
  await page.reload();
  await card.waitFor();

  // Actual browser clipboard + Ctrl+V, with the HTML/TSV pair supplied by Office.
  await paste(2, 2, '名称\t说明\t数量\r\n甲\t"第一行\n第二行"\t\r\n乙\t 空格 \t3\r\n',
    '<html xmlns:x="urn:schemas-microsoft-com:office:excel"><body><!--StartFragment--><table><tr><td>名称</td><td>说明</td><td>数量</td></tr><tr><td>甲</td><td>第一行<br>第二行</td><td></td></tr><tr><td>乙</td><td> 空格 </td><td>3</td></tr></table><!--EndFragment--></body></html>');
  await saved(4, 4, '3');
  let note = await read();
  assert.deepEqual(note.cells.map(row => row.map(cell => cell.text)), [
    ['保留内容', '邻格', '', ''], ['左侧', '名称', '说明', '数量'], ['', '甲', '第一行\n第二行', ''], ['', '乙', ' 空格 ', '3'],
  ]);
  assert.equal(note.cells[1][1].id, 'anchor');
  assert.deepEqual(note.cells[1][1].image_refs, []);
  assert.deepEqual(note.row_heights, [2, 1, 1, 1]);
  assert.deepEqual(note.column_widths, [1, 2, 1, 1]);
  const ids = note.cells.flat().map(cell => cell.id);
  assert.equal(new Set(ids).size, 16);
  await page.evaluate(() => window.save());
  await page.reload(); await card.waitFor();
  assert.deepEqual((await read()).cells.flat().map(cell => cell.id), ids);
  assert.equal(await cell(3, 3).inputValue(), '第一行\n第二行');

  await paste(2, 2, '"带\t制表"\t"含""引号"""\r\n"上\n下"\t\r\n');
  await saved(3, 2, '上\n下');
  note = await read();
  assert.equal(note.cells[1][1].text, '带\t制表');
  assert.equal(note.cells[1][2].text, '含"引号"');
  assert.equal(note.cells[2][2].text, '');
  assert.equal(note.cells[1][3].text, '数量');
  assert.deepEqual(note.cells.flat().map(cell => cell.id), ids);

  // Plain multiline prose stays in the current textarea and uses normal selection replacement.
  await cell(1, 1).focus(); await page.keyboard.press('Control+a');
  await paste(1, 1, '普通文字\n第二段');
  await saved(1, 1, '普通文字\n第二段');
  assert.equal((await read()).cells.length, 4);

  const parsed = await page.evaluate(async () => {
    const { parseCanvasTableClipboard: parse } = await import('/src/lib/canvasTablePaste.ts');
    return {
      column: parse('<table><tr><td>一</td></tr><tr><td>二</td></tr></table>', '一\n二'),
      merged: parse('<table><tr><td rowspan="2">合并行</td><td colspan="2">合并列</td></tr><tr><td>A</td><td>B</td></tr></table>', ''),
      paragraphs: parse('<table><tr><td><p>段一</p><p>段二</p></td><td>&amp;&lt;</td></tr></table>', ''),
      trailingBreak: parse('<table><tr><td>换行<br></td></tr></table>', ''),
      blank: parse('', '\tB\t\r\n\t\t\r\n'),
      prose: parse('<p>普通文字</p>', '普通文字\n第二段'),
      quotedTab: parse('', '"格内\t文本"'),
    };
  });
  assert.deepEqual(parsed.column, [['一'], ['二']]);
  assert.deepEqual(parsed.merged, [['合并行', '合并列', ''], ['', 'A', 'B']]);
  assert.deepEqual(parsed.paragraphs, [['段一\n段二', '&<']]);
  assert.deepEqual(parsed.trailingBreak, [['换行\n']]);
  assert.deepEqual(parsed.blank, [['', 'B', ''], ['', '', '']]);
  assert.equal(parsed.prose, null);
  assert.equal(parsed.quotedTab, null);

  // The same component is also used by bubbles; neither bubbles nor a running card split tables.
  const guarded = await page.evaluate(async () => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: { createRoot } } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { CanvasTextCard } = await import('/src/components/CanvasTextCard.tsx');
    const { default: { flushSync } } = await import('/node_modules/.vite/deps/react-dom.js');
    const result = [];
    for (const [note_type, inputLocked] of [['bubble', false], ['text', true]]) {
      const host = document.createElement('div'); document.body.append(host);
      const root = createRoot(host); let writes = 0;
      flushSync(() => root.render(React.createElement(CanvasTextCard, {
        value: { schema_version: 1, note_type, text: '', member_ids: [], cells: [[{ id: 'x', text: '', bold: false, italic: false, align: 'left' }]] },
        inputLocked, selected: false, width: 300, height: 200, zoom: 1, onChange: () => writes++, onSelect() {}, onResize() {},
      })));
      const data = new DataTransfer(); data.setData('text/plain', 'A\tB\nC\tD');
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data });
      host.querySelector('textarea').dispatchEvent(event);
      result.push({ writes, prevented: event.defaultPrevented });
      root.unmount(); host.remove();
    }
    return result;
  });
  assert.deepEqual(guarded, [{ writes: 0, prevented: false }, { writes: 0, prevented: false }]);
  assert.deepEqual(errors, []);
  console.log('table paste passed: native clipboard HTML/TSV, offset/expansion, empty/quoted/multiline cells, merge positions, stable IDs/reload, plain text and editing guards');
} finally {
  await browser.close();
  await server.close();
}
