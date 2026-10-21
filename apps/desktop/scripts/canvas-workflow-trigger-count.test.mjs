import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

await mkdir('.tmp/trigger-count', { recursive: true });
const server = await createServer({ configFile: false, cacheDir: '.tmp/trigger-count/vite', optimizeDeps: { entries: ['scripts/fixtures/canvas-reference/preview.html'] }, server: { host: '127.0.0.1', port: 1683, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1200 } });
try {
  await page.goto('http://127.0.0.1:1683/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  const result = await page.evaluate(async () => {
    const { CanvasWorkflowController, canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode, workflowOrder, workflowConnectionError, assertWorkflowAcyclic } = await import('/src/lib/canvasWorkflow.ts');
    const { api } = await import('/src/lib/api.ts');
    const check = (value, message) => { if (!value) throw new Error(message); };
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.store.setState({ cloudAuth: { logged_in: true, user_id: 'tester' }, cloudEntitlement: { user_id: 'tester', is_test_account: true, balances: { daily: 0, sub: 0, topup: 0 }, policy: { can_use_cloud: true, can_use_byo: true }, generation_services: [] } });
    let calls = [], mode = 'done', snapshots = [], hold, cancelCalls = 0, cancelDone = false;
    const video = { id: 'repeat-video', name: '合成视频', store_path: '/synthetic-h3.mp4', ext: 'mp4', width: 672, height: 1216, duration: 8 };
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'canvas_workflow_save') snapshots.push(structuredClone(args.document));
      if (command === 'comfy_video_environment') return { phase: 'ready', endpoint: 'http://127.0.0.1:8000', message: '合成环境' };
      if (command === 'comfy_video') {
        if (args.action === 'cancel') { cancelCalls++; return { status: cancelDone ? 'done' : 'cancelled', message: '已停止' }; }
        if (args.action === 'start') { calls.push(args); if (mode === 'hold') await new Promise(resolve => { hold = resolve; }); }
        return mode === 'failed' ? { status: 'failed', message: '模拟失败' } : mode === 'unknown' ? { status: 'unknown', message: '模拟断线' } : { status: 'done', message: '完成', asset: video };
      }
      if (command === 'get_assets_by_ids') return [...await invoke(command, args), ...(args.assetIds.includes(video.id) ? [video] : [])];
      return invoke(command, args);
    };
    const make = (count = 2) => {
      const trigger = { ...newWorkflowNode('trigger', 940, 180, 'codex'), id: 'repeat', triggerCount: count, inputs: { completion: [{ nodeId: 'h3', portId: 'image' }] } };
      const h3 = { ...newWorkflowNode('comfy-video', 420, 180, 'codex'), id: 'h3', prompt: '合成测试', inputs: { 'first-frame': [{ assetId: 'existing' }], signal: [{ nodeId: 'repeat', portId: 'signal' }] } };
      return [trigger, h3];
    };
    let c = canvasWorkflowController('p'); await c.load();
    await c.edit(make());
    check(workflowConnectionError(c.document.nodes, 'h3', 'image', 'repeat', 'completion') === null, 'completion feedback accepted');
    assertWorkflowAcyclic(c.document.nodes, 'h3');
    check(workflowOrder(c.document.nodes, 'h3', true).join() === 'h3', 'completion receiver is not a data prerequisite');
    await c.start('h3', true);
    check(calls.length === 3 && new Set(calls.map(call => call.requestId)).size === 3, `two repeats use three independent jobs: ${JSON.stringify({ calls: calls.length, run: c.document.run, issue: c.issue })}`);
    check(c.document.nodes[0].triggerCount === 0 && c.document.run.status === 'done', 'counter reaches zero and terminates');
    check(window.snapshot().nodes.filter(node => node.id.startsWith('workflow-comfy:')).length === 3, 'each result remains on canvas');
    check(snapshots.some(doc => doc.nodes[0]?.triggerCount === 1 && doc.run?.steps.h3.status === 'pending'), 'decrement and next pending task saved atomically');
    await c.continue(); check(calls.length === 3, 'completed run cannot repeat on continue');

    calls = []; await c.edit(make(0)); await c.start('h3', true);
    check(calls.length === 1 && c.document.nodes[0].triggerCount === 0, 'zero has no automatic repeat');
    calls = []; mode = 'failed'; await c.edit(make(2)); await c.start('h3', true);
    check(calls.length === 1 && c.document.nodes[0].triggerCount === 2 && c.document.run.status === 'failed', 'failure does not consume count');

    calls = []; mode = 'unknown'; await c.edit(make(2)); await c.start('h3', true);
    check(calls.length === 1 && c.document.run.status === 'waiting' && c.document.nodes[0].triggerCount === 2, 'unknown task waits without decrement');
    const originalJob = calls[0].requestId;
    c = new CanvasWorkflowController('p'); await c.load();
    check(calls.length === 1, 'reload never submits'); mode = 'done'; await c.continue();
    check(calls.length === 3 && calls[0].requestId === originalJob && c.document.nodes[0].triggerCount === 0, 'recovery queries original then submits exactly two repeats');

    // Recover a snapshot taken after decrement but before the next job identity exists.
    const committed = snapshots.find(doc => doc.nodes[0]?.triggerCount === 1 && doc.run?.steps.h3.status === 'pending');
    await api.canvasWorkflowSave('p', c.revision, committed);
    c = new CanvasWorkflowController('p'); await c.load(); calls = [];
    check(c.document.nodes[0].triggerCount === 1, 'committed counter survives restart');
    await c.continue(); check(calls.length === 2 && c.document.nodes[0].triggerCount === 0, 'resume does not double-decrement committed event');

    calls = []; mode = 'hold'; await c.edit(make(2)); const running = c.start('h3', true);
    while (!hold) await new Promise(resolve => setTimeout(resolve, 5));
    check(c.isLocked('repeat'), 'receiver is locked with repeat scope');
    const stopping = c.stop(); mode = 'done'; hold(); await Promise.all([running, stopping]);
    check(calls.length === 1 && cancelCalls === 1 && c.document.nodes[0].triggerCount === 2 && c.document.run.status === 'stopped', 'stop does not trigger or decrement');

    calls = []; mode = 'hold'; hold = null; cancelDone = true; await c.edit(make(2));
    const stoppedRepeat = c.start('repeat');
    while (!hold) await new Promise(resolve => setTimeout(resolve, 5));
    const stopRepeat = c.stop(); mode = 'done'; hold(); await Promise.all([stoppedRepeat, stopRepeat]);
    await c.recoverComfyVideo(c.document.run.id, 'h3');
    check(calls.length === 1 && c.document.nodes[0].triggerCount === 2 && c.document.run.status === 'done', 'retrieving stopped video never rearms repeats');

    // Ordinary image generation acknowledges submission before completion; never count that receipt.
    const imageController = new CanvasWorkflowController('trigger-image'); await imageController.load();
    const base = window.snapshot().nodes.find(node => node.id === 'old');
    let imageCalls = [];
    window.store.setState({ startGeneration: async (...args) => {
      const identity = args[12], id = `gen-prompt:${identity.jobId}:${identity.turnKey}:0`;
      await api.projectCanvasNodeCreate({ ...base, id, projectId: 'trigger-image', kind: 'prompt', assetId: null, role: null,
        payloadJson: JSON.stringify({ schema_version: 1, job_id: identity.jobId, turn_key: identity.turnKey, status: 'running' }) });
      imageCalls.push({ ...identity, id }); return { accepted: true };
    } });
    const [imageTrigger] = make(1); imageTrigger.inputs.completion[0].nodeId = 'draw';
    const draw = { ...newWorkflowNode('generation', 0, 0, 'codex'), id: 'draw', prompt: '合成图片', inputs: { signal: [{ nodeId: 'repeat', portId: 'signal' }] } };
    await imageController.edit([imageTrigger, draw]);
    const imageRun = imageController.start('draw', true);
    const until = async predicate => { for (let i = 0; i < 500; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('image completion timed out'); };
    await until(() => imageCalls.length === 1);
    check(imageController.document.nodes[0].triggerCount === 1, 'submitted image does not consume count');
    const firstImage = imageCalls[0];
    await api.projectCanvasNodeUpdate(firstImage.id, { payloadJson: JSON.stringify({ schema_version: 1, job_id: firstImage.jobId, turn_key: firstImage.turnKey, status: 'done' }) });
    await api.projectCanvasNodeCreate({ ...base, id: 'trigger-image-output', projectId: 'trigger-image', assetId: 'a', role: 'output',
      payloadJson: JSON.stringify({ execution: { job_id: firstImage.jobId, turn_key: firstImage.turnKey } }) });
    await imageRun;
    check(imageCalls.length === 2 && imageController.document.nodes[0].triggerCount === 0, 'completed image starts exactly one repeat');

    // Reopen through the UI controller for port and count interaction checks.
    const ui = canvasWorkflowController('p'); ui.document = c.document; ui.revision = c.revision;
    await ui.edit(make(3));
    return { calls: 3, scenarios: 9 };
  });
  assert.equal(result.scenarios, 9);
  const trigger = page.locator('.workflow-card.is-trigger');
  await trigger.getByRole('spinbutton', { name: '剩余触发次数' }).fill('4');
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.id === 'repeat').triggerCount === 4);
  await trigger.getByRole('button', { name: '输入：完成触发', exact: true }).waitFor();
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const c = canvasWorkflowController('p');
    await c.edit(c.document.nodes.map(node => node.kind === 'trigger' ? { ...node, inputs: {} } : node));
  });
  await page.locator('.workflow-card.is-comfy-video').getByRole('button', { name: '输出：视频', exact: true }).press('Enter');
  await trigger.getByRole('button', { name: '输入：完成触发', exact: true }).press('Enter');
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.id === 'repeat').inputs.completion?.[0]?.nodeId === 'h3');
  await page.screenshot({ path: '.tmp/trigger-count/light.png' });
  console.log('trigger count: independent H3 jobs/results, zero, failure, unknown, reload, atomic counter recovery, stop, locked scope and UI passed');
} finally { await browser.close(); await server.close(); }
