import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ root: process.cwd(), cacheDir: '.tmp/workflow-latest-vite', optimizeDeps: { entries: ['scripts/fixtures/canvas-reference/preview.html'] }, server: { host: '127.0.0.1', port: 1629, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1900, height: 1200 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const saved = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('workflow-p')).document);
try {
  await page.goto('http://127.0.0.1:1629/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  // A manually authored mixed table uses the same one latest-output socket for
  // text and image consumers; references follow the physical final row.
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const c = canvasWorkflowController('p'); await c.load();
    await c.edit([{ ...newWorkflowNode('generation', 1000, 100, 'codex'), id: 'row-consumer', prompt: '内容 ' }]);
    await c.save({ ...c.document, cardNames: { 'row-consumer': '下游生成' } });
    const snapshot = window.snapshot(), base = snapshot.nodes.find(node => node.id === 'old');
    Object.assign(base, { x: 80, y: 900, width: 100, height: 100 });
    const cell = (id, text, assetId) => ({ id, text, content_type: assetId ? 'image' : 'text', ...(assetId ? { image_refs: [{ asset_id: assetId, token: '@图片1' }] } : {}) });
    snapshot.nodes = [base, { ...base, id: 'latest-table', kind: 'note', assetId: null, role: null, x: 120, y: 100, width: 650, height: 340,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', text: '', member_ids: [], cells: [
        [cell('old-text', '旧行'), cell('old-image', '@图片1', 'a')],
        [cell('current-text', '当前行'), cell('current-image', '@图片1', 'b')],
      ] }) }];
    snapshot.view = { ...snapshot.view, panX: 50, panY: 50, zoom: .9 };
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
  });
  await page.reload();
  const table = page.locator('[data-canvas-node-id="latest-table"]');
  const rowConsumer = page.locator('[data-workflow-card="row-consumer"]');
  await table.waitFor();
  const latest = table.locator('[data-canvas-connect-side="output"]:not(.canvas-cell-connection)').first();
  await latest.focus(); await latest.press('Enter');
  const menu = page.getByRole('menu', { name: '添加下游', exact: true });
  await menu.getByRole('menuitem', { name: '仅使用最新一行' }).click();
  await menu.getByRole('menuitem', { name: '连接已有卡片' }).click();
  await page.getByRole('menu', { name: '连接已有卡片', exact: true }).getByRole('menuitem', { name: '下游生成' }).click();
  await page.waitForFunction(() => {
    const node = JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes[0];
    return node.inputs.text?.[0]?.cellId === '*latest' && node.inputs.image?.[0]?.cellId === '*latest-image';
  });
  const rowEditor = rowConsumer.getByRole('textbox', { name: '卡片指令', exact: true });
  for (const label of ['文本 1', '图片来源 1']) {
    await rowEditor.press('End'); await rowEditor.pressSequentially('@');
    await page.getByRole('listbox', { name: '收到的内容' }).getByRole('option').filter({ hasText: label }).click();
  }
  const currentValues = () => page.evaluate(async () => {
    const { canvasInputValue } = await import('/src/lib/canvasSessionOutputs.ts');
    const { workflowInputValues, compileGenerationPrompt } = await import('/src/lib/canvasWorkflow.ts');
    const nodes = window.snapshot().nodes, table = nodes.find(node => node.id === 'latest-table');
    const document = JSON.parse(sessionStorage.getItem('workflow-p')).document;
    let compiled, error;
    try {
      const values = workflowInputValues(document.nodes, document.nodes[0], (id, cellId) => canvasInputValue(nodes.find(node => node.id === id), cellId, nodes));
      compiled = compileGenerationPrompt(document.nodes[0], values);
    } catch (caught) { error = caught.message; }
    return { text: canvasInputValue(table, '*latest', nodes), image: canvasInputValue(table, '*latest-image', nodes), compiled, error };
  });
  let values = await currentValues();
  assert.match(values.text.text, /当前行/); assert.doesNotMatch(values.text.text, /旧行/);
  assert.deepEqual(values.image.assetIds, ['b']);
  assert.equal(values.error, undefined); assert.match(values.compiled.prompt, /当前行/); assert.deepEqual(values.compiled.assetIds, ['b']);

  await table.getByRole('textbox', { name: '第 2 行第 1 列', exact: true }).focus();
  const insert = table.getByRole('button', { name: '在第 3 行位置插入', exact: true });
  await insert.locator('svg').hover(); await insert.locator('svg').click();
  await table.getByRole('textbox', { name: '第 3 行第 1 列', exact: true }).waitFor();
  await page.waitForFunction(() => JSON.parse(window.snapshot().nodes.find(node => node.id === 'latest-table').payloadJson).cells.length === 3);
  values = await currentValues();
  assert.equal(values.text.text.trim(), '', 'empty last row never falls back to older text');
  assert.deepEqual(values.image.assetIds, [], 'empty last row never falls back to older images');
  assert.match(values.error, /没有可用文本|没有可用内容/, 'only consumer evaluation rejects an empty latest row');
  await table.getByRole('textbox', { name: '第 3 行第 1 列', exact: true }).fill('最新追加行');
  await page.waitForFunction(() => JSON.parse(window.snapshot().nodes.find(node => node.id === 'latest-table').payloadJson).cells[2][0].text === '最新追加行');
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const note = JSON.parse(window.snapshot().nodes.find(node => node.id === 'latest-table').payloadJson);
    await canvasWorkflowController('p').storeCellImages('latest-table', note.cells[2][1].id, ['c']);
  });
  values = await currentValues();
  assert.match(values.text.text, /最新追加行/); assert.doesNotMatch(values.text.text, /当前行/);
  assert.deepEqual(values.image.assetIds, ['c']);
  assert.equal(values.error, undefined); assert.match(values.compiled.prompt, /最新追加行/); assert.deepEqual(values.compiled.assetIds, ['c']);
  await page.evaluate(() => window.save()); await page.reload(); await table.waitFor();
  const document = await saved();
  assert.deepEqual(document.nodes[0].promptReferences.map(ref => ref.input.cellId), ['*latest', '*latest-image']);
  assert.equal(await page.locator('[data-workflow-target="row-consumer"]').count(), 1);
  values = await currentValues(); assert.match(values.text.text, /最新追加行/); assert.deepEqual(values.image.assetIds, ['c']);
  await table.hover(); await latest.hover();
  await mkdir('.tmp/workflow', { recursive: true });
  await page.screenshot({ path: '.tmp/workflow/latest-output.png' });
  assert.deepEqual(errors, []);
  console.log('latest output: explicit latest-row connection, dynamic @ slots, text/image last row, empty row, append and reload passed');
} catch (error) {
  await mkdir('.tmp/workflow', { recursive: true });
  await page.screenshot({ path: '.tmp/workflow/latest-output-failure.png' });
  throw error;
} finally { await browser.close(); await server.close(); }
