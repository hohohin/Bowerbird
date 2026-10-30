import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: '.tmp/generation-session-delivery-vite', optimizeDeps: { entries: ['scripts/fixtures/canvas-reference/preview.html'] }, server: { host: '127.0.0.1', port: 1696, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:1696/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  console.log(await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { CanvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const { canvasConversationCards } = await import('/src/lib/canvasConversationCards.ts');
    const { useStore } = await import('/src/store.ts');
    const check = (value, message) => { if (!value) throw Error(message); };
    const until = async predicate => { for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw Error('expected session delivery did not occur'); };
    const base = window.snapshot().nodes[0], calls = [];
    let controller, table, failWrite = '';
    const update = api.projectCanvasNoteUpdate;
    api.projectCanvasNoteUpdate = async (...args) => {
      const failure = failWrite; failWrite = '';
      if (failure === 'before') throw Error('before table save');
      const value = await update(...args);
      if (failure === 'after') throw Error('after table save');
      return value;
    };
    useStore.setState({ startGeneration: async (...args) => {
      const identity = args[12], id = `gen-prompt:${identity.jobId}:${identity.turnKey}:0`;
      await api.projectCanvasNodeCreate({ ...base, id, projectId: controller.projectId, kind: 'prompt', assetId: null, role: null,
        payloadJson: JSON.stringify({ schema_version: 1, job_id: identity.jobId, turn_key: identity.turnKey, status: 'running' }) });
      calls.push({ ...identity, id }); return { accepted: true };
    } });
    const setup = async (trigger = true) => {
      controller = new CanvasWorkflowController('generation-delivery-' + crypto.randomUUID()); await controller.load();
      table = 'table-' + crypto.randomUUID();
      await api.projectCanvasNodeCreate({ ...base, id: table, projectId: controller.projectId, kind: 'note', assetId: null, role: null,
        payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', text: '', member_ids: [], cells: [[{ id: 'anchor', text: '' }, { id: 'neighbor', text: '保留' }]] }) });
      const draw = { ...newWorkflowNode('generation', 0, 0, 'codex'), id: 'draw', prompt: '合成图片', inputs: trigger ? { signal: [{ nodeId: 'repeat', portId: 'signal' }] } : {} };
      const writer = { ...newWorkflowNode('text', 0, 0, ''), id: 'writer', inputs: { image: [{ nodeId: 'draw', portId: 'image' }] },
        textTarget: { nodeId: table, cellId: 'anchor', append: true, appendAxis: 'column', axisCellIds: ['anchor'], image: true } };
      const repeat = { ...newWorkflowNode('trigger', 0, 0, ''), id: 'repeat', triggerCount: 1, inputs: { completion: [{ nodeId: 'draw', portId: 'image' }] } };
      await controller.edit(trigger ? [draw, writer, repeat] : [draw, writer]);
    };
    const cells = () => JSON.parse(window.snapshot().nodes.find(node => node.id === table).payloadJson).cells.flat();
    const refs = () => cells().filter(cell => cell.generation_ref).map(cell => cell.generation_ref.session_node_id);
    const finish = async (call, status) => {
      await api.projectCanvasNodeUpdate(call.id, { payloadJson: JSON.stringify({ schema_version: 1, job_id: call.jobId, turn_key: call.turnKey, status }) });
      if (status === 'done') await api.projectCanvasNodeCreate({ ...base, id: `output-${call.jobId}`, projectId: controller.projectId, assetId: 'a', role: 'output',
        payloadJson: JSON.stringify({ execution: { job_id: call.jobId, turn_key: call.turnKey } }) });
    };

    await setup();
    const count = calls.length, running = controller.start('draw', true);
    await until(() => controller.document.run?.steps.draw.generationSubmission === 'submitted');
    await until(() => refs().length === 1);
    const first = calls[count];
    check(controller.document.run.steps.draw.status === 'running' && controller.document.run.steps.writer.status === 'pending', 'session enters its cell before completion-trigger wait releases writer');
    check(controller.document.nodes.find(node => node.id === 'repeat').triggerCount === 1, 'submission does not consume completion count');
    check(cells().find(cell => cell.id === 'neighbor').text === '保留', 'neighbor is unchanged');
    check(canvasConversationCards(window.snapshot().nodes, useStore.getState().genJobs).hiddenIds.has(first.id), 'pending session has no standalone presentation once delivered');
    await finish(first, 'done'); await running;
    check(controller.document.run.status === 'done' && calls.length === count + 2 && refs().length === 2 && new Set(refs()).size === 2, 'completed trigger repeats once; final writers never append delivered sessions twice');

    await setup();
    const failureCount = calls.length, failing = controller.start('draw', true);
    await until(() => refs().length === 1); await finish(calls[failureCount], 'failed'); await failing;
    check(controller.document.run.status === 'failed' && calls.length === failureCount + 1 && refs()[0] === calls[failureCount].id, 'generation failure preserves the submitted session inside its cell without repeating');

    for (const boundary of ['before', 'after']) {
      await setup(false); failWrite = boundary;
      const submitted = calls.length; await controller.start('draw', true);
      check(controller.document.run.status === 'waiting' && controller.document.run.steps.draw.generationSubmission === 'submitted', 'delivery failure retains the submitted task for retry');
      check(refs().length === (boundary === 'before' ? 0 : 1), 'write failure boundary matches persisted content');
      controller = new CanvasWorkflowController(controller.projectId); await controller.load(); await controller.continue();
      check(controller.document.run.status === 'done' && calls.length === submitted + 1 && refs().length === 1, `reload at ${boundary} save recovers one cell without resubmission`);
      await controller.continue(); check(refs().length === 1 && calls.length === submitted + 1, 'completed delivery is idempotent');
    }

    await setup();
    const restoredCount = calls.length, pending = controller.start('draw', true);
    await until(() => refs().length === 1 && controller.document.run.steps.draw.detail === '等待上游生成图片');
    const original = calls[restoredCount], saved = structuredClone(controller.document), projectId = controller.projectId;
    await controller.stop(); await pending;
    sessionStorage.setItem('workflow-' + projectId, JSON.stringify({ revision: controller.revision + 1, document: saved }));
    controller = new CanvasWorkflowController(projectId); await controller.load();
    const resumed = controller.continue();
    await until(() => controller.document.run.steps.draw.detail === '等待上游生成图片');
    check(refs().length === 1 && calls.length === restoredCount + 1, 'reload during completion wait retains the original delivery and job');
    await finish(original, 'failed'); await resumed;
    check(refs().length === 1 && calls.length === restoredCount + 1, 'failure after reload never duplicates the session');
    return 'PASS immediate generation session delivery: completion trigger, one repeat, failure, before/after save recovery and in-flight reload without duplicate cells or submission';
  }));
  assert.deepEqual(errors, []);
} finally { await browser.close(); await server.close(); }
