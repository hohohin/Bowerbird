import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 1605, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:1605/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const base = window.snapshot().nodes[0];
    await api.projectCanvasNodeCreate({ ...base, id: 'brief', kind: 'note', assetId: null, x: 20, y: 30, payloadJson: JSON.stringify({ cells: [[{ id: 'text', text: '保留版式。'.repeat(150) + '末尾要求：紫心宝螺', content_type: 'text' }]] }) });
    const c = canvasWorkflowController('p'); await c.load();
    await c.edit([{ ...newWorkflowNode('planner', 420, 60, 'jimeng'), id: 'planner', inputs: { text: [{ canvasNodeId: 'brief', cellId: 'text' }], image: [{ assetId: 'existing', assetNodeId: 'old' }] } }]);
    window.save();
  });
  await page.reload();
  const editor = page.getByRole('textbox', { name: '工作流需求', exact: true });
  await editor.waitFor();
  assert.equal(await editor.getAttribute('contenteditable'), 'true');
  await editor.fill('按照 '); await editor.press('End'); await editor.pressSequentially('@');
  const list = page.getByRole('listbox', { name: '收到的内容' }); await list.waitFor();
  assert.equal(await list.getByRole('option').count(), 2);
  await list.getByRole('option').filter({ hasText: '文本 1' }).click();
  await editor.pressSequentially(' 的要求，用 @');
  await list.getByRole('option').filter({ hasText: '图片 1.1' }).click();
  await editor.pressSequentially(' 作为产品参考。');
  assert.equal(await editor.locator('[data-reference-id]').count(), 2);
  await page.evaluate(() => window.save()); await page.reload(); await editor.waitFor();
  assert.equal(await editor.locator('[data-reference-id]').count(), 2, 'inline references survive reload');
  await page.locator('.workflow-card.is-planner').screenshot({ path: '../../.tmp/workflow-planner-references.png' });
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    window.requests = [];
    api.agentDsWorkflowStart = async (...args) => { window.requests.push(args); return { path: 'pending', autoDelivered: false }; };
    api.agentDsWorkflowResult = async () => null;
  });
  await page.getByRole('button', { name: '编排工作流', exact: true }).click();
  await page.getByRole('button', { name: '取消等待', exact: true }).waitFor();
  assert.equal(await editor.getAttribute('contenteditable'), 'false', 'waiting prevents prompt changes');
  const request = await page.evaluate(() => window.requests[0]);
  assert.equal(request[1], '按照 【source1.text：文本 1】 的要求，用 【source2.image：图片 1.1】 作为产品参考。');
  const context = JSON.parse(request[2]);
  assert.ok(context.sources[0].preview.endsWith('末尾要求：紫心宝螺'), 'explicitly referenced text is not silently truncated');
  assert.equal(context.sources[1].id, 'source2');
  assert.ok(!request[1].includes('@['));
  assert.ok(context.sources.every(source => !source.input && !source.contentKey), 'internal binding IDs are not sent to model');
  await page.getByRole('button', { name: '取消等待', exact: true }).click();
  await page.getByRole('button', { name: '编排工作流', exact: true }).waitFor();

  const result = await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { compilePlanningPrompt, plannerContextKey } = await import('/src/lib/workflowPlanner.ts');
    const { captureCanvasClipboard, cloneCanvasClipboard } = await import('/src/lib/canvasClipboard.ts');
    const c = canvasWorkflowController('p'), owner = structuredClone(c.document.nodes[0]);
    const sources = owner.planning.sources;
    let checks = 0; const check = (value, message) => { checks++; if (!value) throw Error(message); };
    const repeated = { ...owner, prompt: owner.prompt + ` 再核对 @[${owner.promptReferences[0].id}]` };
    check(compilePlanningPrompt(repeated, sources).match(/source1.text/g).length === 2, 'repeated references retain source identity');
    const changed = structuredClone(owner); changed.promptReferences[0].input.cellId = 'other';
    check(plannerContextKey(changed) !== plannerContextKey(owner), 'reference-only change invalidates request context');
    check(compilePlanningPrompt({ ...owner, prompt: '普通需求' }, sources) === '普通需求', 'plain prompt remains supported despite unused references');
    let failed = false; try { compilePlanningPrompt({ ...owner, prompt: '@[unknown]' }, sources); } catch { failed = true; }
    check(failed, 'unknown token rejected');
    const canvas = await api.projectCanvasGet('p');
    const clipboard = captureCanvasClipboard('p', new Set(['planner', 'old', 'brief']), canvas.nodes, [], [], c.document.nodes);
    const cloned = cloneCanvasClipboard(clipboard, 'p', 100, 100), copied = cloned.workflow[0];
    check(!copied.planning && copied.promptReferences[0].input.canvasNodeId !== 'brief' && copied.promptReferences[1].input.assetNodeId !== 'old', 'copy remaps reference identity and clears request');
    const copiedSources = sources.map(source => ({ ...source, input: copied.inputs[source.type][0] }));
    check(compilePlanningPrompt(copied, copiedSources) === compilePlanningPrompt(owner, sources), 'copied reference meaning preserved');
    await c.edit([{ ...owner, inputs: { text: owner.inputs.text, image: [] } }]);
    const sentBefore = window.requests.length;
    failed = false; try { await c.planner.start(owner.id); } catch (error) { failed = error.message.includes('重新按 @'); }
    check(failed && window.requests.length === sentBefore, 'disconnected mention blocked before sending');
    await c.edit([owner]); await c.planner.start(owner.id);
    await c.edit(c.document.nodes.map(node => ({ ...node, promptReferences: changed.promptReferences })));
    api.agentDsWorkflowResult = async requestId => ({ schemaVersion: 1, requestId, text: JSON.stringify({ summary: '海报', nodes: [{ id: 'start', kind: 'trigger' }, { id: 'draw', kind: 'generation', prompt: '海报' }], edges: [{ from: 'start', output: 'signal', to: 'draw', input: 'signal' }] }) });
    try { await c.planner.collect(owner.id); } catch {}
    check(c.document.nodes.length === 1 && c.document.nodes[0].planning.status === 'failed', 'late result cannot apply after reference retargeting');
    await c.edit([owner]);
    return { checks };
  });
  // Deleting a mention chip leaves only the user's remaining sentence in the delivered prompt.
  await editor.fill('只保留这段需求');
  await page.getByRole('button', { name: '编排工作流', exact: true }).click();
  await page.getByRole('button', { name: '取消等待', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.requests.at(-1)[1]), '只保留这段需求');
  await page.getByRole('button', { name: '取消等待', exact: true }).click();
  assert.deepEqual(errors, []);
  console.log('planner references: native editor, persistence, scoped delivery, full text, cancellation, copy, stale/disconnected references:', result);
} finally { await browser.close(); await server.close(); }
