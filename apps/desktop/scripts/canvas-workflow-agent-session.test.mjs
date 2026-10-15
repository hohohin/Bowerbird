import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 1647, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
try {
  await page.goto('http://127.0.0.1:1647/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  console.log(await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { CanvasWorkflowController, canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const { workflowSessionIds } = await import('/src/lib/canvasSessionOutputs.ts');
    const { useStore } = await import('/src/store.ts');
    const check = (ok, message) => { if (!ok) throw Error(message); };
    const requests = new Map(), responses = new Map(), jobs = new Map(), pending = [];
    let c, deliveries = 0, submissions = 0, failReply = false, rejectSubmit = false, textOnly = false;
    useStore.setState({ cloudEntitlement: { balances: { daily: 0, sub: 0, topup: 0 }, policy: { can_use_byo: true, can_use_cloud: true, max_parallel_jobs: 100 } } });
    api.agentDsWorkflowStart = async (id, prompt, source, purpose, images, scope, provider, transport, isolated, sessionGeneration) => {
      deliveries++;
      check(sessionGeneration === true && c.document.run.steps.agent.localDsGenerationMode === 'session', 'new protocol frozen before delivery');
      if (c.document.run.loop && transport === 'codex-cli') check(isolated === true, 'loop retains independent CLI sessions');
      requests.set(id, { id: crypto.randomUUID(), prompt: '画图 ' + deliveries, images, ratio: '3:4' });
      return { autoDelivered: true, path: 'isolated' };
    };
    api.agentDsWorkflowGenerationRequest = async id => textOnly || responses.has(id) ? null : requests.get(id) ?? null;
    api.agentDsWorkflowGenerationResponse = async (id, request, response) => {
      check(c.document.run.steps.agent.localDsGenerations[request.id].response, 'receipt durable before reply');
      if (failReply) { failReply = false; throw Error('模拟回传中断'); }
      responses.set(id, response);
    };
    api.agentDsWorkflowResult = async id => textOnly ? { schemaVersion: 1, requestId: id, text: '普通回答' }
      : responses.has(id) ? { schemaVersion: 1, requestId: id, text: responses.get(id).error || '已提交生成' } : null;
    api.agentDsWorkflowGenerationJob = async id => jobs.get(id) ?? null;
    api.localAgentFindAssetId = async path => (await api.getAssetsByIds(['a', 'b'])).find(asset => asset.store_path === path)?.id;
    api.codexCreateImage = async args => {
      submissions++;
      check(!args.internalAgent && args.conversationId === args.jobId, 'ordinary generation conversation reaches native API');
      check(args.provider === c.document.run.steps.agent.localDsImageProvider && args.ratio === '3:4', 'default provider and ratio preserved');
      const calls = Object.values(c.document.run.steps.agent.localDsGenerations);
      check(calls.some(call => call.jobId === args.jobId && call.turnKey === args.turnKey), 'identity persisted before submission');
      if (rejectSubmit) throw Error('引擎未登录');
      const sessionNodeId = `gen-prompt:${args.jobId}:${args.turnKey}:0`;
      check(c.document.nodes.find(node => node.id === 'agent').sessionNodeIds.includes(sessionNodeId), 'session link saved before submission');
      check(!workflowSessionIds(c.document.nodes).has(sessionNodeId), 'Agent session is visible as ordinary conversation');
      // Hold the actual IPC until after both loop iterations. Only started may unblock it.
      jobs.set(args.jobId, { status: 'running', images: [] });
      const completion = new Promise(resolve => pending.push({ args, release: resolve }));
      useStore.getState().applyGenChunk({ kind: 'started', job_id: args.jobId });
      await completion;
      return 'provider-session';
    };
    const agent = transport => ({ ...newWorkflowNode('agent', 20, 20, 'ignored'), id: 'agent', agentTransport: transport, prompt: '画图', inputs: { image: [{ assetId: 'a' }] } });
    const setup = async (provider = 'jimeng', transport = 'codex-cli', loop = false) => {
      useStore.setState({ defaultProvider: provider, activeGenProvider: provider === 'codex' ? 'jimeng' : 'codex' });
      c = new CanvasWorkflowController('session-' + crypto.randomUUID()); await c.load();
      const a = agent(transport);
      if (loop) a.inputs.image = [{ nodeId: 'loop', portId: 'image' }];
      await c.edit(loop ? [{ ...newWorkflowNode('loop', 0, 0, 'codex'), id: 'loop', inputs: { image: [{ assetId: 'a' }, { assetId: 'b' }] } }, a] : [a]);
    };
    for (const transport of ['codex-cli', 'local-ds']) for (const provider of ['codex', 'jimeng', 'bowerbird-cloud-image_hd']) {
      await setup(provider, transport, true);
      await Promise.race([c.start('loop', true), new Promise((_, reject) => setTimeout(() => reject(Error('loop waited for image completion')), 8000))]);
      check(c.document.run.status === 'done' && c.document.run.loop.completed.length === 2, JSON.stringify(c.issue));
      const steps = c.document.run.loop.completed.map(item => item.steps.agent);
      const receipts = steps.map(step => Object.values(step.localDsGenerations)[0].response.submitted);
      check(receipts.length === 2 && receipts[0].jobId !== receipts[1].jobId, 'independent tasks for each loop item');
      check(receipts.every(receipt => jobs.get(receipt.jobId).status === 'running'), 'loop completes while all image jobs are still running');
      check(c.document.nodes.find(node => node.id === 'agent').sessionNodeIds.length === 2, 'all loop session links retained');
      const counts = [submissions, deliveries];
      c = new CanvasWorkflowController(c.projectId); await c.load(); await c.continue();
      check(submissions === counts[0] && deliveries === counts[1], 'completed workflow reload never resubmits background jobs');
    }
    await setup(); failReply = true; await c.start('agent', true);
    check(c.document.run.status === 'waiting', 'reply failure parks workflow');
    let before = submissions;
    useStore.setState({ defaultProvider: 'codex' });
    c = new CanvasWorkflowController(c.projectId); await c.load(); await c.continue();
    check(c.document.run.status === 'done' && submissions === before, 'saved receipt recovery does not submit or await images');
    // Simulate interruption after native acceptance but before the receipt was persisted.
    await setup(); failReply = true; await c.start('agent', true);
    const call = Object.values(c.document.run.steps.agent.localDsGenerations)[0]; delete call.response;
    await c.save(); before = submissions;
    c = new CanvasWorkflowController(c.projectId); await c.load(); await c.continue();
    check(c.document.run.status === 'done' && submissions === before, 'recover running task by identity without re-submission');
    // A submitted session owns its lifetime even when the workflow is stopped during reply recovery.
    await setup(); failReply = true; await c.start('agent', true);
    const cancelled = [];
    api.cancelCodexCreate = async id => { cancelled.push(id); };
    api.agentDsWorkflowCancel = async () => {};
    await c.stop();
    check(c.document.run.status === 'stopped' && !cancelled.length, 'stopping workflow leaves already submitted conversation running');
    await setup(); failReply = true; await c.start('agent', true);
    const unknown = Object.values(c.document.run.steps.agent.localDsGenerations)[0]; delete unknown.response; jobs.delete(unknown.jobId);
    await c.save(); before = submissions;
    c = new CanvasWorkflowController(c.projectId); await c.load(); await c.continue();
    check(c.document.run.status === 'waiting' && submissions === before, 'unknown acceptance never replays billable request');
    rejectSubmit = true; await setup(); await c.start('agent', true); rejectSubmit = false;
    check(Object.values(c.document.run.steps.agent.localDsGenerations)[0].response.error.includes('引擎未登录'), 'submission rejection is returned to Agent');
    textOnly = true; await setup(); before = submissions; await c.start('agent', true);
    check(c.document.run.status === 'done' && submissions === before && !c.document.nodes[0].sessionNodeIds?.length, 'ordinary text creates no generation session');
    for (const item of pending) item.release();
    // Render a persisted ordinary conversation with its real Agent owner.
    const ui = canvasWorkflowController('p'); await ui.load();
    const canvas = await api.projectCanvasGet('p');
    const session = await api.projectCanvasNodeCreate({ ...canvas.nodes[0], id: 'agent-generated-session', kind: 'prompt', assetId: null, role: null,
      x: 550, y: 60, width: 260, height: 148, payloadJson: JSON.stringify({ schema_version: 1, job_id: 'ui-job', turn_key: 'ui-turn', text: '画图', provider: 'codex', status: 'running' }) });
    await ui.edit([{ ...agent('codex-cli'), sessionNodeIds: [session.id] }]);
    window.save();
    window.emitChange();
    return { submissions, deliveries, backgroundTasks: pending.length, sessionNodeId: session.id };
  }));
  await page.reload();
  const card = page.locator('.workflow-card.is-agent');
  assert.equal(await card.getByRole('button', { name: '输出：生成任务', exact: true }).count(), 0);
  assert.equal(await card.getByRole('button', { name: '输出：返回图片', exact: true }).count(), 1, 'one image port serves classification and asynchronous generation tasks');
  await page.locator('[data-workflow-session-link]').waitFor({ state: 'attached' });
  await page.reload();
  await page.locator('[data-workflow-session-link]').waitFor({ state: 'attached' });
  await page.screenshot({ path: '.tmp/agent-session-workflow.png' });
  console.log('PASS Agent task port, visible conversation link, real store submission, nonblocking loops and durable recovery');
} finally { await browser.close(); await server.close(); }
