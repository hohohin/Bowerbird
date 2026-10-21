import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

await mkdir('.tmp/session-completion', { recursive: true });
const server = await createServer({ configFile: false, cacheDir: '.tmp/session-completion/vite', optimizeDeps: { entries: ['scripts/fixtures/canvas-reference/preview.html'] }, server: { host: '127.0.0.1', port: 1687, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
page.setDefaultTimeout(5000);
try {
  await page.goto('http://127.0.0.1:1687/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const c = canvasWorkflowController('p'); await c.load();
    window.checkpoints = [];
    const save = api.canvasWorkflowSave;
    api.canvasWorkflowSave = async (...args) => { window.checkpoints.push(structuredClone(args[2])); return save(...args); };
    const base = window.snapshot().nodes.find(node => node.id === 'old');
    await api.projectCanvasNodeCreate({ ...base, id: 'ordinary-painting', x: 450, y: 180, kind: 'prompt', assetId: null, role: null,
      payloadJson: JSON.stringify({ schema_version: 1, job_id: 'ordinary-job', turn_key: 'first', status: 'running', text: '普通创作框绘画' }) });
    const trigger = { ...newWorkflowNode('trigger', 1000, 180, ''), id: 'repeat', triggerCount: 2 };
    const target = { ...newWorkflowNode('instruction', 1000, 500, 'codex'), id: 'target', action: 'reuse', inputs: { image: [{ assetId: 'existing' }], signal: [{ nodeId: 'repeat', portId: 'signal' }] } };
    window.targetCalls = 0;
    api.generationHistory = async () => { window.targetCalls++; return { turns: [{ prompt: '触发成功' }], references: [] }; };
    await c.edit([trigger, target]);
    window.dispatchEvent(new Event('focus'));
    const { emit } = await import('/node_modules/@tauri-apps/api/event.js'); await emit('creative://changed', { projectId: 'p' });
    window.setSession = async (id, status, output = false, jobId = 'ordinary-job') => {
      const existing = window.snapshot().nodes.find(node => node.id === id);
      const payloadJson = JSON.stringify({ schema_version: 1, job_id: jobId, turn_key: id === 'ordinary-painting' ? 'first' : id, status, text: '普通绘画' });
      if (existing) await api.projectCanvasNoteUpdate(id, payloadJson);
      else await api.projectCanvasNodeCreate({ ...base, id, x: 450, y: 180, kind: 'prompt', assetId: null, role: null, payloadJson });
      if (output && !window.snapshot().nodes.some(node => node.id === `result-${id}`)) await api.projectCanvasNodeCreate({ ...base,
        id: `result-${id}`, role: 'output', assetId: 'a', payloadJson: JSON.stringify({ execution: { job_id: jobId, turn_key: id === 'ordinary-painting' ? 'first' : id } }) });
      window.save();
      window.emitChange();
    };
  });
  const output = page.locator('[data-workflow-session-output="ordinary-painting"]');
  await output.waitFor();
  // Exercise the actual session socket rather than constructing a workflow-node binding.
  const input = page.locator('[data-workflow-card="repeat"]').getByRole('button', { name: '输入：完成触发', exact: true });
  const from = await output.boundingBox(), to = await input.boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.id === 'repeat').inputs.completion?.[0]?.canvasNodeId === 'ordinary-painting');
  assert.equal(await page.evaluate(() => window.targetCalls), 0, 'running source does not trigger');
  await page.evaluate(() => window.setSession('ordinary-painting', 'done'));
  await page.waitForTimeout(1800);
  assert.equal(await page.evaluate(() => window.targetCalls), 0, 'status alone is not an output completion');
  await page.evaluate(() => window.setSession('ordinary-painting', 'done', true));
  await page.waitForFunction(() => window.targetCalls === 1);
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.run?.status === 'done');
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.id === 'repeat').triggerCount), 1);
  assert.ok(await page.evaluate(() => window.checkpoints.some(doc => doc.nodes.find(node => node.id === 'repeat')?.triggerCount === 1
    && doc.nodes.find(node => node.id === 'repeat').completionSeen.includes('ordinary-painting') && doc.run?.steps.target?.status === 'pending')), 'counter, event deduplication and pending run share a checkpoint');
  await page.evaluate(() => { window.emitChange(); window.emitChange(); window.emitChange(); });
  await page.waitForTimeout(1800);
  assert.equal(await page.evaluate(() => window.targetCalls), 1, 'duplicate notifications cannot consume another count');
  await page.evaluate(() => window.setSession('failed-turn', 'failed', true));
  await page.waitForTimeout(1800);
  assert.equal(await page.evaluate(() => window.targetCalls), 1, 'failed source does not trigger even with partial output');
  // A continued conversation can use a new job, while the visible card keeps its anchor.
  await page.evaluate(async () => {
    window.store.setState({ genJobs: { ...window.store.getState().genJobs,
      'ordinary-job': { conversationId: 'ordinary-job' }, 'next-job': { conversationId: 'ordinary-job' } } });
    await window.setSession('second-turn', 'running', true, 'next-job');
  });
  await page.waitForTimeout(1800);
  assert.equal(await page.evaluate(() => window.targetCalls), 1, 'partial images do not trigger a running turn');
  await page.evaluate(() => window.setSession('second-turn', 'done', true, 'next-job'));
  await page.waitForFunction(() => window.targetCalls === 2);
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.run?.status === 'done');
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.id === 'repeat').triggerCount), 0);
  await page.evaluate(() => window.setSession('third-turn', 'done', true));
  await page.waitForTimeout(1800);
  assert.equal(await page.evaluate(() => window.targetCalls), 2, 'zero count cannot trigger');
  // Reload sees an unconsumed historical success, but must never submit a new run for it.
  await page.evaluate(() => window.setSession('fourth-turn', 'done', true, 'late-job'));
  await page.evaluate(() => {
    const saved = JSON.parse(sessionStorage.getItem('workflow-p'));
    saved.document.nodes.find(node => node.id === 'repeat').triggerCount = 1;
    saved.document.nodes.find(node => node.id === 'repeat').completionSeen = ['ordinary-painting', 'second-turn'];
    sessionStorage.setItem('workflow-p', JSON.stringify(saved));
  });
  await page.reload();
  await page.locator('[data-workflow-card="repeat"]').waitFor();
  await page.evaluate(() => {
    window.store.setState({ genJobs: { ...window.store.getState().genJobs,
      'ordinary-job': { conversationId: 'ordinary-job' }, 'late-job': { conversationId: 'ordinary-job' } } });
    window.emitChange();
  });
  await page.waitForTimeout(1800);
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === 'generation_history').length), 0, 'reload does not replay historical completion');
  const newTriggerId = await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const c = canvasWorkflowController('p');
    const trigger = { ...newWorkflowNode('trigger', 1000, 700, ''), id: 'new-repeat' };
    const target = { ...newWorkflowNode('instruction', 1400, 700, 'codex'), id: 'new-target', action: 'reuse',
      inputs: { image: [{ assetId: 'existing' }], signal: [{ nodeId: trigger.id, portId: 'signal' }] } };
    await c.edit([...c.document.nodes, trigger, target]);
    return trigger.id;
  });
  await page.locator('[data-workflow-session-output]').first().press('Enter');
  await page.locator(`[data-workflow-card="${newTriggerId}"]`).getByRole('button', { name: '输入：完成触发', exact: true }).press('Enter');
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.id === 'new-repeat').inputs.completion?.length === 1);
  await page.waitForTimeout(1800);
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === 'generation_history').length), 0, 'connecting an already completed conversation cannot replay its results');
  console.log('native painting session: actual drag connection, pending/output ordering, atomic decrement, duplicate deduplication, failed turn, continued conversation, zero count and reload passed');
} finally { await browser.close(); await server.close(); }
