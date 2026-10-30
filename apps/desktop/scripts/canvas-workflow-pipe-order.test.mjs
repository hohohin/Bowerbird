import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: '.tmp/workflow-pipe-order-vite', optimizeDeps: { entries: ['scripts/fixtures/canvas-reference/preview.html'] }, server: { host: '127.0.0.1', port: 1641, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 2000, height: 1200 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const card = id => page.locator(`[data-workflow-card="${id}"]`);
const editor = id => card(id).getByRole('textbox', { name: id === 'agent' ? 'Agent 要求' : '卡片指令', exact: true });
const saved = id => page.evaluate(id => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.id === id), id);
const waitInputs = (id, type, count) => page.waitForFunction(({ id, type, count }) => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.id === id).inputs[type].length === count, { id, type, count });
const disconnectMiddle = async (id, type) => {
  await card(id).getByRole('button', { name: `输入：${type === 'image' ? '图片' : '文本'}`, exact: true }).click({ button: 'right' });
  const menu = page.getByRole('menu', { name: '选择要断开的连线' });
  await menu.getByRole('menuitem').filter({ hasText: `${type === 'image' ? '图片来源' : '文本'} 2` }).click();
  await waitInputs(id, type, 2);
};
const assertInputs = async (id, cells) => {
  const node = await saved(id);
  for (const type of ['text', 'image']) assert.deepEqual(node.inputs[type].map(input => [input.slot, input.cellId]), cells.map((cell, index) => [index + 1, `${type}-${cell}`]), `${id} ${type}: current order defines pipe numbers`);
};
const assertThumb = async (id, slot, assetId) => {
  const chip = editor(id).locator(`[data-reference-id="${id}-image-${slot}"]`);
  if (!assetId) { await page.waitForFunction(({ id, slot }) => document.querySelector(`[data-workflow-card="${id}"] [data-reference-id="${id}-image-${slot}"] img`) === null, { id, slot }); return; }
  const src = await page.evaluate(async assetId => {
    const { api } = await import('/src/lib/api.ts'); return (await api.getAssetsByIds([assetId]))[0].store_path;
  }, assetId);
  await page.waitForFunction(({ id, slot, src }) => document.querySelector(`[data-workflow-card="${id}"] [data-reference-id="${id}-image-${slot}"] img`)?.getAttribute('src') === src, { id, slot, src });
  assert.equal(await chip.innerText(), `@图片来源 ${slot}`);
};
const compile = (id, omitLast = false) => page.evaluate(async ({ id, omitLast }) => {
  const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
  const { compileGenerationPrompt, compileAgentPrompt, generationInputNode, workflowInputValues } = await import('/src/lib/canvasWorkflow.ts');
  const { canvasInputValue } = await import('/src/lib/canvasSessionOutputs.ts');
  const c = canvasWorkflowController('p');
  let node = structuredClone(c.document.nodes.find(node => node.id === id));
  if (omitLast) node.prompt = node.prompt.replaceAll(`@[${id}-text-3]`, '').replaceAll(`@[${id}-image-3]`, '');
  const graph = window.snapshot().nodes;
  try {
    const values = workflowInputValues(c.document.nodes, generationInputNode(node), (nodeId, cellId) => canvasInputValue(graph.find(node => node.id === nodeId), cellId, graph));
    return { output: node.kind === 'agent' ? compileAgentPrompt(node, values) : compileGenerationPrompt(node, values) };
  } catch (error) { return { error: error.message, referenceLabel: error.referenceLabel }; }
}, { id, omitLast });
const assertCompiled = async (id, cells, omitLast = false) => {
  const result = await compile(id, omitLast);
  assert.ok(result.output, JSON.stringify(result));
  assert.deepEqual(result.output.assetIds, cells, `${id}: compiled image attachments follow the current pipes`);
  const words = { a: '甲', b: '乙', c: '丙', d: '丁' };
  if (id === 'agent') assert.deepEqual(Object.values(JSON.parse(result.output.source)), cells.map(cell => ({ format: 'bowerbird-table', rows: [[words[cell]]] })));
  else for (const cell of cells) assert.ok(result.output.prompt.includes(words[cell]), result.output.prompt);
};

