import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/content-editing-vite', server: { host: '127.0.0.1', port: 1638, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1200 }, permissions: ['clipboard-read', 'clipboard-write'] });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const card = page.locator('[data-canvas-node-id="editing"]');
const input = card.getByRole('textbox', { name: '第 1 行第 1 列', exact: true });
const markdown = '# 贝壳图鉴\n\n**雪山宝螺** · *天然紫韵*\n\n- 原创贝壳礼\n- 独一无二\n\n> 珀色为壳，紫意藏心\n\n`Monetaria`\n\n~~旧文案~~\n\n[详情](https://example.com)';
const saved = () => page.waitForFunction(() => !document.querySelector('.canvas-save-state.is-visible'));
const state = () => page.evaluate(() => window.snapshot().nodes.find(node => node.id === 'editing'));
const bounds = () => card.locator('[data-canvas-cell="a"]').boundingBox();
try {
  await page.goto('http://127.0.0.1:1638/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(() => {
    const snapshot = window.snapshot();
    const cell = (id, text) => ({ id, text, content_type: 'text', bold: false, italic: false, align: 'left' });
    snapshot.nodes = [{ ...snapshot.nodes[0], id: 'editing', kind: 'note', role: null, assetId: null, x: 120, y: 100, width: 650, height: 650,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', text: '', member_ids: [], row_heights: [2, 1], column_widths: [2, 1],
        cells: [[cell('a', ''), cell('b', '邻格')], [cell('c', ''), cell('d', '')]] }) }];
    snapshot.view = { ...snapshot.view, zoom: 0.8, panX: 30, panY: 30 };
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
  });
  await page.reload();
  await card.waitFor();
  assert.equal(await page.getByRole('button', { name: '内容卡片工具', exact: true }).locator('.lucide-table2, .lucide-table-2').count(), 1);
  await input.fill(markdown);
  await input.press('Escape');
  const preview = card.locator('[data-canvas-cell="a"] .canvas-cell-markdown');
  assert.equal(await preview.locator('h1').innerText(), '贝壳图鉴');
  assert.equal(await preview.locator('strong').innerText(), '雪山宝螺');
  assert.equal(await preview.locator('em').innerText(), '天然紫韵');
  assert.equal(await preview.locator('li').count(), 2);
  assert.equal(await preview.locator('blockquote').innerText(), '珀色为壳，紫意藏心');
  assert.equal(await preview.locator('del').innerText(), '旧文案');
  assert.equal(await preview.locator('a').getAttribute('rel'), 'noopener noreferrer');
  await preview.locator('h1').click();
  assert.equal(await input.evaluate(el => el === document.activeElement), true);
  assert.equal(await input.inputValue(), markdown);
  await input.blur();
  await saved();
  const original = await state();
  const before = await bounds();
  // A manually enlarged, nonuniform grid grows at 80% zoom without squeezing old cells.
  await card.getByRole('button', { name: '在第 2 列位置插入', exact: true }).click({ force: true });
  await saved();
  const afterColumn = await bounds();
  assert.ok(Math.abs(afterColumn.width - before.width) < 1, `column retained: ${afterColumn.width} vs ${before.width}`);
  assert.ok((await state()).width > original.width + 100);
  await card.getByRole('button', { name: '在第 2 行位置插入', exact: true }).click({ force: true });
  await saved();
  assert.ok(Math.abs((await bounds()).height - before.height) < 1, 'row retains height');
  assert.ok((await state()).height > original.height + 100);
  const expanded = await state();
  assert.deepEqual(JSON.parse(expanded.payloadJson).cells.map(row => row.map(cell => cell.text)), [[markdown, '', '邻格'], ['', '', ''], ['', '', '']]);
  const table = await page.evaluate(async () => {
    const { canvasNoteValue } = await import('/src/lib/canvasNotes.ts');
    return canvasNoteValue(JSON.parse(window.snapshot().nodes.find(node => node.id === 'editing').payloadJson), '*text');
  });
  assert.equal(table.table.rows[0][0], markdown, 'table output keeps Markdown source');
  await page.evaluate(() => window.save());
  await page.reload();
  await card.waitFor();
  assert.deepEqual([(await state()).width, (await state()).height], [expanded.width, expanded.height]);
  assert.equal(await input.inputValue(), markdown);
  await mkdir('.tmp/content-editing', { recursive: true });
  await page.screenshot({ path: '.tmp/content-editing/light.png' });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.screenshot({ path: '.tmp/content-editing/dark.png' });
  // Raw HTML and dangerous links are not executed by the renderer.
  await input.fill('<img src=x onerror="window.markdownExecuted=true">\n\n[bad](javascript:alert(1))');
  await input.blur();
  assert.equal(await preview.locator('[onerror], script, a[href^="javascript:"]').count(), 0);
  assert.equal(await page.evaluate(() => window.markdownExecuted), undefined);
  assert.deepEqual(errors, []);
  console.log('PASS content icon, Markdown edit/preview/source output, row/column growth, zoom and persistence');
} finally {
  await browser.close();
  await server.close();
}
