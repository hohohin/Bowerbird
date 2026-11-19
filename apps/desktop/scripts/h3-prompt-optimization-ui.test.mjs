import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

await mkdir('.tmp/h3-optimization', { recursive: true });
const server = await createServer({ configFile: false, resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } }, optimizeDeps: { entries: ['scripts/fixtures/canvas-reference/preview.html'] }, cacheDir: '.tmp/h3-optimization/vite', server: { host: '127.0.0.1', port: 1699, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(10000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:1699/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { CanvasWorkflowController, canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const { DEFAULT_COMFY_VIDEO, comfyVideoOptionsForMode } = await import('/src/lib/comfyVideo.ts');
    const check = (ok, message) => { if (!ok) throw Error(message); };
    const { cleanH3OptimizedPrompt } = await import('/src/lib/h3PromptOptimization.ts');
    check(cleanH3OptimizedPrompt('integrated_multimodal_description: 正文') === '正文', 'field label removed');
    check(cleanH3OptimizedPrompt('参考 <Picture 1>\n  integrated_multimodal_description：正文\n下一行') === '参考 <Picture 1>\n正文\n下一行', 'reference and line breaks preserved');
    check(cleanH3OptimizedPrompt('她说：<d>[Chinese] integrated_multimodal_description: </d>') === '她说：<d>[Chinese] integrated_multimodal_description: </d>', 'spoken literal preserved');
    const original = '她先看向画面左下，再抬眼看向右上。镜头先固定，最后快速拉远到半身，伴随子弹时间感。';
    const optimized = '单一连续镜头。开场固定低机位锁骨以上特写，她先看向画面左下。随后优雅地抬眼看向画面右上，镜头在最后快速后拉至半身，人物动作极慢，保持视线方向。';
    const entitlement = { user_id: 'tester', is_test_account: true, tier: 'pro', offline_state: 'fresh', balances: { daily: 0, sub: 0, topup: 0 }, policy: { can_use_byo: true, can_use_agent_runs: true, max_parallel_agent_runs: 3, allowed_agent_skills: ['bowerbird-unified-agent'], agent_budget_options: ['unified-standard'] }, generation_services: [] };
    window.store.setState({ cloudAuth: { logged_in: true, user_id: 'tester' }, cloudEntitlement: entitlement, openCloudAgentRun: () => {} });
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.h3Calls = []; window.optimizeStarts = [];
    const calls = window.h3Calls, starts = window.optimizeStarts, cancels = [];
    let resultMode = 'succeeded';
    const asset = { id: 'optimized-video', store_path: '/synthetic.mp4', ext: 'mp4', width: 768, height: 1344 };
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'comfy_video_environment') return { phase: 'ready', endpoint: args.endpoint, message: '就绪' };
      if (command === 'comfy_video') { calls.push(args); return { status: args.action === 'cancel' ? 'cancelled' : 'done', message: '模拟', asset }; }
      return invoke(command, args);
    };
    api.getAssetsByIds = async ids => ids.map(id => id === asset.id ? asset : { id, store_path: '/synthetic.png' });
    const start = async input => { starts.push(input); return { runId: `cloud-${starts.length}` }; };
    api.cloudAgentStart = start;
    api.cloudAgentCancel = async id => { cancels.push(id); };
    const get = async runId => {
      if (resultMode === 'offline') throw Error('网络连接失败，请继续查询原任务');
      return { runId, status: resultMode, snapshot: { run: { safe_message: '模拟优化失败' }, events: [{ type: 'text.result', display_payload: { schemaVersion: 1, text: `integrated_multimodal_description: ${optimized}` } }] } };
    };
    api.cloudAgentGet = get;
    const node = { ...newWorkflowNode('comfy-video', 400, 60, 'codex'), id: 'h3', prompt: original, comfyVideo: comfyVideoOptionsForMode(DEFAULT_COMFY_VIDEO, 'text'), outputs: { image: { type: 'image', assetIds: ['previous'] } } };
    async function controller(base = node) {
      const c = new CanvasWorkflowController(`opt-${crypto.randomUUID()}`); await c.load(); await c.edit([base]); return c;
    }
    for (const fail of ['canvasWorkflowAuthorize', 'canvasWorkflowSave']) {
      for (const action of ['optimize','run']) {
        const card = await controller();
        const originalMethod = api[fail];
        const prior = [starts.length,calls.length];
        api[fail] = async () => { throw Error('rejected pre-dispatch barrier'); };
        let rejected = false;
        try { await (action === 'optimize' ? card.optimizeComfyPrompt('h3') : card.start('h3',true)); }
        catch (error) { rejected = String(error).includes('rejected pre-dispatch barrier'); }
        finally { api[fail] = originalMethod; }
        check(rejected, action+' reports the rejected '+fail);
        check(prior[0]===starts.length && prior[1]===calls.length, action+' never dispatches after denied permission or failed initial save');
      }
    }
    for (const boundary of ['canvasWorkflowAuthorize', 'initial-save', 'submission-save']) {
      for (const action of ['optimize', 'run']) {
        for (const change of ['route', 'account', 'account-return', 'cancel']) {
          const card = await controller(), state = window.store.getState();
          const gate = Promise.withResolvers(), reached = Promise.withResolvers();
          const method = boundary === 'canvasWorkflowAuthorize' ? boundary : 'canvasWorkflowSave';
          const originalMethod = api[method], before = [starts.length, calls.filter(call => call.action === 'start').length];
          let writes = 0;
          api[method] = async (...args) => {
            if (++writes === (boundary === 'submission-save' ? 2 : 1)) { reached.resolve(); await gate.promise; }
            return originalMethod(...args);
          };
          try {
            const pending = action === 'optimize' ? card.optimizeComfyPrompt('h3') : card.start('h3', true);
            await reached.promise;
            await (action === 'optimize' ? card.start('h3', true) : card.optimizeComfyPrompt('h3'));
            check(before[0] === starts.length && before[1] === calls.filter(call => call.action === 'start').length, 'cross-action double click must not dispatch');
            if (change === 'route') window.store.setState({ projectRouteRevision: state.projectRouteRevision + 1 });
            if (change.startsWith('account')) window.store.setState({ cloudAuth: { logged_in: true, user_id: 'other' } });
            if (change === 'account-return') window.store.setState({ cloudAuth: state.cloudAuth });
            if (change === 'cancel') {
              if (card.startingAction('h3')) card.cancelStarting('h3');
              else void card.stop();
            }
            gate.resolve(); await pending;
            check(before[0] === starts.length && before[1] === calls.filter(call => call.action === 'start').length,
              action + ' must not dispatch after ' + change + ' during ' + boundary);
            if (card.document.run) check(card.document.run.status === 'stopped' && !card.document.run.steps.h3.jobId
              && !card.document.run.steps.h3.comfyOptimization?.submissionStarted, 'unsent work is terminal without a recoverable provider request');
          } finally { gate.resolve(); api[method] = originalMethod; window.store.setState({ projectRouteRevision: state.projectRouteRevision, cloudAuth: state.cloudAuth }); }
        }
      }
    }
    const direct = await controller(); await direct.start('h3', true);
    check(starts.length === 0 && calls.at(-1).input.prompt === original, 'ordinary generation never calls paid optimization');
    const beforeOptimization = calls.length, c = await controller();
    const downstream = { ...newWorkflowNode('comfy-video', 900, 60, 'codex'), id: 'downstream', prompt: '下游不可运行', inputs: { 'first-frame': [{ nodeId: 'h3', portId: 'image' }] } };
    await c.edit([node, downstream]); await c.optimizeComfyPrompt('h3');
    check(starts.length === 1 && calls.length === beforeOptimization, 'explicit optimization never starts a local video');
    check(c.document.run.status === 'done' && c.document.run.order.join() === 'h3', 'optimization completes independently without downstream execution');
    check(starts[0].textRewrite.source === original && starts[0].references.length === 0 && starts[0].agentRuntime === 'dsh', 'text-only DSH contract');
    check(starts[0].intentPrompt.startsWith('bowerbird:cloud-text-skill:v1\n') && starts[0].intentPrompt.length < 350, 'only skill identifier and parameters leave the client');
    const skillRequest = JSON.parse(starts[0].intentPrompt.split('\n')[1]);
    check(skillRequest.id === 'h3-video-prompt' && skillRequest.parameters.mode === node.comfyVideo.mode, 'VPS skill selection retains H3 mode');
    check(c.document.nodes[0].prompt === optimized && c.document.nodes[0].outputs.image.assetIds[0] === 'previous', 'optimization replaces prompt and preserves previous video outputs');
    check(c.document.run.steps.h3.comfyOptimization.result === optimized, 'result is retained for review');
    await c.start('h3', true); check(starts.length === 1 && calls.at(-1).input.prompt === optimized, 'manual generation uses optimized prompt');

    resultMode = 'offline'; const interrupted = await controller(); await interrupted.optimizeComfyPrompt('h3');
    const cloudId = interrupted.document.run.steps.h3.agentRunId, count = starts.length, localCount = calls.length;
    check(cloudId && interrupted.document.run.status === 'waiting', 'interrupted optimization retains identity');
    resultMode = 'succeeded'; const resumed = new CanvasWorkflowController(interrupted.projectId); await resumed.load(); await resumed.continue();
    check(starts.length === count && resumed.document.run.status === 'done' && calls.length === localCount, 'Cloud recovery never resubmits or generates');

    resultMode = 'failed'; const failed = await controller(); await failed.optimizeComfyPrompt('h3');
    check(failed.document.run.status === 'failed' && calls.length === localCount, 'failed optimization never falls back to generation');
    const denied = await controller(); window.store.setState({ cloudEntitlement: { ...entitlement, is_test_account: false } });
    const beforeDenied = starts.length; await denied.optimizeComfyPrompt('h3');
    check(starts.length === beforeDenied && denied.document.run.status === 'failed', 'Cloud entitlement remains enforced');
    window.store.setState({ cloudEntitlement: entitlement });

    resultMode = 'succeeded'; let release; let requested = false;
    api.cloudAgentStart = () => new Promise(resolve => { requested = true; release = () => resolve({ runId: 'late-cloud' }); });
    const stopped = await controller(); const execution = stopped.optimizeComfyPrompt('h3');
    while (!requested) await new Promise(resolve => setTimeout(resolve, 10));
    const stopping = stopped.stop(); release(); await Promise.all([execution, stopping]);
    check(cancels.includes('late-cloud') && calls.length === localCount, 'stop cancels late optimization without local calls');
    api.cloudAgentStart = start;

    for (const mode of ['reference', 'frames']) {
      const imageNode = { ...node, comfyVideo: comfyVideoOptionsForMode(DEFAULT_COMFY_VIDEO, mode), inputs: { 'first-frame': [{ assetId: 'first' }], 'last-frame': [{ assetId: 'last' }] } };
      const imageRun = await controller(imageNode); await imageRun.optimizeComfyPrompt('h3');
      const brief = starts.at(-1);
      check(brief.intentPrompt.includes(`"mode":"${mode}"`) && brief.intentPrompt.includes(`"lastFrameCount":${mode === 'frames' ? 1 : 0}`), 'mode-specific constraints');
      check(brief.references.length === 0 && !brief.intentPrompt.includes('127.0.0.1') && calls.length === localCount, 'no media or endpoint upload, no video generation');
    }

    api.cloudAgentGet = async id => { window.store.setState({ cloudAuth: { logged_in: true, user_id: 'other' } }); return get(id); };
    const switched = await controller(); await switched.optimizeComfyPrompt('h3');
    check(switched.document.run.status === 'waiting' && !switched.document.run.steps.h3.comfyOptimization.result, 'account switch blocks result delivery');
    window.store.setState({ cloudAuth: { logged_in: true, user_id: 'tester' } }); api.cloudAgentGet = get;
    await switched.continue(); check(switched.document.run.status === 'done' && calls.length === localCount, 'original account resumes optimization only');

    api.cloudAgentGet = async id => ({ runId: id, status: 'succeeded', snapshot: { run: {}, events: [{ type: 'text.result', display_payload: { schemaVersion: 1, text: '' } }] } });
    const invalid = await controller(); await invalid.optimizeComfyPrompt('h3');
    check(invalid.document.run.status === 'failed' && calls.length === localCount, 'invalid Cloud output never generates');
    api.cloudAgentGet = get;

    const unknown = await controller(); let unknownCalls = 0;
    api.cloudAgentStart = async () => { unknownCalls++; throw Error('提交结果未知'); };
    await unknown.optimizeComfyPrompt('h3');
    const saved = JSON.parse(sessionStorage.getItem(`workflow-${unknown.projectId}`));
    for (const run of [saved.document.run, ...(saved.document.runs ?? [])]) if (run?.steps.h3) { run.status = 'waiting'; run.steps.h3.status = 'waiting'; }
    sessionStorage.setItem(`workflow-${unknown.projectId}`, JSON.stringify(saved));
    const restored = new CanvasWorkflowController(unknown.projectId); await restored.load(); await restored.continue();
    check(unknownCalls === 1 && restored.document.run.status === 'failed', 'unknown submission is not automatically charged again');
    api.cloudAgentStart = start;

    const parallel = await controller(), second = { ...node, id: 'other-h3' };
    await parallel.edit([node, second]);
    const entered = Promise.withResolvers(), finish = Promise.withResolvers();
    api.cloudAgentStart = async input => { entered.resolve(); await finish.promise; return start(input); };
    const firstRun = parallel.optimizeComfyPrompt('h3'); await entered.promise;
    const previousVideos = calls.filter(call => call.action === 'start').length;
    try {
      await parallel.start('other-h3', true);
      check(calls.filter(call => call.action === 'start').length === previousVideos + 1, 'independent card dispatches while first request is held');
    } finally { finish.resolve(); api.cloudAgentStart = start; await firstRun; }

    const retryCard = await controller();
    await retryCard.optimizeComfyPrompt('h3');
    const firstOptimization = retryCard.document.run;
    const beforeRetry = starts.length;
    await retryCard.retryComfyPrompt('h3');
    check(starts.length === beforeRetry + 1 && starts.at(-1).textRewrite.source === original, 'retry optimizes the original source instead of the previous result');
    const history = retryCard.document.runs.filter(run => run.steps.h3?.comfyOptimization);
    check(history.length === 2 && history[0].id === firstOptimization.id && history.every(run => run.steps.h3.comfyOptimization.input.prompt === original),
      'both optimization attempts retain their original input');
    const reloaded = new CanvasWorkflowController(retryCard.projectId); await reloaded.load();
    check(reloaded.document.runs.filter(run => run.steps.h3?.comfyOptimization).length === 2, 'optimization history survives reload');
    const ui = canvasWorkflowController('p'); await ui.load(); await ui.edit([{ ...node, x: 800 }]);
  });
  const card = page.locator('[data-workflow-card="h3"]');
  assert.equal(await card.getByRole('checkbox').count(), 0);
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const controller = canvasWorkflowController('p');
    await controller.flush();
    const { promise, resolve } = Promise.withResolvers();
    window.releaseDraftWrite = resolve;
    window.dispatchTrace = [];
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (command, args) => {
      if(command === 'comfy_video' && args.action === 'start') window.dispatchTrace.push({ key: 'localDispatch' });
      return invoke(command,args);
    };
    for (const key of ['canvasWorkflowAuthorize','canvasWorkflowSave','projectCanvasGet','cloudAgentStart','projectThreadCreate']) {
      const original = api[key];
      api[key] = async (...args) => {
        window.dispatchTrace.push({ key, prompt: key === 'cloudAgentStart' ? args[0].textRewrite.source : undefined });
        if (key === 'canvasWorkflowSave') await promise;
        return original(...args);
      };
    }
  });
  const draft = card.getByLabel('卡片指令', { exact: true });
  await draft.fill('new');
  await draft.pressSequentially(' latest draft');
  const optimize = card.getByRole('button', { name: '优化提示词', exact: true });
  await optimize.evaluate(button => { button.click(); button.click(); });
  const feedback = await card.locator('.h3-optimize-action').evaluate(button =>
    new Promise(resolve => requestAnimationFrame(() => resolve(button.getAttribute('aria-busy')))));
  await page.evaluate(() => window.releaseDraftWrite());
  await page.waitForFunction(() => window.dispatchTrace.some(row => row.key === 'cloudAgentStart'));
  const prefix = await page.evaluate(() => window.dispatchTrace.slice(0,window.dispatchTrace.findIndex(row => row.key === 'cloudAgentStart') + 1));
  const queuedWrites = prefix.filter(row => row.key === 'canvasWorkflowSave').length;
  console.log('queued edit + optimize: native saves before dispatch',queuedWrites,'busy while first write blocked',feedback);
  assert.equal(prefix.at(-1).prompt,'new latest draft');
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.run.status === 'done');
  assert.equal(await page.evaluate(() => window.dispatchTrace.filter(row => row.key === 'cloudAgentStart').length),1,'same-turn clicks submit one optimization');
  const before = await page.evaluate(() => ({ local: window.h3Calls.length, cloud: window.optimizeStarts.length }));
  await card.getByRole('button', { name: '优化提示词', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.run.status === 'done');
  assert.deepEqual(await page.evaluate(() => ({ local: window.h3Calls.length, cloud: window.optimizeStarts.length })), { local: before.local, cloud: before.cloud + 1 });
  assert.match(await card.getByLabel('卡片指令', { exact: true }).inputValue(), /单一连续镜头/);
  assert.equal(await card.locator('details.comfy-optimization-result').count(), 0);
  const field = await card.locator('.comfy-video-prompt').boundingBox();
  const action = await card.getByRole('button', { name: '优化提示词', exact: true }).boundingBox();
  assert.ok(action.y > field.y + field.height / 2 && action.x + action.width <= field.x + field.width && action.y + action.height <= field.y + field.height);
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.waitForFunction(theme => {
      const color = getComputedStyle(document.querySelector('[aria-label="卡片指令"]')).color;
      const channel = Number(color.match(/\d+/)?.[0]); return theme === 'light' ? channel < 100 : channel > 150;
    }, theme);
    await page.screenshot({ path: `.tmp/h3-optimization/${theme}.png` });
  }
  assert.match(await card.getByLabel('卡片指令', { exact: true }).inputValue(), /单一连续镜头/);
  await card.getByLabel('卡片指令', { exact: true }).fill('用户修改后的提示词');
  await page.evaluate(() => { window.dispatchTrace.length = 0; });
  await card.getByRole('button', { name: '运行此卡片', exact: true }).evaluate(button => { button.click(); button.click(); });
  await page.waitForFunction(n => window.h3Calls.length > n, before.local);
  const directReads = await page.evaluate(() => window.dispatchTrace.slice(0,window.dispatchTrace.findIndex(row => row.key === 'localDispatch')).filter(row=>row.key==='projectCanvasGet').length);
  console.log('single text-only H3: native canvas reads before dispatch',directReads);
  assert.equal(feedback,'true','optimize must acknowledge the first click while a prior native save is outstanding');
  assert.ok(queuedWrites <= 4,`typed draft, run and submission must not wait for a write per character: ${queuedWrites}`);
  assert.equal(directReads,0,'standalone text-only card must not load the entire native canvas before dispatch');
  assert.equal(await page.evaluate(() => window.dispatchTrace.filter(row=>row.key==='localDispatch').length),1,'same-turn clicks dispatch one local task');
  assert.equal(await page.evaluate(() => window.h3Calls.at(-1).input.prompt), '用户修改后的提示词');
  assert.equal(await page.evaluate(() => window.optimizeStarts.length), before.cloud + 1);
  assert.equal(await card.getByText('查看优化结果', { exact: true }).count(), 0);
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const { api } = await import('/src/lib/api.ts');
    const ui = canvasWorkflowController('p');
    await ui.flush();
    const image = { ...newWorkflowNode('generation', 800, 60, 'minimax-h3-image'), provider: 'minimax-h3-image', id: 'image-h3',
      prompt: '一只玻璃杯', outputs: { image: { type: 'image', assetIds: ['previous'] } } };
    await ui.edit([image, { ...image, id: 'other-image', provider: 'codex', x: 1400 }]);
    api.cloudAgentGet = async runId => ({ runId, status: 'succeeded', snapshot: { run: {}, events: [
      { type: 'text.result', display_payload: { schemaVersion: 1, text: '透明玻璃杯，杯沿反射窗边的柔光。' } }] } });
  });
  assert.equal(await page.locator('[data-workflow-card="other-image"]').getByRole('button', { name: '优化提示词' }).count(), 0);
  await page.locator('[data-workflow-card="image-h3"]').getByRole('button', { name: '优化提示词', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes
    .some(node => node.id === 'image-h3' && node.prompt === '透明玻璃杯，杯沿反射窗边的柔光。'));
  const imageResult = await page.evaluate(() => {
    const request = window.optimizeStarts.at(-1);
    const doc = JSON.parse(sessionStorage.getItem('workflow-p')).document;
    return { request: JSON.parse(request.intentPrompt.split('\n')[1]), outputs: doc.nodes.find(n => n.id === 'image-h3').outputs };
  });
  assert.equal(imageResult.request.id, 'h3-image-prompt');
  assert.equal(imageResult.request.parameters.referenceCount, 0);
  assert.deepEqual(imageResult.outputs.image.assetIds, ['previous']);
  const imageCard = page.locator('[data-workflow-card="image-h3"]');
  await imageCard.getByRole('button', { name: '查看提示词优化历史', exact: true }).click();
  const history = page.getByRole('dialog', { name: '提示词优化历史', exact: true });
  await history.waitFor();
  assert.match(await history.innerText(), /一只玻璃杯/);
  assert.match(await history.innerText(), /透明玻璃杯，杯沿反射窗边的柔光/);
  await page.keyboard.press('Escape');
  const prior = await page.evaluate(() => window.optimizeStarts.length);
  await imageCard.getByRole('button', { name: '重试优化提示词', exact: true }).click();
  await page.waitForFunction(n => window.optimizeStarts.length === n + 1 &&
    JSON.parse(sessionStorage.getItem('workflow-p')).document.run.status === 'done', prior);
  assert.equal(await page.evaluate(() => window.optimizeStarts.at(-1).textRewrite.source), '一只玻璃杯');
  await imageCard.getByRole('button', { name: '查看提示词优化历史', exact: true }).click();
  await history.waitFor();
  assert.equal(await history.getByRole('heading', { name: '用户原文', exact: true }).count(), 2);
  await history.getByRole('button', { name: '恢复第 1 次用户原文', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(n => n.id === 'image-h3').prompt === '一只玻璃杯');
  await history.getByRole('button', { name: '恢复第 2 次优化结果', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(n => n.id === 'image-h3').prompt === '透明玻璃杯，杯沿反射窗边的柔光。');
  assert.equal(await page.evaluate(() => window.optimizeStarts.length), prior + 1, 'restoring history never submits another optimization');
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    api.cloudAgentGet = async runId => ({ runId, status: 'succeeded', snapshot: { run: {}, events: [
      { type: 'text.result', display_payload: { schemaVersion: 1, text: window.optimizeStarts.at(-1).textRewrite.source } }] } });
  });
  await imageCard.getByRole('button', { name: '优化提示词', exact: true }).click();
  await page.waitForFunction(() => {
    const doc = JSON.parse(sessionStorage.getItem('workflow-p')).document;
    return doc.run.status === 'failed' && doc.run.steps['image-h3'].error.includes('相同的提示词')
      && doc.nodes.find(node => node.id === 'image-h3').prompt === '透明玻璃杯，杯沿反射窗边的柔光。';
  });
  assert.deepEqual(errors, []);
  console.log('H3 explicit optimization: no automatic Cloud/local chain; direct replacement/edit then manual generation; three modes, entitlement, stop, account, invalid output, unknown submission and recovery passed');
} catch (error) { console.error(error); throw error; }
finally { await browser.close(); await server.close(); }
