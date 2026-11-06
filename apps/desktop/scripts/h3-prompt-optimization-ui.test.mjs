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
      return { runId, status: resultMode, snapshot: { run: { safe_message: '模拟优化失败' }, events: [{ type: 'text.result', display_payload: { schemaVersion: 1, text: optimized } }] } };
    };
    api.cloudAgentGet = get;
    const node = { ...newWorkflowNode('comfy-video', 400, 60, 'codex'), id: 'h3', prompt: original, comfyVideo: comfyVideoOptionsForMode(DEFAULT_COMFY_VIDEO, 'text'), outputs: { image: { type: 'image', assetIds: ['previous'] } } };
    async function controller(base = node) {
      const c = new CanvasWorkflowController(`opt-${crypto.randomUUID()}`); await c.load(); await c.edit([base]); return c;
    }
    const direct = await controller(); await direct.start('h3', true);
    check(starts.length === 0 && calls.at(-1).input.prompt === original, 'ordinary generation never calls paid optimization');
    const beforeOptimization = calls.length, c = await controller();
    const downstream = { ...newWorkflowNode('comfy-video', 900, 60, 'codex'), id: 'downstream', prompt: '下游不可运行', inputs: { 'first-frame': [{ nodeId: 'h3', portId: 'image' }] } };
    await c.edit([node, downstream]); await c.optimizeComfyPrompt('h3');
    check(starts.length === 1 && calls.length === beforeOptimization, 'explicit optimization never starts a local video');
    check(c.document.run.status === 'done' && c.document.run.order.join() === 'h3', 'optimization completes independently without downstream execution');
    check(starts[0].textRewrite.source === original && starts[0].references.length === 0 && starts[0].agentRuntime === 'dsh', 'text-only DSH contract');
    check(starts[0].intentPrompt.length <= 4000 && starts[0].intentPrompt.includes('h3-video-prompt'), 'bundled skill fits intent limit');
    check(c.document.nodes[0].prompt === original && c.document.nodes[0].outputs.image.assetIds[0] === 'previous', 'optimization preserves prompt and previous video outputs');
    check(c.document.run.steps.h3.comfyOptimization.result === optimized, 'result is retained for review');
    await c.start('h3', true); check(starts.length === 1 && calls.at(-1).input.prompt === original, 'later generation still uses original until user applies result');

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

    const ui = canvasWorkflowController('p'); await ui.load(); await ui.edit([{ ...node, x: 800 }]);
  });
  const card = page.locator('[data-workflow-card="h3"]');
  assert.equal(await card.getByRole('checkbox').count(), 0);
  const before = await page.evaluate(() => ({ local: window.h3Calls.length, cloud: window.optimizeStarts.length }));
  await card.getByRole('button', { name: '优化提示词', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.run.status === 'done');
  assert.deepEqual(await page.evaluate(() => ({ local: window.h3Calls.length, cloud: window.optimizeStarts.length })), { local: before.local, cloud: before.cloud + 1 });
  await card.getByText('查看优化结果', { exact: true }).click();
  assert.match(await card.getByLabel('优化后的提示词', { exact: true }).inputValue(), /单一连续镜头/);
  assert.match(await card.getByLabel('本次原始提示词', { exact: true }).inputValue(), /她先看向/);
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.waitForFunction(theme => {
      const color = getComputedStyle(document.querySelector('[aria-label="优化后的提示词"]')).color;
      const channel = Number(color.match(/\d+/)?.[0]); return theme === 'light' ? channel < 100 : channel > 150;
    }, theme);
    await page.screenshot({ path: `.tmp/h3-optimization/${theme}.png` });
  }
  await card.getByRole('button', { name: '用作卡片指令', exact: true }).click();
  assert.match(await card.getByLabel('卡片指令', { exact: true }).inputValue(), /单一连续镜头/);
  await card.getByLabel('卡片指令', { exact: true }).fill('用户修改后的提示词');
  await card.getByRole('button', { name: '运行此卡片', exact: true }).click();
  await page.waitForFunction(n => window.h3Calls.length > n, before.local);
  assert.equal(await page.evaluate(() => window.h3Calls.at(-1).input.prompt), '用户修改后的提示词');
  assert.equal(await page.evaluate(() => window.optimizeStarts.length), before.cloud + 1);
  assert.equal(await card.getByText('查看优化结果', { exact: true }).count(), 1);
  assert.deepEqual(errors, []);
  console.log('H3 explicit optimization: no automatic Cloud/local chain; review/apply/edit then manual generation; three modes, entitlement, stop, account, invalid output, unknown submission and recovery passed');
} finally { await browser.close(); await server.close(); }
