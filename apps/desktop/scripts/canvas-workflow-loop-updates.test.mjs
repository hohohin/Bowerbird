import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 1650, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1200 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:1650/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const { workflowLoopItems } = await import('/src/lib/workflowLoop.ts');
    const base = window.snapshot().nodes[0];
    const cells = Array.from({ length: 10 }, (_, i) => [{ id: `row-${i}`, text: `内容 ${i + 1}`, bold: false, italic: false, align: 'left' }]);
    await api.projectCanvasNodeCreate({ ...base, id: 'source-table', kind: 'note', assetId: null, threadId: null, role: null, x: 150, y: 100, width: 300, height: 686,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', cells, text: '', member_ids: [] }) });
    window.save();
    const c = canvasWorkflowController('p'); await c.load();
    const loop = { ...newWorkflowNode('loop', 600, 150, 'codex'), id: 'loop', loopMode: 'rows', inputs: { text: [{ canvasNodeId: 'source-table', cellId: '*text' }] } };
    const agent = { ...newWorkflowNode('agent', 1000, 150, 'codex'), id: 'agent', prompt: '处理当前行', inputs: { text: [{ nodeId: 'loop', portId: 'text' }] } };
    await c.edit([loop, agent]);
    const items = workflowLoopItems(loop, [loop, agent], window.snapshot().nodes);
    const run = { id: 'paused', startId: 'loop', threadId: 't', order: ['loop', 'agent'], status: 'waiting', steps: { loop: { status: 'done' }, agent: { status: 'waiting' } },
      loop: { nodeId: 'loop', bodyIds: ['agent'], startIndex: 0, index: 0, items, completed: [] } };
    await c.save({ ...c.document, run, runs: [run] });
  });
  await page.reload();
  const card = page.locator('.workflow-card.is-loop'), source = page.locator('[data-canvas-node-id="source-table"]');
  await source.waitFor(); await card.waitFor();
  const picker = card.getByRole('button', { name: '循环起始项', exact: true });
  const menu = page.getByRole('listbox', { name: '选择循环起始项' });
  assert.match(await card.locator('.workflow-loop-start > small').textContent(), /共 10 项/);
  await source.getByRole('textbox', { name: '第 10 行第 1 列', exact: true }).click();
  await source.getByRole('button', { name: '在第 11 行位置插入', exact: true }).click();
  await source.getByRole('textbox', { name: '第 11 行第 1 列', exact: true }).fill('新增第 11 行');
  assert.match(await card.locator('.workflow-loop-start > small').textContent(), /共 11 项/);
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const c = canvasWorkflowController('p');
    if (c.document.run.loop.items.length !== 10) throw Error('active loop input must stay frozen');
    await c.stop();
  });
  await picker.click();
  assert.equal(await menu.getByRole('option').count(), 11);
  await page.screenshot({ path: '.tmp/workflow/loop-input-updated.png' });
  await menu.getByRole('option', { name: /第 11 项.*新增第 11 行/ }).click();
  assert.match(await picker.textContent(), /从第 11 项开始/);
  await page.waitForFunction(() => JSON.parse(window.snapshot().nodes.find(node => node.id === 'source-table').payloadJson).cells.at(-1)[0].text === '新增第 11 行');
  await page.evaluate(() => window.save());
  await page.reload(); await card.waitFor();
  assert.match(await picker.textContent(), /从第 11 项开始/);
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const requests = [], results = new Map();
    api.agentDsWorkflowStart = async (requestId, instruction, source) => {
      requests.push(source); results.set(requestId, { schemaVersion: 1, requestId, text: '完成新增行' }); return { autoDelivered: true };
    };
    api.agentDsWorkflowResult = async requestId => results.get(requestId);
    const c = canvasWorkflowController('p'); await c.start('loop');
    if (c.document.run.status !== 'done' || c.document.run.loop.items.length !== 11 || c.document.run.loop.startIndex !== 10
      || c.document.run.loop.completed.length !== 1 || requests.length !== 1 || !requests[0].includes('新增第 11 行')) throw Error('new loop must execute the new eleventh row only');
    if (c.document.runs[0].loop.items.length !== 10) throw Error('previous run input must not be rewritten');
  });
  await source.getByRole('textbox', { name: '第 11 行第 1 列', exact: true }).click();
  await source.getByRole('button', { name: '在第 12 行位置插入', exact: true }).click();
  await source.getByRole('textbox', { name: '第 12 行第 1 列', exact: true }).fill('完成后新增第 12 行');
  await picker.click(); assert.equal(await menu.getByRole('option').count(), 12);
  await menu.getByRole('option', { name: /第 12 项.*完成后新增第 12 行/ }).click();
  assert.deepEqual(errors, []);
  console.log('PASS paused/completed loops show live new rows; prior inputs frozen; selection/reload and new loop execute eleventh row only');
} finally { await browser.close(); await server.close(); }
