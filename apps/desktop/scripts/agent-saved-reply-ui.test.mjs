import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

// Older projects can have a saved result on the Agent node without a chat ID or run history.
const server = await createServer({ cacheDir: '.tmp/agent-saved-reply/vite', server: { host: '127.0.0.1', port: 1683, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/canvas-reference/preview.html`);
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const c = canvasWorkflowController('p');
    await c.load();
    const table = { rows: [['编号', '说明'], ['1', '旧任务表格正文']] };
    const agent = { ...newWorkflowNode('agent', 40, 185, ''), id: 'saved-agent', prompt: '整理表格', outputs: {
      text: { type: 'text', text: '旧任务表格正文', table }, image: { type: 'image', assetIds: ['a'] },
    } };
    await c.edit([...c.document.nodes, agent, { ...newWorkflowNode('agent', 44, 460, ''), id: 'draft-agent', prompt: '当前草稿' }]);
    await api.projectCanvasNodeCreate({ ...window.snapshot().nodes[0], id: 'saved-result-note', kind: 'note',
      assetId: null, role: null, x: 480, y: 60, payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text',
        text: '', member_ids: [], cells: [[{ id: 'target', text: '' }]] }) });
    await c.bindTextInput('saved-result-note', undefined, { nodeId: agent.id, portId: 'text' }, 'text');
    window.save();
  });
  await page.reload();
  const draft = page.locator('[data-workflow-card="draft-agent"]');
  const draftDetail = page.locator('[data-agent-detail="draft-agent"]');
  await draft.getByRole('textbox', { name: 'Agent 要求' }).click();
  assert.equal(await draftDetail.count(), 0);
  const title = draft.getByRole('button', { name: '查看 Agent 详情' });
  await title.click({ modifiers: ['Control'] });
  assert.equal(await draftDetail.count(), 0);
  const bounds = await title.boundingBox();
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + 55, y, { steps: 5 }); await page.mouse.up();
  assert.equal(await draftDetail.count(), 0);
  await draft.locator('footer span').click();
  await draftDetail.getByText('当前草稿', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await title.focus(); await title.press('Enter');
  await draftDetail.getByRole('heading', { name: '当前要求' }).waitFor();
  await page.keyboard.press('Escape');
  const agent = page.locator('[data-workflow-card="saved-agent"]');
  await agent.waitFor();
  assert.doesNotMatch(await agent.textContent(), /旧任务表格正文/);
  assert.equal(await agent.locator('details, table, .workflow-image-result').count(), 0);
  const note = page.locator('[data-canvas-node-id="saved-result-note"]');
  await note.waitFor();
  assert.equal(await note.getByRole('textbox', { name: '第 2 行第 2 列', exact: true }).inputValue(), '旧任务表格正文');
  await agent.getByRole('button', { name: '查看 Agent 详情' }).click();
  const detail = page.locator('[data-agent-detail="saved-agent"]');
  await detail.getByText(/旧任务表格正文/).waitFor();
  await detail.getByRole('button', { name: '查看图片 1' }).waitFor();
  await page.getByRole('button', { name: '关闭项目详情' }).click();
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const c = canvasWorkflowController('p');
    const loop = { ...newWorkflowNode('loop', 920, 60, ''), id: 'saved-loop', loopMode: 'count', loopCount: 2 };
    const output = { text: { type: 'text', text: '已完成循环的回复' } };
    const steps = { 'saved-agent': { status: 'done', agentOutputs: output }, 'saved-loop': { status: 'done' } };
    const run = { id: 'old-loop-run', startId: loop.id, order: [loop.id, 'saved-agent'], status: 'done', steps,
      loop: { nodeId: loop.id, bodyIds: ['saved-agent'], index: 1, items: [{ text: '1', assetIds: [] }, { text: '2', assetIds: [] }],
        completed: [{ steps, outputs: { 'saved-agent': output } }, { steps, outputs: { 'saved-agent': { text: { type: 'text', text: '另一轮的结果' } } } }] } };
    await c.save({ ...c.document, nodes: [...c.document.nodes, loop], run, runs: [run] });
  });
  const loop = page.locator('[data-workflow-card="saved-loop"]');
  await loop.locator('.workflow-loop-results > summary').click();
  await loop.locator('.workflow-loop-results details > summary').first().click();
  assert.doesNotMatch(await loop.textContent(), /已完成循环的回复|另一轮的结果/);
  await loop.getByRole('button', { name: /会话详情/ }).click();
  await detail.getByText('已完成循环的回复', { exact: true }).waitFor();
  assert.doesNotMatch(await detail.textContent(), /另一轮的结果/);
  console.log('PASS: saved Agent results survive reload, remain readable in details and reach the connected content grid');
} finally {
  await browser.close();
  await server.close();
}
