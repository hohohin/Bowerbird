import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 1628, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1200 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const card = id => page.locator(`[data-workflow-card="${id}"]`);
const state = () => page.evaluate(async () => {
  const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
  return structuredClone(canvasWorkflowController('p').document);
});
const persisted = async () => {
  const live = await state();
  await page.waitForFunction(expected => JSON.stringify(JSON.parse(sessionStorage.getItem('workflow-p')).document) === JSON.stringify(expected), live);
  return live;
};
const undo = () => page.keyboard.press(`${modifier}+z`);

try {
  await page.goto('http://127.0.0.1:1628/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const base = window.snapshot().nodes[0];
    await api.projectCanvasNodeCreate({ ...base, id: 'result', kind: 'note', assetId: null, x: 50, y: 650, payloadJson: JSON.stringify({ cells: [[{ id: 'cell', text: '已有内容' }]] }) });
    const producer = { ...newWorkflowNode('instruction', 400, 60, 'codex'), id: 'producer', outputs: { text: { type: 'text', text: '原输出' } } };
    const consumer = { ...newWorkflowNode('generation', 820, 60, 'codex'), id: 'consumer', inputs: { text: [{ nodeId: 'producer', portId: 'text', slot: 1 }] } };
    const writer = { ...newWorkflowNode('text', 0, 0, ''), id: 'writer', textTarget: { nodeId: 'result', cellId: 'cell' }, inputs: { text: [{ nodeId: 'producer', portId: 'text' }] } };
    const c = canvasWorkflowController('p'); await c.load(); await c.edit([producer, consumer, writer]);
    const run = { id: 'completed', startId: 'producer', threadId: 'thread', status: 'done', order: ['producer', 'writer'], steps: { producer: { status: 'done' }, writer: { status: 'done' } } };
    await c.save({ ...c.document, runs: [run], run });
    window.save();
    localStorage.setItem('bowerbird.canvasSnapEnabled', 'false');
  });
  await page.reload(); await card('producer').waitFor();
  const original = await state();
  const box = await card('producer').locator('header strong').boundingBox();
  await page.mouse.move(box.x + 20, box.y + 10); await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + 60, { steps: 8 }); await page.mouse.up();
  await persisted();
  const moved = (await state()).nodes.find(node => node.id === 'producer');
  assert.notEqual(moved.x, original.nodes[0].x);
  await card('producer').getByRole('button', { name: '删除卡片', exact: true }).click();
  await card('producer').waitFor({ state: 'detached' });
  const removed = await persisted();
  assert.ok(!removed.nodes.some(node => node.id === 'writer'));
  assert.equal(removed.runs.length, 0);
  assert.deepEqual(removed.nodes.find(node => node.id === 'consumer').inputs.text, []);
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const c = canvasWorkflowController('p');
    const run = { id: 'newer', startId: 'consumer', threadId: 'thread', status: 'done', order: ['consumer'], steps: { consumer: { status: 'done', detail: '较新的执行结果' } } };
    await c.save({ ...c.document, runs: [run], run });
  });
  await undo(); await card('producer').waitFor();
  const restored = await persisted();
  assert.equal(restored.nodes.find(node => node.id === 'producer').x, moved.x, 'undo deletion before undo movement');
  assert.deepEqual(restored.nodes.find(node => node.id === 'consumer').inputs, original.nodes.find(node => node.id === 'consumer').inputs);
  assert.deepEqual(restored.runs.filter(run => run.id === 'completed'), original.runs);
  assert.deepEqual(restored.runs.map(run => run.id), ['completed', 'newer']);
  assert.equal(restored.run.id, 'newer', 'restoring deleted history must keep the newer run latest');
  assert.ok(restored.nodes.some(node => node.id === 'writer'));
  assert.ok((await page.evaluate(() => window.snapshot().nodes.find(node => node.id === 'result').payloadJson)).includes('已有内容'));
  // Focus inside the workflow card must not swallow the canvas shortcut.
  await card('producer').getByRole('button', { name: '复制卡片', exact: true }).focus();
  await undo();
  assert.equal((await persisted()).nodes.find(node => node.id === 'producer').x, original.nodes[0].x);
  await card('producer').getByRole('button', { name: '复制卡片', exact: true }).click();
  await page.waitForFunction(async () => { const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts'); return canvasWorkflowController('p').document.nodes.length === 4; });
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const c = canvasWorkflowController('p');
    const copy = c.document.nodes.find(node => !['producer', 'consumer', 'writer'].includes(node.id));
    const run = { id: 'locked-copy', startId: copy.id, threadId: 'thread', status: 'waiting', order: [copy.id], lockedNodeIds: [copy.id], steps: { [copy.id]: { status: 'waiting' } } };
    await c.save({ ...c.document, runs: [...c.document.runs, run], run });
  });
  await undo(); assert.equal((await persisted()).nodes.length, 4, 'active cards block undo without losing the entry');
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const c = canvasWorkflowController('p');
    const runs = c.document.runs.map(run => run.id === 'locked-copy' ? { ...run, status: 'stopped' } : run);
    await c.save({ ...c.document, runs, run: runs.at(-1) });
  });
  await undo(); assert.equal((await persisted()).nodes.length, 3);
  // Form editing keeps its own undo; after leaving the form, canvas undo restores parameters.
  await card('producer').getByLabel('指令功能').selectOption('reuse');
  await card('producer').getByLabel('指令功能').focus();
  await undo(); assert.equal((await state()).nodes.find(node => node.id === 'producer').action, 'reuse');
  await card('producer').getByRole('button', { name: '复制卡片', exact: true }).focus();
  await undo(); assert.equal((await persisted()).nodes.find(node => node.id === 'producer').action, 'describe');
  // New cards enter the same history.
  await page.getByRole('button', { name: '新增生成卡片', exact: true }).click();
  await page.waitForFunction(async () => { const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts'); return canvasWorkflowController('p').document.nodes.length === 4; });
  await undo(); assert.equal((await persisted()).nodes.length, 3);
  await page.reload(); await card('producer').waitFor();
  assert.deepEqual((await state()).runs, restored.runs);
  assert.deepEqual(errors, []);
  console.log('PASS workflow deletion/writer/wire/history recovery, sequential movement undo, focused-button shortcut, copy/create/parameter undo, active-run protection, form protection and persisted reload.');
} finally { await browser.close(); await server.close(); }