try {
  await page.goto('http://127.0.0.1:1641/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const snapshot = window.snapshot();
    const source = { ...snapshot.nodes[0], id: 'pipe-sources', kind: 'note', role: null, assetId: null, x: 40, y: 80, width: 560, height: 360, payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', title: '管道来源', text: '', member_ids: [], cells: ['a', 'b', 'c', 'd'].map((assetId, index) => [
      { id: `text-${assetId}`, text: ['甲', '乙', '丙', '丁'][index], content_type: 'text', image_refs: [] },
      { id: `image-${assetId}`, text: '', content_type: 'image', image_refs: [{ token: '@图片1', asset_id: assetId }] },
    ]) }) };
    await api.projectCanvasNodeCreate(source);
    const consumers = ['generation', 'agent'].map((kind, index) => {
      const id = kind === 'generation' ? 'generation' : 'agent';
      const inputs = Object.fromEntries(['text', 'image'].map(type => [type, ['a', 'b', 'c'].map((cell, i) => ({ slot: i + 1, canvasNodeId: source.id, cellId: `${type}-${cell}` }))]));
      const promptReferences = ['text', 'image'].flatMap(type => inputs[type].map((input, i) => ({ id: `${id}-${type}-${i + 1}`, type, slot: i + 1, input, label: `${type === 'text' ? '文本' : '图片来源'} ${i + 1}` })));
      return { ...newWorkflowNode(kind, 700 + index * 450, 80, 'codex'), id, agentTransport: 'cloud', inputs, prompt: promptReferences.map(ref => `@[${ref.id}]`).join(' / '), promptReferences };
    });
    const c = canvasWorkflowController('p'); await c.load(); await c.edit(consumers);
    const graph = window.snapshot(); graph.nodes = graph.nodes.filter(node => node.id === source.id);
    graph.edges = []; graph.groups = []; graph.groupItems = [];
    graph.view = { ...graph.view, zoom: .95, panX: 60, panY: 50 };
    sessionStorage.setItem('reference-fixture', JSON.stringify(graph));
  });
  await page.reload(); await editor('generation').waitFor(); await editor('agent').waitFor();

  for (const id of ['generation', 'agent']) {
    await assertInputs(id, ['a', 'b', 'c']);
    await assertThumb(id, 2, 'b');
    await assertCompiled(id, ['a', 'b', 'c']);
    await disconnectMiddle(id, 'image'); await disconnectMiddle(id, 'text');
    await assertInputs(id, ['a', 'c']);
    await assertThumb(id, 2, 'c'); await assertThumb(id, 3, null);
    assert.match((await compile(id)).error, /已断开/, 'an absent third pipe remains an invalid reference');
    await assertCompiled(id, ['a', 'c'], true);

    // Canvas undo restores the removed wires, numbering and chip thumbnails together.
    await card(id).getByRole('button', { name: '复制卡片', exact: true }).focus();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await waitInputs(id, 'text', 3);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await waitInputs(id, 'image', 3);
    await assertInputs(id, ['a', 'b', 'c']); await assertThumb(id, 2, 'b'); await assertThumb(id, 3, 'c');
    await assertCompiled(id, ['a', 'b', 'c']);
    await disconnectMiddle(id, 'image'); await disconnectMiddle(id, 'text');

    await editor(id).press('End'); await editor(id).pressSequentially('@');
    const choices = page.getByRole('listbox', { name: '收到的内容' }); await choices.waitFor();
    assert.deepEqual(await choices.getByRole('option').locator('b').allTextContents(), ['文本 1', '文本 2', '图片来源 1', '图片来源 2']);
    assert.equal(await choices.getByRole('option').filter({ hasText: '文本 2' }).locator('small').innerText(), '丙');
    const thirdImage = await page.evaluate(async () => { const { api } = await import('/src/lib/api.ts'); return (await api.getAssetsByIds(['c']))[0].store_path; });
    assert.equal(await choices.getByRole('option').filter({ hasText: '图片来源 2' }).locator('img').getAttribute('src'), thirdImage);
    await editor(id).press('Escape'); await editor(id).press('Backspace');
  }

  await page.evaluate(() => window.save()); await page.reload(); await editor('generation').waitFor();
  for (const id of ['generation', 'agent']) {
    await assertInputs(id, ['a', 'c']); await assertThumb(id, 2, 'c'); await assertThumb(id, 3, null);
    await assertCompiled(id, ['a', 'c'], true);
    for (const type of ['text', 'image']) {
      const cell = page.locator(`[data-canvas-node-id="pipe-sources"] [data-canvas-cell="${type}-d"]`);
      await cell.hover(); await cell.locator(`[data-workflow-cell="${type}-d"]`).click();
      await card(id).getByRole('button', { name: `输入：${type === 'image' ? '图片' : '文本'}`, exact: true }).click();
      await waitInputs(id, type, 3);
    }
    await assertInputs(id, ['a', 'c', 'd']); await assertThumb(id, 2, 'c'); await assertThumb(id, 3, 'd');
    await assertCompiled(id, ['a', 'c', 'd']);
  }
  await page.evaluate(() => window.save()); await page.reload(); await editor('generation').waitFor();
  for (const id of ['generation', 'agent']) { await assertInputs(id, ['a', 'c', 'd']); await assertCompiled(id, ['a', 'c', 'd']); }
  assert.deepEqual(errors, []);
  console.log('PASS ordered input pipes: generation/Agent image+text middle disconnect, compact candidate numbers, live chip previews, disconnected trailing reference, compiled assets, undo, append and reload');
} finally { await browser.close(); await server.close(); }
