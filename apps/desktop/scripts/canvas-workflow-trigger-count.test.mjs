import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

await mkdir('.tmp/trigger-count', { recursive: true });
const server = await createServer({ configFile: false, resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } }, cacheDir: '.tmp/trigger-count/vite', optimizeDeps: { entries: ['scripts/fixtures/canvas-reference/preview.html'] }, server: { host: '127.0.0.1', port: 1683, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1200 } });
try {
  await page.goto(new URL('scripts/fixtures/canvas-reference/preview.html', server.resolvedUrls.local[0]).href);
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  const result = await page.evaluate(async () => {
    const { CanvasWorkflowController, canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode, workflowOrder, workflowOutputs, workflowConnectionError, assertWorkflowAcyclic } = await import('/src/lib/canvasWorkflow.ts');
    const { api } = await import('/src/lib/api.ts');
    const check = (value, message) => { if (!value) throw new Error(message); };
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.store.setState({ cloudAuth: { logged_in: true, user_id: 'tester' }, cloudEntitlement: { user_id: 'tester', tier: 'pro', offline_state: 'fresh', is_test_account: true, balances: { daily: 0, sub: 0, topup: 0 }, policy: { can_use_cloud: true, can_use_byo: true }, generation_services: [] } });
    let calls = [], mode = 'done', snapshots = [], hold, cancelCalls = 0, cancelDone = false;
    const video = { id: 'repeat-video', name: '合成视频', store_path: '/synthetic-h3.mp4', ext: 'mp4', width: 672, height: 1216, duration: 8 };
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'canvas_workflow_save') {
        // Match the native execution-scope invariant; a permissive IPC mock hid this failure.
        for (const run of args.document.runs ?? (args.document.run ? [args.document.run] : [])) {
          if (!['running', 'waiting'].includes(run.status)) continue;
          const locked = run.lockedNodeIds ?? run.order, writes = run.writeNodeIds ?? run.order;
          if (run.order.some(id => !writes.includes(id)) || writes.some(id => !locked.includes(id))) throw new Error('工作流数据无效：执行范围未锁定');
        }
        snapshots.push(structuredClone(args.document));
      }
      if (command === 'comfy_video_environment') return { phase: 'ready', endpoint: 'http://127.0.0.1:8000', message: '合成环境' };
      if (command === 'comfy_video') {
        if (args.action === 'cancel') { cancelCalls++; throw new Error('Mac baseline must only stop waiting'); }
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
    check(c.document.nodes.find(node => node.id === 'h3').outputs.image.assetIds[0] === video.id, 'Mac baseline retains the inline video result');
    check(snapshots.some(doc => doc.nodes[0]?.triggerCount === 1 && doc.run?.steps.h3.status === 'pending'), 'decrement and next pending task saved atomically');
    await c.continue(); check(calls.length === 3, 'completed run cannot repeat on continue');

    calls = []; await c.edit(make(0)); await c.start('h3', true);
    check(calls.length === 1 && c.document.nodes[0].triggerCount === 0, 'zero has no automatic repeat');
    calls = []; mode = 'hold'; hold = null; await c.edit(make(0));
    const lateArmed = c.start('h3', true);
    while (!hold) await new Promise(resolve => setTimeout(resolve, 5));
    check(!c.isLocked('repeat'), 'disabled completion receiver was not part of the original reservation');
    await c.edit(c.document.nodes.map(node => node.id === 'repeat' ? { ...node, triggerCount: 1 } : node));
    mode = 'done'; hold(); await lateArmed;
    check(c.document.run.status === 'done' && calls.length === 2 && c.document.nodes[0].triggerCount === 0,
      `arming during generation reserves the next trigger before consuming its event: ${JSON.stringify(c.issue)}`);
    const lateRunId = c.document.run.id;
    const queuedBeforeExpansion = snapshots.find(doc => doc.run?.id === lateRunId && doc.run.triggerQueue?.includes('repeat') && !doc.run.writeNodeIds.includes('repeat'));
    window.lateQueued = structuredClone(queuedBeforeExpansion);
    window.h3SubmissionCount = () => calls.length;
    check(queuedBeforeExpansion, 'the last durable checkpoint matches a completed H3 with an unreserved queued trigger');
    await api.canvasWorkflowSave('p', c.revision, queuedBeforeExpansion);
    c = new CanvasWorkflowController('p'); await c.load(); calls = [];
    await c.continue(lateRunId);
    check(c.document.run.status === 'done' && calls.length === 1 && c.document.nodes[0].triggerCount === 0,
      'reload resumes the queued trigger exactly once without repeating the completed source');

    const contended = structuredClone(queuedBeforeExpansion);
    contended.nodes.push({ ...make()[1], id: 'busy-target' });
    const busyRun = { id: 'busy-run', threadId: 'busy-thread', startId: 'busy-target', status: 'waiting', order: ['busy-target'],
      lockedNodeIds: ['busy-target'], writeNodeIds: ['busy-target'], steps: { 'busy-target': { status: 'waiting' } } };
    contended.runs.push(busyRun); contended.run = busyRun;
    await api.canvasWorkflowSave('p', c.revision, contended);
    c = new CanvasWorkflowController('p'); await c.load(); calls = [];
    await c.continue(lateRunId);
    const waiting = c.document.runs.find(run => run.id === lateRunId);
    check(waiting.status === 'waiting' && waiting.triggerQueue.join() === 'repeat' && c.document.nodes[0].triggerCount === 1 && calls.length === 0,
      'new downstream conflict preserves the completion event and count without submitting');
    check(waiting.startId === 'repeat' && !waiting.order.length && !c.isLocked('h3') && c.isLocked('busy-target'),
      'only the independent running target stays locked while the trigger waits');
    await c.edit(c.document.nodes.map(node => node.id === 'h3' ? { ...node, prompt: '下次生成' } : node));
    await c.stop('busy-run'); await c.continue(lateRunId);
    check(c.document.runs.find(run => run.id === lateRunId).status === 'done' && calls.length === 2 && c.document.nodes[0].triggerCount === 0,
      'continuing after the other flow stops reserves both targets and consumes the event once');
    calls = []; mode = 'failed'; await c.edit(make(2)); await c.start('h3', true);
    check(calls.length === 1 && c.document.nodes[0].triggerCount === 2 && c.document.run.status === 'failed', 'failure does not consume count');

    calls = []; mode = 'unknown'; await c.edit(make(2)); await c.start('h3', true);
    check(calls.length === 1 && c.document.run.status === 'waiting' && c.document.nodes[0].triggerCount === 2, 'unknown task waits without decrement');
    const originalJob = calls[0].requestId;
    c = new CanvasWorkflowController('p'); await c.load();
    check(calls.length === 1, 'reload never submits'); mode = 'done'; await c.continue();
    check(calls.length === 3 && calls[0].requestId === originalJob && c.document.nodes[0].triggerCount === 0, 'recovery queries original then submits exactly two repeats');

    // Recover a snapshot taken after decrement but before the next job identity exists.
    const committed = structuredClone(snapshots.find(doc => doc.nodes[0]?.triggerCount === 1 && doc.run?.steps.h3.status === 'pending'));
    committed.nodes.push({ ...make()[1], id: 'prior-source', inputs: {} });
    committed.nodes[0].inputs.completion.push({ nodeId: 'prior-source', portId: 'image' });
    for (const run of [committed.run, ...committed.runs.filter(run => run.id === committed.run.id)]) {
      run.lockedNodeIds = [...new Set([...run.lockedNodeIds, 'prior-source', 'repeat'])];
      run.writeNodeIds = [...new Set([...run.writeNodeIds, 'prior-source', 'repeat'])];
    }
    await api.canvasWorkflowSave('p', c.revision, committed);
    c = new CanvasWorkflowController('p'); await c.load(); calls = [];
    check(c.document.nodes[0].triggerCount === 1, 'committed counter survives restart');
    check(!c.isLocked('prior-source') && c.isLocked('h3'), 'restart releases the previous completion source while retaining the current generation lock');
    await c.continue(); check(calls.length === 2 && c.document.nodes[0].triggerCount === 0, 'resume does not double-decrement committed event');

    calls = []; mode = 'hold'; hold = null; await c.edit(make(2)); const running = c.start('h3', true);
    while (!hold) await new Promise(resolve => setTimeout(resolve, 5));
    check(!c.isLocked('repeat'), 'an armed completion receiver stays editable while its source runs');
    const stopping = c.stop(); mode = 'done'; hold(); await Promise.all([running, stopping]);
    check(calls.length === 1 && cancelCalls === 0 && c.document.nodes[0].triggerCount === 2 && c.document.run.status === 'stopped', 'stop does not trigger or decrement');

    calls = []; mode = 'hold'; hold = null; await c.edit(make(2));
    const stoppedRepeat = c.start('h3', true);
    while (!hold) await new Promise(resolve => setTimeout(resolve, 5));
    const stopRepeat = c.stop(); mode = 'done'; hold(); await Promise.all([stoppedRepeat, stopRepeat]);
    await c.recoverComfyVideo(c.document.run.id);
    check(calls.length === 1 && c.document.nodes[0].triggerCount === 2 && c.document.run.status === 'done', 'retrieving stopped video never rearms repeats');

    // Ordinary image generation acknowledges submission before completion; never count that receipt.
    const imageController = new CanvasWorkflowController('trigger-image'); await imageController.load();
    const base = window.snapshot().nodes.find(node => node.id === 'old');
    let imageCalls = [];
    window.store.setState({ codexHealth: { ok: true }, startGeneration: async (...args) => {
      const identity = args[12], id = `gen-prompt:${identity.jobId}:${identity.turnKey}:0`;
      await api.projectCanvasNodeCreate({ ...base, id, projectId: 'trigger-image', kind: 'prompt', assetId: null, role: null,
        payloadJson: JSON.stringify({ schema_version: 1, job_id: identity.jobId, turn_key: identity.turnKey, status: 'running' }) });
      imageCalls.push({ ...identity, id }); return { accepted: true };
    } });
    const [imageTrigger] = make(1); imageTrigger.inputs.completion[0].nodeId = 'draw';
    const draw = { ...newWorkflowNode('generation', 0, 0, 'codex'), id: 'draw', prompt: '合成图片', inputs: { signal: [{ nodeId: 'repeat', portId: 'signal' }] } };
    await imageController.edit([imageTrigger, draw]);
    const imageRun = imageController.start('draw', true);
    const until = async predicate => { for (let i = 0; i < 500; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('image completion timed out: ' + JSON.stringify(imageController.issue)); };
    await until(() => imageCalls.length === 1);
    check(imageController.document.nodes[0].triggerCount === 1, 'submitted image does not consume count');
    const firstImage = imageCalls[0];
    await api.projectCanvasNodeUpdate(firstImage.id, { payloadJson: JSON.stringify({ schema_version: 1, job_id: firstImage.jobId, turn_key: firstImage.turnKey, status: 'done' }) });
    await api.projectCanvasNodeCreate({ ...base, id: 'trigger-image-output', projectId: 'trigger-image', assetId: 'a', role: 'output',
      payloadJson: JSON.stringify({ execution: { job_id: firstImage.jobId, turn_key: firstImage.turnKey } }) });
    await imageRun;
    check(imageCalls.length === 2 && imageController.document.nodes[0].triggerCount === 0, 'completed image starts exactly one repeat');

    // Completion is shared by executable cards, independent of their output data type.
    const variants = [
      ['generation', {}], ['generation', { generation: { media: 'video' } }],
      ['agent', { agentTransport: 'local-ds' }], ['agent', { agentTransport: 'codex-cli' }], ['agent', { agentTransport: 'cloud' }],
      ['instruction', { action: 'reuse' }], ['instruction', { action: 'describe' }], ['instruction', { action: 'layers' }],
      ['skill', {}], ['visual-profile', {}], ['comfy-video', {}],
    ];
    for (const [kind, settings] of variants) {
      const producer = { ...newWorkflowNode(kind, 0, 0, 'codex'), ...settings, id: 'producer' };
      const receiver = { ...newWorkflowNode('trigger', 400, 0, ''), id: 'receiver' };
      for (const port of workflowOutputs(producer)) check(workflowConnectionError([producer, receiver], producer.id, port.id, receiver.id, 'completion') === null, `${kind}/${port.id} supports completion connection`);
    }
    let reuseCalls = 0, agentCalls = 0;
    api.generationHistory = async () => { reuseCalls++; return { turns: [{ prompt: '复用提示词' }], references: [] }; };
    const { localChat } = await import('/src/lib/localChat.ts');
    const { chatDshStatus } = await import('/src/lib/chatCapabilities.ts');
    chatDshStatus.store.setState({ value: { localAvailable: true }, error: null });
    localChat.list = async () => [];
    localChat.getByRequest = async () => null;
    localChat.send = async input => {
      agentCalls++;
      const turnId = input.requestId;
      return { id: input.conversationId ?? crypto.randomUUID(), projectId: input.projectId, nodeId: input.agentNodeId, provider: input.provider,
        revision: agentCalls, status: 'done', submittedTurnId: turnId, messages: [{ turnId, role: 'assistant', status: 'done', text: '已完成合成测试' }] };
    };
    for (const transport of ['reuse', 'local-ds', 'codex-cli']) {
      const repeated = new CanvasWorkflowController(`trigger-${transport}`); await repeated.load();
      const source = { ...newWorkflowNode(transport === 'reuse' ? 'instruction' : 'agent', 0, 0, 'codex'),
        id: 'source', action: 'reuse', prompt: '完成测试', ...(transport === 'reuse' ? {} : { agentTransport: transport }),
        inputs: { ...(transport === 'reuse' ? { image: [{ assetId: 'existing' }] } : {}), signal: [{ nodeId: 'repeat', portId: 'signal' }] } };
      const receiver = { ...newWorkflowNode('trigger', 400, 0, ''), id: 'repeat', triggerCount: 2,
        inputs: { completion: workflowOutputs(source).map(port => ({ nodeId: source.id, portId: port.id })) } };
      await repeated.edit([receiver, source]);
      const before = transport === 'reuse' ? reuseCalls : agentCalls;
      await repeated.start('source', true);
      check(repeated.document.run.status === 'done', `${transport}: ${JSON.stringify(repeated.issue)}`);
      check((transport === 'reuse' ? reuseCalls : agentCalls) - before === 3 && repeated.document.nodes[0].triggerCount === 0,
        `${transport}: two output ports still consume one count per completion, with exactly two repeats`);
      await repeated.continue();
      check((transport === 'reuse' ? reuseCalls : agentCalls) - before === 3, `${transport}: completed continuation never repeats`);
    }

    const loopController = new CanvasWorkflowController('trigger-loop'); await loopController.load();
    const loop = { ...newWorkflowNode('loop', 0, 0, ''), id: 'loop', loopMode: 'images', inputs: { image: [{ assetId: 'a' }, { assetId: 'b' }] } };
    const reuse = id => ({ ...newWorkflowNode('instruction', 400, 0, ''), id, action: 'reuse' });
    const body = { ...reuse('body'), inputs: { image: [{ nodeId: loop.id, portId: 'image' }] } };
    const afterLoop = { ...reuse('after-loop'), inputs: { image: [{ assetId: 'c' }] } };
    const order = [];
    api.generationHistory = async id => { order.push(id); return { turns: [{ prompt: '复用提示词' }], references: [] }; };
    await loopController.edit([loop, body, afterLoop]);
    const { createdNodeIds: [loopTriggerId] } = await loopController.connectCompletionTrigger(loop.id, afterLoop.id, { x: 200, y: 0 });
    await loopController.start(loop.id);
    check(loopController.document.run.status === 'done', `loop completion finishes: ${JSON.stringify(loopController.issue)}`);
    check(order.join() === 'a,b,c' && loopController.document.nodes.find(node => node.id === loopTriggerId)?.triggerCount === 0,
      `loop completion fires once after all items: ${order}`);

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
    await c.edit(c.document.nodes.map(node => node.kind === 'trigger' ? { ...node, triggerMode: 'completion', inputs: {} } : node));
  });
  await trigger.getByRole('button', { name: '输入：完成触发', exact: true }).locator('i').dragTo(page.locator('[data-workflow-card="h3"] header strong'));
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.id === 'repeat').inputs.completion?.[0]?.nodeId === 'h3');
  await page.screenshot({ path: '.tmp/trigger-count/light.png' });
  const beforeResume = await page.evaluate(async () => {
    const { CanvasWorkflowController, canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const c = canvasWorkflowController('p');
    const queued = structuredClone(window.lateQueued);
    queued.run.status = 'waiting';
    queued.runs.find(run => run.id === queued.run.id).status = 'waiting';
    await c.save(queued);
    const restored = new CanvasWorkflowController('p');
    await restored.load();
    await c.save(restored.document);
    return window.h3SubmissionCount();
  });
  await trigger.getByRole('button', { name: '继续工作流', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.run.status === 'done');
  assert.equal(await page.evaluate(() => window.h3SubmissionCount()), beforeResume + 1, 'queued trigger exposes Continue and submits only its repeat');
  console.log('trigger count: H3, image/Agent/instruction completion, late arming, scope conflict, queued recovery UI, dedup, zero, failure, reload, atomic recovery and stop passed');
} finally { await browser.close(); await server.close(); }
