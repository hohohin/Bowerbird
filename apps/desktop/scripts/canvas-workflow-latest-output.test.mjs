import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: '.tmp/workflow-latest-vite', optimizeDeps: { entries: ['scripts/fixtures/canvas-reference/preview.html'] }, server: { host: '127.0.0.1', port: 1629, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1900, height: 1200 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const saved = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('workflow-p')).document);
const drag = async (from, to) => {
  const a = await from.boundingBox(), b = await to.boundingBox();
  assert.ok(a && b, 'connection endpoints are visible');
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 15 });
  await page.mouse.up();
};
try {
  await page.goto('http://127.0.0.1:1629/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const c = canvasWorkflowController('p'); await c.load();
    await c.edit([
      { ...newWorkflowNode('generation', 80, 80, 'codex'), id: 'source', prompt: '生成产品图' },
      { ...newWorkflowNode('generation', 1450, 80, 'codex'), id: 'consumer', prompt: '使用 ' },
      { ...newWorkflowNode('instruction', 1450, 650, 'codex'), id: 'instruction', action: 'reuse' },
    ]);
    const snapshot = window.snapshot();
    snapshot.nodes = snapshot.nodes.filter(node => node.id === 'old');
    Object.assign(snapshot.nodes[0], { x: 80, y: 900, width: 100, height: 100 });
    snapshot.view = { ...snapshot.view, panX: 50, panY: 40, zoom: .7 };
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
  });
  await page.reload();
  const source = page.locator('[data-workflow-card="source"]');
  const consumer = page.locator('[data-workflow-card="consumer"]');
  const instruction = page.locator('[data-workflow-card="instruction"]');
  await source.waitFor();
  await source.getByRole('button', { name: '输出：图片', exact: true }).click();
  await consumer.getByRole('button', { name: '输入：图片', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.id === 'consumer').inputs.image?.[0]?.cellId === '*latest-image');
  const undoneBridgeId = (await saved()).nodes.find(node => node.id === 'consumer').inputs.image[0].canvasNodeId;
  await page.locator(`[data-canvas-node-id="${undoneBridgeId}"]`).waitFor();
  await page.keyboard.press('Control+z');
  await page.waitForFunction(id => {
    const document = JSON.parse(sessionStorage.getItem('workflow-p')).document;
    return !document.nodes.find(node => node.id === 'consumer').inputs.image?.length
      && !document.nodes.some(node => node.textTarget?.nodeId === id)
      && window.snapshot().nodes.find(node => node.id === id)?.hiddenAt != null;
  }, undoneBridgeId);
  assert.equal(await page.locator('[data-workflow-target="consumer"]').count(), 0, 'undo removes downstream wire');
  assert.equal(await page.locator('[data-workflow-text-link]').count(), 0, 'undo removes generator-to-content wire');
  assert.deepEqual((await saved()).nodes.find(node => node.id === 'consumer').inputs, {}, 'undo restores the original input definition');
  await source.getByRole('button', { name: '输出：图片', exact: true }).click();
  await consumer.getByRole('button', { name: '输入：图片', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.id === 'consumer').inputs.image?.[0]?.cellId === '*latest-image');
  let document = await saved();
  const bridgeId = document.nodes.find(node => node.id === 'consumer').inputs.image[0].canvasNodeId;
  const bridge = page.locator(`[data-canvas-node-id="${bridgeId}"]`);
  await bridge.waitFor();
  assert.equal(await bridge.getByRole('button', { name: '输出最新', exact: true }).count(), 1);
  const writer = document.nodes.find(node => node.textTarget?.nodeId === bridgeId);
  assert.ok(writer?.textTarget.append && writer.textTarget.image, 'generated images append to the inserted content card');
  assert.deepEqual(writer.inputs.image.map(({ nodeId, portId }) => ({ nodeId, portId })), [{ nodeId: 'source', portId: 'image' }]);
  assert.equal(await page.locator('[data-workflow-target="consumer"]').count(), 1, 'content card is wired to downstream');
  assert.equal(await page.locator(`[data-workflow-target="${writer.id}"]`).count(), 1, 'generator is wired to content card');

  const editor = consumer.getByRole('textbox', { name: '卡片指令', exact: true });
  await editor.press('End'); await editor.pressSequentially('@');
  const option = page.getByRole('listbox', { name: '收到的内容' }).getByRole('option').filter({ hasText: '图片来源 1' });
  assert.equal(await option.isEnabled(), true, 'empty latest output remains referenceable before upstream runs');
  await option.click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.id === 'consumer').promptReferences?.length === 1);
  document = await saved();
  const reference = document.nodes.find(node => node.id === 'consumer').promptReferences[0];
  assert.equal(reference.input.cellId, '*latest-image');
  assert.equal(reference.slot, document.nodes.find(node => node.id === 'consumer').inputs.image[0].slot);
  assert.equal(reference.assetId, undefined, 'reference follows the output rather than freezing an asset');

  await drag(source.getByRole('button', { name: '输出：图片', exact: true }), instruction.getByRole('button', { name: '输入：图片', exact: true }));
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.id === 'instruction').inputs.image?.[0]?.cellId === '*latest-image');
  document = await saved();
  const secondInput = document.nodes.find(node => node.id === 'instruction').inputs.image[0];
  assert.ok(document.nodes.some(node => node.textTarget?.nodeId === secondInput.canvasNodeId && node.inputs.image?.some(input => input.nodeId === 'source')));
  await mkdir('.tmp/workflow', { recursive: true });
  await bridge.hover();
  await bridge.getByRole('button', { name: '输出最新', exact: true }).hover();
  await page.screenshot({ path: '.tmp/workflow/automatic-content-bridge.png' });
  await page.evaluate(() => window.save()); await page.reload(); await consumer.waitFor();
  assert.equal((await saved()).nodes.find(node => node.id === 'consumer').inputs.image[0].canvasNodeId, bridgeId);
  assert.equal(await page.locator('[data-workflow-target="consumer"]').count(), 1, 'inserted bridge persists on reload');

  // A manually authored mixed table uses the same one latest-output socket for
  // text and image consumers; references follow the physical final row.
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const c = canvasWorkflowController('p');
    await c.edit([{ ...newWorkflowNode('generation', 1000, 100, 'codex'), id: 'row-consumer', prompt: '内容 ' }]);
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
  const latest = table.getByRole('button', { name: '输出最新', exact: true });
  await table.hover(); await latest.click();
  await rowConsumer.getByRole('button', { name: '输入：文本', exact: true }).click();
  await table.hover();
  await drag(latest, rowConsumer.getByRole('button', { name: '输入：图片', exact: true }));
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
  assert.match(values.error, /没有可用文本/, 'only consumer evaluation rejects an empty latest row');
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
  document = await saved();
  assert.deepEqual(document.nodes[0].promptReferences.map(ref => ref.input.cellId), ['*latest', '*latest-image']);
  assert.equal(await page.locator('[data-workflow-target="row-consumer"]').count(), 2);
  values = await currentValues(); assert.match(values.text.text, /最新追加行/); assert.deepEqual(values.image.assetIds, ['c']);
  await table.hover(); await latest.hover();
  await page.screenshot({ path: '.tmp/workflow/latest-output.png' });
  assert.deepEqual(errors, []);
  console.log('latest output: real click/drag auto bridge, undo, dynamic @ slot, text/image last row, empty row, append and reload passed');
} catch (error) {
  await mkdir('.tmp/workflow', { recursive: true });
  await page.screenshot({ path: '.tmp/workflow/latest-output-failure.png' });
  throw error;
} finally { await browser.close(); await server.close(); }
