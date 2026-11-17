import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

await mkdir('.tmp/session-completion', { recursive: true });
const server = await createServer({ configFile: false, resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } }, cacheDir: '.tmp/session-completion/vite', optimizeDeps: { entries: ['scripts/fixtures/canvas-reference/preview.html'] }, server: { host: '127.0.0.1', port: 1687, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
page.setDefaultTimeout(5000);
page.setDefaultNavigationTimeout(60000);
const selectMode = async (id, name) => {
  await page.locator(`[data-workflow-card="${id}"]`).getByRole('combobox', { name: '触发方式' }).click();
  await page.getByRole('option', { name, exact: true }).click();
};
try {
  await page.goto(server.resolvedUrls.local[0] + 'scripts/fixtures/canvas-reference/preview.html');
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
    const draw = { ...newWorkflowNode('generation', 160, 530, 'codex'), id: 'draw' };
    await c.edit([trigger, target, draw]);
    await c.save({ ...c.document, cardNames: { draw: '绘制概念图' } });
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
  const output = page.locator('[data-workflow-material="ordinary-painting"] [data-canvas-connect-side="output"]');
  await output.waitFor();
  await selectMode('repeat', '上游完成');
  // Start at the receiving trigger and drop on the session body, away from either output handle.
  const input = page.locator('[data-workflow-card="repeat"]').getByRole('button', { name: '输入：完成触发', exact: true });
  const progress = page.locator('#workflow-progress');
  await page.locator('[data-workflow-card="repeat"] header strong').hover();
  await progress.waitFor({ state: 'visible' });
  await input.locator('i').hover();
  await progress.waitFor({ state: 'hidden' });
  await input.focus();
  assert.equal(await progress.isVisible(), false, 'the completion port stays clear of the progress tooltip');
  const from = await input.locator('i').boundingBox(), to = await page.locator('[data-canvas-node-id="ordinary-painting"]').boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.id === 'repeat').inputs.completion?.[0]?.canvasNodeId === 'ordinary-painting');
  // A click on the same receiver can add a second source without disturbing the session binding.
  const selectGenerator = async () => {
    await input.locator('i').click();
    await page.getByRole('menuitem', { name: '连接已有卡片', exact: true }).click();
    await page.getByRole('menu', { name: '连接已有卡片', exact: true }).getByRole('menuitem', { name: '绘制概念图', exact: true }).click();
  };
  await selectGenerator();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.id === 'repeat').inputs.completion?.some(input => input.nodeId === 'draw'));
  await selectGenerator();
  const wired = await page.evaluate(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes);
  assert.deepEqual(wired.find(node => node.id === 'repeat').inputs.completion.map(input => input.canvasNodeId ?? input.nodeId), ['ordinary-painting', 'draw']);
  assert.deepEqual(wired.find(node => node.id === 'draw').inputs, {}, 'the generator has no dependency on its listener');
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
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const c = canvasWorkflowController('p');
    await c.connectAutomatic([{ type: 'image', binding: { canvasNodeId: 'second-turn', cellId: 'image' } }], { nodeId: 'repeat' });
    if (c.document.nodes.find(node => node.id === 'repeat').inputs.completion.length !== 2)
      throw Error('A later turn of an already monitored conversation added a duplicate listener');
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
  await selectMode('repeat', '手动点击');
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const c = canvasWorkflowController('p');
    await c.edit(c.document.nodes.map(node => node.id === 'repeat' ? { ...node, triggerCount: 1 } : node));
    await window.setSession('inactive-turn', 'done', true);
  });
  await page.waitForTimeout(1800);
  assert.equal(await page.evaluate(() => window.targetCalls), 2, 'manual mode cannot consume native session completions');
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.id === 'repeat').triggerCount), 1);
  await selectMode('repeat', '上游完成');
  await page.waitForTimeout(1800);
  assert.equal(await page.evaluate(() => window.targetCalls), 2, 'switching back to completion cannot replay inactive turns');
  await page.locator('[data-workflow-card="repeat"]').getByLabel('剩余触发次数').fill('0');
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
  await selectMode(newTriggerId, '上游完成');
  const sourceId = await page.evaluate(() => [...document.querySelectorAll('[data-workflow-material]')].map(element => element.dataset.workflowMaterial)
    .find(id => window.snapshot().nodes.some(node => node.id === id && node.kind === 'prompt')));
  assert.ok(sourceId, 'continued conversation has a visible output anchor');
  await page.locator(`[data-workflow-material="${sourceId}"] [data-canvas-connect-side="output"]`).press('Enter');
  await page.locator(`[data-workflow-card="${newTriggerId}"]`).getByRole('button', { name: '输入：完成触发', exact: true }).press('Enter');
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.id === 'new-repeat').inputs.completion?.length === 1);
  await page.waitForTimeout(1800);
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === 'generation_history').length), 0, 'connecting an already completed conversation cannot replay its results');
  // Run an actual generator first. Attach the listener both before the submission
  // receipt and after the workflow step releases its lock while the image is pending.
  for (const [awaitReceipt, status, direct = false, prewired = false] of [[false, 'done'], [false, 'done', true], [false, 'done', false, true], [true, 'done'], [true, 'failed']]) {
    const live = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
    try {
      await live.goto(server.resolvedUrls.local[0] + 'scripts/fixtures/canvas-reference/preview.html');
      await live.locator('[data-canvas-node-id="old"]').waitFor();
      await live.evaluate(async ({ direct, prewired }) => {
        const { api } = await import('/src/lib/api.ts');
        const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
        const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
        const c = canvasWorkflowController('p'); await c.load();
        const base = window.snapshot().nodes.find(n => n.id === 'old');
        const draw = { ...newWorkflowNode('generation', 250, 100, 'codex'), id: 'draw', prompt: '绘制海报' };
        const listen = { ...newWorkflowNode('trigger', 900, 170, ''), id: 'listen', triggerMode: 'completion', triggerCount: 2,
          inputs: prewired ? { completion: [{ nodeId: 'draw', portId: 'image' }] } : {} };
        const action = { ...newWorkflowNode('instruction', 900, 490, 'codex'), id: 'action', action: 'reuse',
          inputs: { image: [direct ? { nodeId: 'draw', portId: 'image' } : { assetId: 'existing' }], signal: [{ nodeId: 'listen', portId: 'signal' }] } };
        await c.edit([draw, listen, action]);
        await c.save({ ...c.document, cardNames: { draw: '绘制海报' } });
        window.liveCalls = 0;
        api.generationHistory = async () => {
          window.liveCalls++;
          await new Promise(resolve => { window.finishAction = resolve; });
          return { turns: [{ prompt: '完成' }], references: [] };
        };
        window.lockedSource = () => c.isLocked('draw');
        window.lockedTarget = () => c.isLocked('action');
        window.checkDataLock = () => c.connectAutomatic([{ binding: { nodeId: 'draw', portId: 'image' }, type: 'image' }], { nodeId: 'action' });
        window.store.setState({ codexHealth: { ok: true }, cloudAuth: { logged_in: true, cloud_available: true },
          cloudEntitlement: { policy: { can_use_byo: true }, balances: { daily: 10, sub: 0, topup: 0 } },
          startGeneration: async (...args) => {
            const { jobId, turnKey } = args[12], id = `gen-prompt:${jobId}:${turnKey}:0`;
            const payload = { schema_version: 1, job_id: jobId, turn_key: turnKey, text: '绘制海报', status: 'running' };
            await api.projectCanvasNodeCreate({ ...base, id, x: 1500, y: 200, role: null, kind: 'prompt', assetId: null, payloadJson: JSON.stringify(payload) });
            window.publishImage = async status => {
              await api.projectCanvasNodeUpdate(id, { payloadJson: JSON.stringify({ ...payload, status }) });
              await api.projectCanvasNodeCreate({ ...base, id: 'live-result', kind: 'asset', role: 'output', assetId: 'a',
                payloadJson: JSON.stringify({ execution: { job_id: jobId, turn_key: turnKey } }) });
              window.save(); window.emitChange();
            };
            await new Promise(resolve => { window.acceptSubmission = resolve; });
            return { accepted: true };
          } });
      }, { direct, prewired });
      const drawCard = live.locator('[data-workflow-card="draw"]');
      await drawCard.getByRole('button', { name: '运行此卡片', exact: true }).click();
      await live.waitForFunction(() => !!window.acceptSubmission && window.lockedSource());
      await assert.rejects(live.evaluate(() => window.checkDataLock()), /正在运行|正在使用/);
      if (prewired) assert.equal(await live.evaluate(() => window.lockedTarget()), false, 'the completion listener does not prelock its future target');
      if (awaitReceipt) {
        await live.evaluate(() => window.acceptSubmission());
        await live.waitForFunction(() => !window.lockedSource());
      }
      const endpoint = live.locator('[data-workflow-card="listen"]').getByRole('button', { name: '输入：完成触发' }).locator('i');
      if (awaitReceipt) {
        await endpoint.click();
        await live.getByRole('menuitem', { name: '连接已有卡片', exact: true }).click();
        await live.getByRole('menuitem', { name: '绘制海报', exact: true }).click();
      } else if (!prewired) {
        await endpoint.dragTo(drawCard.locator('header strong'));
      }
      await live.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes
        .find(node => node.id === 'listen').inputs.completion?.some(input => input.nodeId === 'draw'), null, { timeout: 5000 });
      if (!awaitReceipt) await live.evaluate(() => window.acceptSubmission());
      assert.equal(await live.evaluate(() => window.liveCalls), 0);
      await live.evaluate(result => window.publishImage(result), status);
      const expected = Number(status === 'done');
      if (expected) {
        await live.waitForFunction(() => !!window.finishAction, null, { timeout: 10000 });
        const editor = drawCard.locator('.workflow-prompt-editor .ProseMirror');
        assert.equal(await editor.evaluate(el => el.isContentEditable), !direct, 'only a data dependency locks the upstream generator while the downstream executes');
        if (!direct) {
          await editor.fill('为下一次生成修改提示词');
          await live.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(n => n.id === 'draw').prompt === '为下一次生成修改提示词');
          if (prewired) {
            await endpoint.click({ button: 'right' });
            await live.getByRole('menu', { name: '选择要断开的连线' }).getByRole('menuitem').click();
            await live.waitForFunction(() => !JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes
              .find(n => n.id === 'listen').inputs.completion?.length);
            assert.ok(await live.evaluate(() => window.lockedTarget()), 'disconnecting the monitored source preserves the active downstream task');
            const triggerCard = live.locator('[data-workflow-card="listen"]');
            const actionCard = live.locator('[data-workflow-card="action"]');
            const count = triggerCard.getByRole('spinbutton', { name: '剩余触发次数' });
            await count.fill('3');
            await live.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(n => n.id === 'listen').triggerCount === 3);
            await count.fill('1');
            await actionCard.getByRole('button', { name: '断开触发器连接' }).click({ button: 'right' });
            await live.getByRole('menu', { name: '选择要断开的连线' }).getByRole('menuitem').click();
            await live.waitForFunction(() => !JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(n => n.id === 'action').inputs.signal?.length);
            await triggerCard.getByRole('button', { name: '输出：触发' }).locator('i').dragTo(actionCard.locator('header strong'));
            await live.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(n => n.id === 'action').inputs.signal?.some(input => input.nodeId === 'listen'));
            assert.ok(await live.evaluate(() => window.lockedTarget()), 'rewiring the trigger leaves the existing generation running');
          }
        }
        await live.evaluate(() => window.finishAction());
      }
      await live.evaluate(() => { window.emitChange(); window.emitChange(); });
      await live.waitForTimeout(1800);
      assert.equal(await live.evaluate(() => window.liveCalls), expected);
      assert.equal(await live.evaluate(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(n => n.id === 'listen').triggerCount), 2 - expected);
    } finally { await live.close(); }
  }
  console.log('PASS reverse completion wiring, running and submitted sources, atomic decrement, failure, deduplication, continued conversations and reload');
} finally { await browser.close(); await server.close(); }
