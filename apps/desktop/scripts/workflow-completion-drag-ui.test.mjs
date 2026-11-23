import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const entry = 'scripts/fixtures/canvas-reference/preview.html';
const server = await createServer({
  configFile: false,
  resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
  cacheDir: '.tmp/workflow-completion-drag/vite',
  optimizeDeps: { entries: [entry] },
  server: { host: '127.0.0.1', port: 18796, strictPort: false, hmr: false, watch: null },
});
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
  page.setDefaultTimeout(8000);
  page.setDefaultNavigationTimeout(60000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const card = id => page.locator(`[data-workflow-card="${id}"]`);
  const handle = id => card(id).locator('button[data-workflow-completion-drag]');
  const draft = page.locator('path[data-workflow-completion-draft]');
  const state = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('workflow-p')).document);
  const waitForTrigger = () => page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.some(node => node.triggerMode === 'completion'));
  const point = async element => {
    const box = await element.boundingBox();
    assert.ok(box, 'the drag endpoint is visible');
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const startDrag = async (sourceId = 'source') => {
    const { x, y } = await point(handle(sourceId));
    await page.mouse.move(x, y);
    await page.mouse.down();
  };
  const dragToTarget = async (sourceId = 'source', targetId = 'target', destination = card(targetId).locator('header strong')) => {
    await startDrag(sourceId);
    const { x, y } = await point(destination);
    await page.mouse.move(x, y, { steps: 12 });
    await draft.waitFor({ state: 'attached' });
    assert.ok(await draft.getAttribute('d'), 'drag draws a line from the handle');
    await page.locator(`[data-connection-target="${targetId}"]:not(.is-invalid)`).waitFor();
    await page.mouse.up();
    await draft.waitFor({ state: 'detached' });
  };

  await page.goto(new URL(entry, server.resolvedUrls.local[0]).href);
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const controller = canvasWorkflowController('p');
    await controller.load();
    const source = { ...newWorkflowNode('instruction', 340, 180, 'codex'), id: 'source', action: 'reuse', inputs: { image: [{ assetId: 'existing' }] } };
    const target = { ...newWorkflowNode('instruction', 1120, 350, 'codex'), id: 'target', action: 'reuse', inputs: { image: [{ assetId: 'a' }] } };
    const generation = { ...newWorkflowNode('generation', 720, 610, 'codex'), id: 'generation' };
    await controller.edit([source, target, generation]);
    window.dragSaves = [];
    const save = api.canvasWorkflowSave;
    api.canvasWorkflowSave = async (...args) => {
      const revision = await save(...args);
      window.dragSaves.push(structuredClone(args[2]));
      return revision;
    };
    window.execution = { existing: 0, a: 0 };
    window.releaseExecution = {};
    api.generationHistory = async assetId => {
      if (++window.execution[assetId] === 1) await new Promise(resolve => { window.releaseExecution[assetId] = resolve; });
      return { turns: [{ prompt: '完成' }], references: [] };
    };
  });

  await handle('generation').waitFor();
  const wind = await handle('generation').boundingBox();
  const history = await card('generation').getByRole('button', { name: '生成历史', exact: true }).boundingBox();
  assert.ok(wind.x + wind.width <= history.x + 1, 'the handle sits to the left of generation history');
  await handle('source').click();
  assert.equal(await page.getByRole('menu').count(), 0, 'single click does not open a menu');
  assert.equal((await state()).nodes.length, 3);
  assert.equal(await draft.count(), 0);
  await startDrag();
  await page.mouse.move(760, 135, { steps: 8 });
  await draft.waitFor({ state: 'attached' });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await draft.waitFor({ state: 'detached' });
  assert.equal((await state()).nodes.length, 3, 'Escape cancels a drag');

  await startDrag();
  await page.mouse.move(760, 135, { steps: 8 });
  await page.mouse.up();
  assert.equal((await state()).nodes.length, 3, 'releasing on empty canvas creates nothing');
  await startDrag();
  const self = await point(card('source').locator('header strong'));
  await page.mouse.move(self.x, self.y + 18, { steps: 8 });
  await page.mouse.up();
  assert.equal((await state()).nodes.length, 3, 'releasing on the source creates nothing');

  await dragToTarget();
  await waitForTrigger();
  const wired = await state();
  const trigger = wired.nodes.find(node => node.triggerMode === 'completion');
  const source = wired.nodes.find(node => node.id === 'source');
  const target = wired.nodes.find(node => node.id === 'target');
  assert.ok(trigger.x > source.x + 320 && trigger.x + 196 < target.x, `the trigger sits in the horizontal gap: ${JSON.stringify([source.x, trigger.x, target.x])}`);
  assert.equal(trigger.triggerCount, 1);
  assert.equal(trigger.inputs.completion.length, 1);
  assert.equal(trigger.inputs.completion[0].nodeId, source.id);
  assert.equal(target.inputs.signal.length, 1);
  assert.equal(target.inputs.signal[0].nodeId, trigger.id);
  assert.ok((await page.evaluate(() => window.dragSaves)).filter(doc => doc.nodes.some(node => node.triggerMode === 'completion')).every(doc =>
    doc.nodes.find(node => node.triggerMode === 'completion').inputs.completion?.[0]?.nodeId === 'source'
      && doc.nodes.find(node => node.id === 'target').inputs.signal?.[0]?.nodeId === trigger.id), 'the trigger and both wires are saved together');
  await page.locator(`path[data-workflow-target="${trigger.id}"]`).waitFor({ state: 'attached' });
  await page.locator('path[data-workflow-signal-link="target"]').waitFor({ state: 'attached' });
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`);
  await card(trigger.id).waitFor({ state: 'detached' });
  await page.waitForFunction(() => {
    const document = JSON.parse(sessionStorage.getItem('workflow-p')).document;
    return document.nodes.length === 3 && !document.nodes.find(node => node.id === 'target').inputs.signal?.length;
  });

  await card('source').locator('header strong').hover();
  await card('source').locator('[data-canvas-connect-side="output"]').click();
  await page.getByRole('menu').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('menu').waitFor({ state: 'detached' });

  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const base = window.snapshot().nodes[0];
    await api.projectCanvasNodeCreate({ ...base, id: 'content', kind: 'note', assetId: null, role: null, x: 1120, y: 790, width: 330, height: 170,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', text: '', member_ids: [], cells: [[{ id: 'content-cell', text: '下游内容' }]] }) });
    window.emitChange();
  });
  await dragToTarget('source', 'content', page.locator('[data-canvas-node-id="content"] .canvas-text-handle'));
  await waitForTrigger();
  const contentsWired = await state();
  const contentsTrigger = contentsWired.nodes.find(node => node.kind === 'trigger');
  assert.equal(contentsWired.nodes.find(node => node.textSource === 'content').inputs.signal[0].nodeId, contentsTrigger.id);
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`);
  await page.waitForFunction(() => !JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.some(node => node.kind === 'trigger' || node.textSource === 'content'));

  await card('source').getByRole('button', { name: '运行此卡片', exact: true }).click();
  await card('target').getByRole('button', { name: '运行此卡片', exact: true }).click();
  await page.waitForFunction(() => window.releaseExecution.existing && window.releaseExecution.a);
  await dragToTarget();
  await waitForTrigger();
  await page.evaluate(() => window.releaseExecution.a());
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.runs.some(run => run.startId === 'target' && run.status === 'done'));
  assert.deepEqual(await page.evaluate(() => window.execution), { existing: 1, a: 1 }, 'a still running source does not launch another task');
  await page.evaluate(() => window.releaseExecution.existing());
  await page.waitForFunction(() => {
    const doc = JSON.parse(sessionStorage.getItem('workflow-p')).document;
    return window.execution.a === 2 && doc.nodes.find(node => node.triggerMode === 'completion')?.triggerCount === 0
      && !doc.runs.some(run => run.status === 'running' || run.status === 'waiting');
  });

  const submittedSession = 'gen-prompt:already-submitted:one:0';
  await page.evaluate(async id => {
    const { api } = await import('/src/lib/api.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const base = window.snapshot().nodes[0];
    const payload = { schema_version: 1, job_id: 'already-submitted', turn_key: 'one', text: '待完成图片' };
    await api.projectCanvasNodeCreate({ ...base, id, kind: 'prompt', assetId: null, role: null, x: 50, y: 630,
      payloadJson: JSON.stringify({ ...payload, status: 'running' }) });
    const c = canvasWorkflowController('p');
    await c.edit(c.document.nodes.map(node => node.id !== 'generation' ? node : { ...node, activeSessionNodeId: id, sessionNodeIds: [id],
      outputs: { image: { type: 'image', nodeIds: [id] } } }));
    window.emitChange();
    window.finishSubmittedImage = async () => {
      await api.projectCanvasNoteUpdate(id, JSON.stringify({ ...payload, status: 'done' }));
      await api.projectCanvasNodeCreate({ ...base, id: 'gen-output:already-submitted:one:0', assetId: 'd', role: 'output',
        payloadJson: JSON.stringify({ execution: { job_id: payload.job_id, turn_key: payload.turn_key } }) });
      window.emitChange();
    };
  }, submittedSession);
  await dragToTarget('generation');
  await page.waitForFunction(id => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.some(node =>
    node.inputs.completion?.some(input => input.pendingCompletionSession === id)), submittedSession);
  assert.equal(await page.evaluate(() => window.execution.a), 2, 'a submitted turn waits for its actual output');
  await page.evaluate(() => window.finishSubmittedImage());
  await page.waitForFunction(id => window.execution.a === 3 && JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.some(node =>
    node.triggerCount === 0 && node.completionSeen?.includes(id)), submittedSession);
  assert.deepEqual(errors, []);
  console.log('PASS drag-only completion handle, draft and cancel, atomic wiring and undo, regular plus, native content, running endpoints and submitted image completion');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}
