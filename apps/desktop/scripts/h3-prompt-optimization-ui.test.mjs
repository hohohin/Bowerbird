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
  await page.goto('http://127.0.0.1:1699/scripts/fixtures/canvas-reference/preview.html', { waitUntil: 'commit' });
  await page.locator('[data-canvas-node-id="old"]').waitFor({ timeout: 90000 });
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { CanvasWorkflowController, canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const { DEFAULT_COMFY_VIDEO, comfyVideoOptionsForMode } = await import('/src/lib/comfyVideo.ts');
    const check = (ok, message) => { if (!ok) throw Error(message); };
    const { cleanH3OptimizedPrompt, restoreH3VideoAudioReference, restoreH3R2VReferences, h3R2VPromptReferences, h3OptimizationInstruction } = await import('/src/lib/h3PromptOptimization.ts');
    check(cleanH3OptimizedPrompt('integrated_multimodal_description: 正文') === '正文', 'field label removed');
    check(cleanH3OptimizedPrompt('参考 <Picture 1>\n  integrated_multimodal_description：正文\n下一行') === '参考 <Picture 1>\n正文\n下一行', 'reference and line breaks preserved');
    check(cleanH3OptimizedPrompt('她说：<d>[Chinese] integrated_multimodal_description: </d>') === '她说：<d>[Chinese] integrated_multimodal_description: </d>', 'spoken literal preserved');
    const audioOutput = '<Audio 1> 提供 (S1) 的音色。\n(S1) 用 <Audio 1> 的音色说：你好。';
    check(restoreH3VideoAudioReference('你好。', audioOutput) === audioOutput, 'the single connected recording may be introduced and cited by its valid tag');
    check(restoreH3VideoAudioReference('使用 <Audio 1>', audioOutput) === audioOutput, 'the same tag may appear in multiple sections');
    check(restoreH3VideoAudioReference('使用 <Audio 1>', '你好。') === '使用 <Audio 1>', 'existing audio references survive a rewrite');
    check(restoreH3VideoAudioReference('你好。', '使用 <Audio 2>') === '你好。', 'unknown audio refs are never accepted');
    const structured = 'integrated_multimodal_description: [Shot 1] 雨中的骑行者\n\noverall_soundscape: 雨声持续。\n\nnon_diegetic_music: N/A';
    check(cleanH3OptimizedPrompt(structured) === structured, 'a complete H3 structure keeps its field labels');
    const counts = h3R2VPromptReferences({ referenceImages: ['image-a', 'image-b'], referenceVideos: ['clip-private'], referenceAudios: ['sound-private'] });
    const r2vSource = '<Picture 2> 主体沿 <Video 1> 的运镜出现。';
    const r2vResult = '<Picture 2> 的主体沿 <Video 1> 的运镜出现，声场跟随 <Audio 1>。';
    check(restoreH3R2VReferences(r2vSource, r2vResult, counts) === r2vResult, 'valid mixed media tags can be retained and used');
    check(restoreH3R2VReferences(r2vSource, r2vResult.replace('<Picture 2>', '<Picture 1>'), counts) === r2vSource, 'role changes preserve the original');
    check(restoreH3R2VReferences(r2vSource, r2vResult.replace('<Video 1>', '<Video 2>'), counts) === r2vSource, 'unavailable references preserve the original');
    const r2vInstruction = h3OptimizationInstruction({ prompt: r2vSource, mode: 'r2v', seconds: 5, ratio: 'auto', firstFrameCount: 0, lastFrameCount: 0, ...counts });
    check(!r2vInstruction.includes('private') && JSON.parse(r2vInstruction.split('\n')[1]).parameters.referenceVideoCount === 1,
      'R2V optimization exposes media counts, never local asset identities');
    const original = '她先看向画面左下，再抬眼看向右上。镜头先固定，最后快速拉远到半身，伴随子弹时间感。';
    const optimized = '单一连续镜头。开场固定低机位锁骨以上特写，她先看向画面左下。随后优雅地抬眼看向画面右上，镜头在最后快速后拉至半身，人物动作极慢，保持视线方向。';
    const entitlement = { user_id: 'tester', is_test_account: true, tier: 'pro', offline_state: 'fresh', balances: { daily: 0, sub: 0, topup: 0 }, policy: { can_use_byo: true, can_use_agent_runs: true, max_parallel_agent_runs: 3, allowed_agent_skills: ['bowerbird-unified-agent'], agent_budget_options: ['unified-standard'] }, generation_services: [] };
    window.store.setState({ cloudAuth: { logged_in: true, user_id: 'tester' }, cloudEntitlement: entitlement, openCloudAgentRun: () => {} });
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.h3Calls = []; window.optimizeStarts = [];
    const calls = window.h3Calls, starts = window.optimizeStarts, cancels = [];
    let resultMode = 'succeeded';
    let missingImageMode;
    const asset = { id: 'optimized-video', store_path: '/synthetic.mp4', ext: 'mp4', width: 768, height: 1344 };
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (missingImageMode && command === 'comfy_video_environment' && args.action === 'detect' && args.mode === missingImageMode) {
        return { phase: 'missing', endpoint: args.endpoint, existing: [], installed: false, canInstall: true, message: '模拟本机图片模型缺失' };
      }
      if (command === 'comfy_video_environment') return args.action === 'prepare' && window.h3PrepareFails
        ? { phase: 'failed', endpoint: args.endpoint, message: '模拟本机启动失败' }
        : { phase: 'ready', endpoint: args.endpoint, message: '就绪' };
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

    const setAutoOptimize = enabled => window.store.setState(state => ({
      settings: { ...state.settings, h3_auto_optimize_prompt: enabled },
    }));
    setAutoOptimize(true);
    const automatic = await controller();
    const autoStartCount = starts.length, autoLocalCount = calls.length;
    let allowResult;
    const pausedResult = new Promise(resolve => { allowResult = resolve; });
    api.cloudAgentGet = async runId => { await pausedResult; return get(runId); };
    resultMode = 'succeeded';
    const autoRunning = automatic.start('h3', true);
    try {
      for (let attempt = 0; starts.length === autoStartCount && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      check(starts.length === autoStartCount + 1, 'opted-in Run starts one Cloud optimization');
      check(calls.length === autoLocalCount, 'local video waits for a valid optimization result');
    } finally { allowResult(); await autoRunning; api.cloudAgentGet = get; }
    check(automatic.document.run.status === 'done' && calls.length === autoLocalCount + 1 && calls.at(-1).input.prompt === optimized,
      'one opted-in Run immediately generates video with the optimized prompt');
    check(automatic.document.nodes[0].prompt === optimized, 'auto optimization fills the card editor before generation');

    const interruptedAuto = await controller();
    resultMode = 'offline';
    await interruptedAuto.start('h3', true);
    check(interruptedAuto.document.run.status === 'waiting' && calls.length === autoLocalCount + 1, 'auto run waits on the original optimization after a connection error');
    const autoRunId = interruptedAuto.document.run.steps.h3.agentRunId;
    const reconnect = new CanvasWorkflowController(interruptedAuto.projectId); await reconnect.load();
    resultMode = 'succeeded';
    setAutoOptimize(false);
    await reconnect.continue();
    setAutoOptimize(true);
    check(reconnect.document.run.steps.h3.agentRunId === autoRunId &&
      starts.length === autoStartCount + 2 && calls.length === autoLocalCount + 2 && calls.at(-1).input.prompt === optimized,
      'recovery resumes the same optimization even after disabling the global preference');

    const failedAuto = await controller();
    resultMode = 'failed'; await failedAuto.start('h3', true);
    check(failedAuto.document.run.status === 'failed' && calls.length === autoLocalCount + 2, 'a failed auto optimization cannot submit a local video');
    resultMode = 'succeeded';

    const stopAuto = await controller();
    const pendingCloud = Promise.withResolvers();
    api.cloudAgentStart = input => { starts.push(input); return pendingCloud.promise; };
    const autoCloudBeforeStop = starts.length;
    const pendingAuto = stopAuto.start('h3', true);
    try {
      for (let attempt = 0; starts.length === autoCloudBeforeStop && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      check(starts.length === autoCloudBeforeStop + 1, 'auto optimization begins before cancelling');
      const stopping = stopAuto.stop();
      pendingCloud.resolve({ runId: 'late-auto-cloud' });
      await stopping;
    } finally {
      pendingCloud.resolve({ runId: 'late-auto-cloud' });
      await pendingAuto;
      api.cloudAgentStart = start;
    }
    check(cancels.includes('late-auto-cloud') && stopAuto.document.run.status === 'stopped' && calls.length === autoLocalCount + 2,
      'stop during auto optimization cancels the original Cloud receipt without generating');

    const wholeWorkflow = await controller();
    const beforeWorkflow = starts.length;
    await wholeWorkflow.start('h3');
    check(starts.length === beforeWorkflow && calls.at(-1).input.prompt === original,
      'only an opted-in explicit card Run starts paid optimization');
    const environmentAuto = await controller();
    const beforeEnvironment = calls.length;
    window.h3PrepareFails = true;
    try { await environmentAuto.start('h3', true); }
    finally { window.h3PrepareFails = false; }
    check(environmentAuto.document.run.status === 'waiting' && environmentAuto.document.run.steps.h3.comfyOptimization.result === optimized &&
      calls.length === beforeEnvironment, 'local startup failure preserves the paid result for recovery');
    await environmentAuto.continue();
    check(environmentAuto.document.run.status === 'done' && starts.length === beforeWorkflow + 1 &&
      calls.length === beforeEnvironment + 1 && calls.at(-1).input.prompt === optimized, 'retrying local startup never repeats the Cloud request');

    const sourceImage = { ...newWorkflowNode('generation', 400, 60, 'minimax-h3-image'), id: 'source-image',
      outputs: { image: { type: 'image', assetIds: ['synthetic-upstream-image'] } } };
    const canvasRef = { assetId: 'existing', assetNodeId: 'old' };
    const image = { ...newWorkflowNode('generation', 800, 60, 'minimax-h3-image'), id: 'auto-image',
      ratio: '4:3', prompt: '画一只玻璃杯，参考 @[glass-shape] 的轮廓。',
      inputs: { image: [canvasRef, { nodeId: sourceImage.id, portId: 'image' }],
        text: [{ autoConnect: 'lighting', dimension: { id: 'lighting', title: '光线', body: '窗光从左侧照入。' } }] },
      promptReferences: [{ id: 'glass-shape', type: 'image', label: '杯子轮廓', assetId: canvasRef.assetId, input: canvasRef }] };
    const imageSource = '画一只玻璃杯，参考 @图片1 的轮廓。\n\n【参考文本】\n窗光从左侧照入。';
    const optimizedImage = imageSource.replace('一只玻璃杯', '一只透明玻璃杯');
    const cloudImageResult = (runId, prompt) => ({ runId, status: resultMode, snapshot: { run: { safe_message: '模拟优化失败' }, events: [
      { type: 'text.result', display_payload: { schemaVersion: 1, text: prompt } }] } });
    const getImageResult = async runId => {
      if (resultMode === 'offline') throw Error('网络连接失败，请继续查询原任务');
      return cloudImageResult(runId, starts.at(-1).textRewrite.source.replace('一只玻璃杯', '一只透明玻璃杯'));
    };
    const imageCalls = [];
    const { startGeneration } = window.store.getState(), getAssets = api.getAssetsByIds;
    window.store.setState({ startGeneration: async (...args) => { imageCalls.push(args); return { accepted: true, jobId: args[12].jobId }; } });
    api.getAssetsByIds = async ids => (await getAssets(ids)).reverse();
    api.cloudAgentGet = getImageResult;
    async function imageController(autoOptimize) {
      setAutoOptimize(autoOptimize);
      const card = await controller(sourceImage);
      await card.edit([sourceImage, { ...image, ...(!autoOptimize ? { comfyAutoOptimize: true } : {}) }]);
      return card;
    }
    function checkImageSubmit(expectedPrompt, message) {
      const [prompt, assets, ratio, provider, rawPrompt, , , , , context, onStarted, , identity] = imageCalls.at(-1);
      check(prompt === expectedPrompt && rawPrompt === imageSource && ratio === '4:3' && provider === 'minimax-h3-image'
        && assets.map(asset => asset.id).join() === 'existing,synthetic-upstream-image' && context.referenceNodeIds.join() === 'old,'
        && context.referenceNodeIds[1] === null && onStarted && identity.jobId && identity.turnKey, message);
    }
    try {
      const imageCloudBefore = starts.length;
      const defaultImage = await imageController(false);
      await defaultImage.start(image.id, true);
      check(starts.length === imageCloudBefore && imageCalls.length === 1, 'H3 image defaults to direct generation');
      checkImageSubmit(imageSource, 'direct H3 image receives the compiled prompt and ordered reference origins');
      const workflowImage = await imageController(true);
      await workflowImage.start(image.id);
      check(starts.length === imageCloudBefore && imageCalls.length === 2, 'a whole workflow never starts paid H3 image optimization');

      for (const mode of ['image', 'edit']) {
        missingImageMode = mode;
        const missingImage = mode === 'edit' ? await imageController(true) : await controller({ ...image,
          prompt: '画一只玻璃杯', inputs: {}, promptReferences: [] });
        await missingImage.start(image.id, true);
        check(missingImage.document.run.status === 'failed' && starts.length === imageCloudBefore && imageCalls.length === 2,
          `missing H3 ${mode} environment prevents paid optimization and local generation`);
      }
      missingImageMode = undefined;

      const pausedImage = await imageController(true);
      resultMode = 'offline';
      await pausedImage.start(image.id, true);
      const pendingImage = pausedImage.document.run.steps[image.id];
      check(pausedImage.document.run.status === 'waiting' && pendingImage.agentRunId && starts.length === imageCloudBefore + 1
        && imageCalls.length === 2, `H3 image waits on the original paid request before local submission (${pendingImage.status}: ${pendingImage.error ?? ''})`);
      const brief = starts.at(-1);
      const skill = JSON.parse(brief.intentPrompt.split('\n')[1]);
      check(skill.id === 'h3-image-prompt' && skill.parameters.referenceCount === 2 && skill.parameters.ratio === '4:3'
        && brief.textRewrite.source === image.prompt.replace('@[glass-shape]', '{{REF_1}}') && brief.references.length === 0
        && !JSON.stringify(brief).includes('synthetic-upstream-image') && !JSON.stringify(brief).includes('/synthetic.png'),
        'only the editable text with reference placeholders and image constraints leaves the device');

      const key = `workflow-${pausedImage.projectId}`;
      const saved = JSON.parse(sessionStorage.getItem(key));
      saved.document.nodes.find(node => node.id === sourceImage.id).outputs.image.assetIds = ['new-upstream-image'];
      sessionStorage.setItem(key, JSON.stringify(saved));
      resultMode = 'succeeded';
      const reopenedImage = new CanvasWorkflowController(pausedImage.projectId);
      await reopenedImage.load();
      check(reopenedImage.document.nodes.find(node => node.id === sourceImage.id).outputs.image.assetIds[0] === 'new-upstream-image',
        'the persisted upstream output changed while this run was waiting');
      await reopenedImage.continue();
      await reopenedImage.continue();
      check(reopenedImage.document.run.status === 'done' && reopenedImage.document.run.steps[image.id].agentRunId === pendingImage.agentRunId
        && starts.length === imageCloudBefore + 1 && imageCalls.length === 3, 'reopen queries the same optimization and submits the local image exactly once');
      checkImageSubmit(optimizedImage, 'recovered H3 image preserves reference order, origins, and raw prompt for the generation session');
      const reopenedCard = reopenedImage.document.nodes.find(node => node.id === image.id);
      check(reopenedCard.prompt === image.prompt.replace('一只玻璃杯', '一只透明玻璃杯'),
        'recovery fills the editor without flattening upstream text or image references');
      check(reopenedCard.promptReferences.some(ref => ref.id === 'glass-shape'), 'the editable image reference remains connected');
      const reopenedStep = reopenedImage.document.run.steps[image.id].comfyOptimization;
      check(reopenedStep.input.prompt === image.prompt && reopenedStep.result === reopenedCard.prompt, 'auto optimization records both editable drafts');

      const invalidImage = await imageController(true);
      api.cloudAgentGet = async runId => cloudImageResult(runId, '一只透明玻璃杯。');
      await invalidImage.start(image.id, true);
      check(invalidImage.document.run.status === 'failed' && imageCalls.length === 3, 'losing an inline reference prevents image submission');

      const stoppedImage = await imageController(true);
      const receipt = Promise.withResolvers(), submitted = Promise.withResolvers();
      api.cloudAgentStart = input => { starts.push(input); submitted.resolve(); return receipt.promise; };
      const startingImage = stoppedImage.start(image.id, true);
      try {
        await Promise.race([submitted.promise, startingImage]);
        check(stoppedImage.document.run?.status === 'running', 'image optimization reached the Cloud submission boundary');
        const stopImage = stoppedImage.stop();
        receipt.resolve({ runId: 'late-image-cloud' });
        await stopImage;
      } finally { receipt.resolve({ runId: 'late-image-cloud' }); await startingImage; }
      check(stoppedImage.document.run.status === 'stopped' && cancels.includes('late-image-cloud') && imageCalls.length === 3,
        'stopping an H3 image run cancels a late Cloud receipt without submitting local generation');

      api.cloudAgentStart = start;
      const backgroundImage = await imageController(true), beforeBackground = starts.length;
      await backgroundImage.start(image.id, true, true);
      for (let attempt = 0; backgroundImage.document.run.status === 'running' && attempt < 100; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      check(backgroundImage.document.run.status === 'done' && starts.length === beforeBackground && imageCalls.length === 4,
        'a single image card started in the background bypasses paid optimization');
    } finally {
      missingImageMode = undefined;
      api.cloudAgentStart = start;
      api.cloudAgentGet = get;
      api.getAssetsByIds = getAssets;
      window.store.setState({ startGeneration });
    }
    const audioReference = await controller({ ...node, comfyVideo: comfyVideoOptionsForMode(DEFAULT_COMFY_VIDEO, 'reference'),
      inputs: { 'first-frame': [{ assetId: 'a' }], 'reference-audio': [{ assetId: 'recording-private-id' }] } });
    api.cloudAgentGet = async runId => ({ ...await get(runId), snapshot: { events: [{ type: 'text.result', display_payload: { schemaVersion: 1, text: audioOutput } }] } });
    api.getAssetsByIds = async ids => (await getAssets(ids)).map(entry => entry.id === 'recording-private-id'
      ? { ...entry, store_path: '/synthetic-private.wav', duration: 3.5 } : entry);
    try {
      await audioReference.optimizeComfyPrompt('h3');
      check(audioReference.document.nodes[0].prompt === audioOutput, 'manual H3 optimization keeps the generated audio cue');
      const request = starts.at(-1);
      const parameters = JSON.parse(request.intentPrompt.split('\n')[1]).parameters;
      check(parameters.audioReference === true && parameters.mode === 'reference' && request.references.length === 0
        && !JSON.stringify(request).includes('recording-private-id'), 'Cloud receives the fact of a recording, without a recording locator');
      await audioReference.start('h3', true);
      check(calls.at(-1).input.prompt === audioOutput && calls.at(-1).input.audioAssetId === 'recording-private-id',
        'local H3 retains the actual input recording and all intentional tag uses');
      check(JSON.parse(starts.at(-1).intentPrompt.split('\n')[1]).parameters.audioReference === true, 'automatic optimization receives the same recording hint');
    } finally { api.cloudAgentGet = get; api.getAssetsByIds = getAssets; }
    setAutoOptimize(false);
    const ui = canvasWorkflowController('p'); await ui.load(); await ui.edit([{ ...node, x: 800 }]);
  });
  const card = page.locator('[data-workflow-card="h3"]');
  async function checkH3Header(card) {
    const header = card.locator(':scope > header');
    await header.getByRole('button', { name: '复制卡片', exact: true }).locator('svg').waitFor();
    assert.equal(await header.getByRole('button', { name: /复制.*提示词/ }).count(), 0);
    await header.getByRole('button', { name: '生成历史' }).locator('svg.lucide-history').waitFor();
  }
  await checkH3Header(card);
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
  const videoStatus = card.locator('footer .workflow-h3-status[role="status"]');
  await draft.fill('new');
  await draft.pressSequentially(' latest draft');
  const optimize = card.getByRole('button', { name: '优化提示词', exact: true });
  await optimize.evaluate(button => { button.click(); button.click(); });
  const feedback = await card.locator('.h3-optimize-action').evaluate(button =>
    new Promise(resolve => requestAnimationFrame(() => resolve(button.getAttribute('aria-busy')))));
  await videoStatus.getByText('正在优化提示词', { exact: true }).waitFor();
  await page.evaluate(() => window.releaseDraftWrite());
  await page.waitForFunction(() => window.dispatchTrace.some(row => row.key === 'cloudAgentStart'));
  const prefix = await page.evaluate(() => window.dispatchTrace.slice(0,window.dispatchTrace.findIndex(row => row.key === 'cloudAgentStart') + 1));
  const queuedWrites = prefix.filter(row => row.key === 'canvasWorkflowSave').length;
  console.log('queued edit + optimize: native saves before dispatch',queuedWrites,'busy while first write blocked',feedback);
  assert.equal(prefix.at(-1).prompt,'new latest draft');
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.run.status === 'done');
  assert.equal(await page.evaluate(() => window.dispatchTrace.filter(row => row.key === 'cloudAgentStart').length),1,'same-turn clicks submit one optimization');
  const before = await page.evaluate(() => ({ local: window.h3Calls.length, cloud: window.optimizeStarts.length }));
  await card.getByRole('button', { name: '重新优化提示词', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.run.status === 'done');
  assert.deepEqual(await page.evaluate(() => ({ local: window.h3Calls.length, cloud: window.optimizeStarts.length })), { local: before.local, cloud: before.cloud + 1 });
  assert.equal(await draft.inputValue(), 'new latest draft');
  const preview = card.getByRole('button', { name: '展开编辑优化后提示词' });
  assert.match(await preview.innerText(), /单一连续镜头/);
  await preview.click();
  assert.equal(await card.getByRole('button', { name: '原文 (Raw)' }).getAttribute('aria-pressed'), 'true');
  const prose = card.getByLabel('优化后提示词全文', { exact: true });
  const beforeEdit = await prose.inputValue();
  await prose.fill('微调后的画面');
  await card.getByRole('button', { name: '原文 (Raw)' }).click();
  assert.equal(await card.getByRole('textbox', { name: '优化后提示词全文', exact: true }).inputValue(), '微调后的画面');
  assert.equal(await card.evaluate(el => parseFloat(el.style.width)), 448);
  await card.getByRole('button', { name: '还原', exact: true }).click();
  assert.equal(await card.getByRole('textbox', { name: '优化后提示词全文', exact: true }).inputValue(), beforeEdit);
  await card.getByRole('button', { name: '收起', exact: true }).click();
  await videoStatus.getByText('提示词已优化', { exact: true }).waitFor();
  assert.equal(await card.getByText('提示词已优化', { exact: true }).count(), 1);
  assert.equal(await card.locator('details.comfy-optimization-result').count(), 0);
  const field = await card.locator('.comfy-video-prompt').boundingBox();
  const action = await card.getByRole('button', { name: '重新优化提示词', exact: true }).boundingBox();
  assert.ok(action.y >= field.y + field.height - 1 && action.x + action.width <= field.x + field.width + 1);
  await card.getByRole('button', { name: '运行', exact: true }).waitFor();
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.waitForFunction(theme => {
      const color = getComputedStyle(document.querySelector('[aria-label="卡片指令"]')).color;
      const channel = Number(color.match(/\d+/)?.[0]); return theme === 'light' ? channel < 100 : channel > 150;
    }, theme);
    await page.screenshot({ path: `.tmp/h3-optimization/${theme}.png` });
  }
  assert.match(await preview.innerText(), /单一连续镜头/);
  await card.getByLabel('卡片指令', { exact: true }).fill('用户修改后的提示词');
  await page.evaluate(() => { window.dispatchTrace.length = 0; });
  const runButton = card.getByRole('button', { name: /^(运行|重试)$/ });
  await runButton.evaluate(button => { button.click(); button.click(); });
  const guard = card.locator('.h3-run-guard');
  await guard.waitFor();
  assert.equal(await page.evaluate(() => window.h3Calls.length), before.local);
  await guard.getByRole('button', { name: '用新原文直出' }).click();
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
  assert.equal(await card.getByRole('button', { name: /查看技能执行.*审批/ }).count(), 0);
  const retryButton = card.getByRole('button', { name: '重试', exact: true });
  await retryButton.waitFor();
  await videoStatus.getByText('视频已生成', { exact: true }).waitFor();
  assert.equal(await card.getByText('视频已生成', { exact: true }).count(), 1);
  await draft.fill('用户修改后的提示词，再向右看');
  await runButton.waitFor();
  assert.equal(await draft.evaluate(field => field === document.activeElement), true, 'H3 action updates before the textarea loses focus');
  await draft.fill('用户修改后的提示词');
  await retryButton.waitFor();
  const autoCheckbox = card.getByRole('checkbox', { name: '自动优化提示词', exact: true });
  assert.equal(await autoCheckbox.isChecked(), false);
  const autoBefore = await page.evaluate(() => ({ local: window.h3Calls.length, cloud: window.optimizeStarts.length }));
  await autoCheckbox.check();
  await retryButton.click();
  await page.waitForFunction(({ local, cloud }) => window.h3Calls.length === local + 1 && window.optimizeStarts.length === cloud + 1 &&
    JSON.parse(sessionStorage.getItem('workflow-p')).document.run.status === 'done', autoBefore);
  assert.equal(await page.evaluate(() => window.optimizeStarts.at(-1).textRewrite.source), '用户修改后的提示词');
  assert.match(await page.evaluate(() => window.h3Calls.at(-1).input.prompt), /单一连续镜头/);
  assert.match(await preview.innerText(), /单一连续镜头/);
  assert.equal(await draft.inputValue(), '用户修改后的提示词');
  await retryButton.waitFor();
  await card.getByRole('button', { name: '查看提示词优化历史', exact: true }).click();
  const videoHistory = page.getByRole('dialog', { name: '提示词优化历史', exact: true });
  await videoHistory.getByRole('button', { name: '恢复第 3 次优化结果', exact: true }).waitFor();
  assert.match(await videoHistory.innerText(), /用户修改后的提示词/);
  await videoHistory.getByRole('button', { name: '恢复第 3 次用户原文', exact: true }).click();
  await videoHistory.waitFor({ state: 'hidden' });
  await draft.and(page.locator(':focus')).waitFor();
  assert.equal(await draft.inputValue(), '用户修改后的提示词');
  await autoCheckbox.uncheck();
  await card.getByRole('button', { name: '恢复使用优化后提示词' }).click();
  await draft.fill('沿楼梯向上运镜。');
  await card.getByText('需重新优化提示词', { exact: true }).waitFor();
  const staleCounts = await page.evaluate(() => [window.h3Calls.length, window.optimizeStarts.length]);
  await runButton.click();
  await guard.getByRole('button', { name: '沿用旧优化结果' }).click();
  await page.waitForFunction(n => window.h3Calls.length === n + 1 && JSON.parse(sessionStorage.getItem('workflow-p')).document.run.status === 'done', staleCounts[0]);
  assert.match(await page.evaluate(() => window.h3Calls.at(-1).input.prompt), /单一连续镜头/);
  assert.equal(await page.evaluate(() => window.optimizeStarts.length), staleCounts[1]);
  await runButton.click();
  await guard.getByRole('button', { name: '先优化再运行' }).click();
  await page.waitForFunction(n => window.h3Calls.length === n + 2 && JSON.parse(sessionStorage.getItem('workflow-p')).document.run.status === 'done', staleCounts[0]);
  assert.equal(await page.evaluate(() => window.optimizeStarts.at(-1).textRewrite.source), '沿楼梯向上运镜。');
  assert.equal(await autoCheckbox.isChecked(), false);
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
  const otherImage = page.locator('[data-workflow-card="other-image"]');
  assert.equal(await otherImage.getByRole('button', { name: '优化提示词' }).count(), 0);
  assert.equal(await otherImage.getByRole('checkbox', { name: '自动优化提示词', exact: true }).count(), 0);
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
  await checkH3Header(imageCard);
  const imageParameters = imageCard.getByRole('toolbar', { name: '生成参数' });
  await imageParameters.locator('.model-select-source svg').waitFor();
  await imageParameters.locator('.tactical-menu-trigger > span[aria-hidden="true"]').waitFor();
  const imageDraft = imageCard.getByLabel('卡片指令', { exact: true });
  const imageStatus = imageCard.locator('footer .workflow-h3-status[role="status"]');
  await imageStatus.getByText('提示词已优化', { exact: true }).waitFor();
  assert.equal(await imageCard.getByRole('button', { name: /查看技能执行.*审批/ }).count(), 0);
  await imageCard.getByRole('button', { name: '查看提示词优化历史', exact: true }).click();
  const history = page.getByRole('dialog', { name: '提示词优化历史', exact: true });
  await history.waitFor();
  assert.match(await history.innerText(), /一只玻璃杯/);
  assert.match(await history.innerText(), /透明玻璃杯，杯沿反射窗边的柔光/);
  await page.keyboard.press('Escape');
  const prior = await page.evaluate(() => window.optimizeStarts.length);
  await imageCard.getByRole('button', { name: '查看提示词优化历史', exact: true }).click();
  await history.getByRole('button', { name: '重试优化提示词', exact: true }).click();
  await page.waitForFunction(n => window.optimizeStarts.length === n + 1 &&
    JSON.parse(sessionStorage.getItem('workflow-p')).document.run.status === 'done', prior);
  assert.equal(await page.evaluate(() => window.optimizeStarts.at(-1).textRewrite.source), '一只玻璃杯');
  await imageCard.getByRole('button', { name: '查看提示词优化历史', exact: true }).click();
  await history.waitFor();
  assert.equal(await history.getByRole('heading', { name: '用户原文', exact: true }).count(), 2);
  await history.getByRole('button', { name: '恢复第 1 次用户原文', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(n => n.id === 'image-h3').prompt === '一只玻璃杯');
  await history.waitFor({ state: 'hidden' });
  await imageDraft.and(page.locator(':focus')).waitFor();
  await imageCard.getByRole('button', { name: '查看提示词优化历史', exact: true }).click();
  await history.getByRole('button', { name: '恢复第 2 次优化结果', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(n => n.id === 'image-h3').prompt === '透明玻璃杯，杯沿反射窗边的柔光。');
  await history.waitFor({ state: 'hidden' });
  await imageCard.getByRole('textbox', { name: '优化后提示词全文', exact: true }).and(page.locator(':focus')).waitFor();
  assert.equal(await page.evaluate(() => window.optimizeStarts.length), prior + 1, 'restoring history never submits another optimization');
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    api.cloudAgentGet = async runId => ({ runId, status: 'succeeded', snapshot: { run: {}, events: [
      { type: 'text.result', display_payload: { schemaVersion: 1, text: window.optimizeStarts.at(-1).textRewrite.source } }] } });
  });
  await imageCard.getByRole('button', { name: '重新优化提示词', exact: true }).click();
  await page.waitForFunction(() => {
    const doc = JSON.parse(sessionStorage.getItem('workflow-p')).document;
    return doc.run.status === 'failed' && doc.run.steps['image-h3'].error.includes('相同的提示词')
      && doc.nodes.find(node => node.id === 'image-h3').prompt === '透明玻璃杯，杯沿反射窗边的柔光。';
  });
  const imageCheckbox = imageCard.getByRole('checkbox', { name: '自动优化提示词', exact: true });
  assert.equal(await imageCheckbox.isChecked(), false);
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    api.cloudAgentGet = async runId => ({ runId, status: 'succeeded', snapshot: { run: {}, events: [
      { type: 'text.result', display_payload: { schemaVersion: 1, text: '透明玻璃杯，柔光在杯沿形成窄而清晰的高光。', dshContinuation: true } }] } });
    window.imageDispatches = [];
    window.store.setState({ startGeneration: async (...args) => {
      window.imageDispatches.push({ prompt: args[0], provider: args[3], rawPrompt: args[4] });
      return { accepted: true, jobId: args[12].jobId };
    } });
  });
  const beforeImageAuto = await page.evaluate(() => window.optimizeStarts.length);
  await imageCheckbox.check();
  await imageCard.getByRole('button', { name: '运行此卡片', exact: true }).click();
  await page.waitForFunction(count => {
    const doc = JSON.parse(sessionStorage.getItem('workflow-p')).document;
    return window.optimizeStarts.length === count + 1 && doc.run.status === 'done'
      && JSON.parse(sessionStorage.getItem('canvas-settings')).h3_auto_optimize_prompt === true;
  }, beforeImageAuto);
  assert.deepEqual(await page.evaluate(() => window.imageDispatches), [{
    provider: 'minimax-h3-image', rawPrompt: '一只玻璃杯',
    prompt: '透明玻璃杯，柔光在杯沿形成窄而清晰的高光。',
  }]);
  assert.equal(await imageDraft.innerText(), '一只玻璃杯');
  assert.match(await imageCard.getByRole('button', { name: '展开编辑优化后提示词' }).innerText(), /杯沿形成窄而清晰的高光/);
  await imageStatus.getByText('已提交生成', { exact: true }).waitFor();
  await imageCard.getByRole('button', { name: '重试', exact: true }).waitFor();
  await imageCard.getByRole('button', { name: '查看提示词优化历史', exact: true }).click();
  await history.getByRole('button', { name: '恢复第 4 次优化结果', exact: true }).waitFor();
  assert.match(await history.innerText(), /柔光在杯沿形成窄而清晰的高光/);
  await history.getByRole('button', { name: '恢复第 4 次用户原文', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.id === 'image-h3').prompt
    === '一只玻璃杯');
  await history.waitFor({ state: 'hidden' });
  await imageDraft.and(page.locator(':focus')).waitFor();
  await imageCard.getByRole('button', { name: /^(运行|运行此卡片)$/ }).waitFor();

  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const { DEFAULT_COMFY_VIDEO, comfyVideoOptionsForMode } = await import('/src/lib/comfyVideo.ts');
    const controller = canvasWorkflowController('p');
    await controller.edit([...controller.document.nodes, {
      ...newWorkflowNode('comfy-video', 430, 60, 'codex'), id: 'h3',
      comfyVideo: comfyVideoOptionsForMode(DEFAULT_COMFY_VIDEO, 'text'), prompt: '玻璃杯特写。'
    }]);
  });
  assert.equal(await autoCheckbox.isChecked(), true, 'a new video card inherits the image card’s global choice');
  await autoCheckbox.uncheck();
  assert.equal(await imageCheckbox.isChecked(), false, 'changing the video checkbox also updates the image checkbox');
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('canvas-settings')).h3_auto_optimize_prompt === false);
  const beforeConcurrentVideo = await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const controller = canvasWorkflowController('p');
    const image = controller.document.nodes.find(node => node.id === 'image-h3');
    const [, id, turnKey] = image.sessionNodeIds.at(-1).split(':');
    // The workflow finished handing off this image, but the native generation is still running.
    window.store.setState({ genJobs: { [id]: { id, projectId: 'p', running: true, media: 'image', provider: 'minimax-h3-image',
      turns: [{ id: 1, turnKey, prompt: '玻璃杯', images: [] }], sessionId: null, streaming: '', lastPrompt: '玻璃杯',
      lastRefs: [], refAssets: [], lastRatio: null, createdAt: Date.now() } } });
    return window.h3Calls.length;
  });
  await imageStatus.getByText('正在生成图片', { exact: true }).waitFor();
  const concurrent = page.getByRole('dialog', { name: '是否需要继续运行当前卡片？' });
  await runButton.click();
  await concurrent.waitFor();
  assert.match(await concurrent.innerText(), /电脑卡顿、生成速度降低/);
  await concurrent.getByRole('button', { name: '取消', exact: true }).and(page.locator(':focus')).waitFor();
  await page.keyboard.press('Enter');
  await concurrent.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.h3Calls.length), beforeConcurrentVideo);
  await runButton.click();
  await concurrent.getByRole('button', { name: '确认', exact: true }).click();
  await page.waitForFunction(n => window.h3Calls.length === n + 1 &&
    JSON.parse(sessionStorage.getItem('workflow-p')).document.run.status === 'done', beforeConcurrentVideo);

  await page.evaluate(() => {
    window.store.setState({ genJobs: {} });
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const gate = Promise.withResolvers();
    window.releaseConcurrentVideo = gate.resolve;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'comfy_video' && args.action === 'start') {
        window.concurrentVideoRunning = true;
        await gate.promise;
      }
      return invoke(command, args);
    };
  });
  await retryButton.click();
  await page.waitForFunction(() => window.concurrentVideoRunning);
  try {
    await videoStatus.getByText('正在生成视频', { exact: true }).waitFor();
    await imageCard.getByRole('button', { name: /^(运行|运行此卡片|重试)$/ }).click();
    await concurrent.getByRole('button', { name: '取消', exact: true }).click();
    await concurrent.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.imageDispatches.length), 1);
  } finally { await page.evaluate(() => window.releaseConcurrentVideo()); }
  await page.waitForFunction(n => window.h3Calls.length === n + 2 &&
    JSON.parse(sessionStorage.getItem('workflow-p')).document.run.status === 'done', beforeConcurrentVideo);
  const continuationRun = await page.evaluate(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.runs
    .find(run => run.steps['image-h3']?.comfyOptimization?.dshContinuation).id);
  await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const now = Date.now();
    const chat = { id: 'h3-opt-example', projectId: 'p', threadId: 'h3-chat-thread', nodeId: 'h3-hidden-note',
      title: 'H3 提示词优化', provider: 'dsh-cloud', status: 'idle', turnCount: 1, preview: '柔光高光', revision: 1,
      createdAt: now, updatedAt: now, error: null, messages: [
        { id: 'seed-user', turnId: 'seed', role: 'user', text: '原始提示词', referenceAssetIds: [], status: 'done', createdAt: now, updatedAt: now },
        { id: 'seed-assistant', turnId: 'seed', role: 'assistant', text: '优化后的柔光高光', referenceAssetIds: [], status: 'done', createdAt: now, updatedAt: now },
      ] };
    const quote = { service: 'chat_deepseek', available: true, unit_cost: 0, currency: 'Bcoin', pricing_version: 1, dsh_vps_v2_available: true };
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'cloud_agent_open_h3_chat') { window.h3ContinueArgs = args; return chat; }
      if (command === 'local_chat_get' && args.conversationId === chat.id) return chat;
      if (command === 'local_chat_quote') return quote;
      if (command === 'local_chat_send') {
        window.h3FollowUp = args.input;
        return { ...chat, revision: 2, turnCount: 2 };
      }
      return invoke(command, args);
    };
    const { chatQuote } = await import('/src/lib/chatCapabilities.ts');
    window.store.setState(state => ({ cloudAuth: { ...state.cloudAuth, cloud_available: true },
      cloudEntitlement: { ...state.cloudEntitlement, policy: { ...state.cloudEntitlement.policy, can_use_cloud: true } } }));
    chatQuote.replace('tester', quote);
  });
  await imageCard.getByRole('button', { name: '续聊优化提示词' }).click();
  const chatPanel = page.getByRole('complementary', { name: '对话详情' });
  await chatPanel.getByText('优化后的柔光高光').waitFor();
  assert.equal(await chatPanel.getAttribute('data-local-chat-id'), 'h3-opt-example');
  const continued = await page.evaluate(() => window.h3ContinueArgs);
  assert.equal(continued.projectId, 'p');
  assert.equal(continued.nodeId, 'image-h3');
  assert.equal(continued.workflowRunId, continuationRun);
  await chatPanel.getByLabel('继续对话').fill('把柔光换成侧逆光。');
  await chatPanel.getByRole('button', { name: '发送对话消息' }).click();
  await page.waitForFunction(() => window.h3FollowUp !== undefined);
  const followUp = await page.evaluate(() => window.h3FollowUp);
  assert.equal(followUp.conversationId, 'h3-opt-example');
  assert.equal(followUp.provider, 'dsh-cloud');
  assert.equal(followUp.text, '把柔光换成侧逆光。');
  assert.equal(followUp.dshSkill, undefined);
  await chatPanel.getByRole('button', { name: '应用到优化后提示词' }).click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes
    .find(node => node.id === 'image-h3').h3Prompt.edited === '优化后的柔光高光');
  const sixFields = 'subject_definitions: <Picture 1> 指定人物。\r\n\r\nsummary: 雨声中，她回头。\n\nretention_analysis: 保留衣着。\n' +
    'detailed_description: [Shot 1] 她说 <d>[Chinese] 等一下。</d>\noverall_soundscape: 雨落在伞面。\nnon_diegetic_music: N/A';
  await page.evaluate(async text => {
    const { api } = await import('/src/lib/api.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const { DEFAULT_COMFY_VIDEO, comfyVideoOptionsForMode } = await import('/src/lib/comfyVideo.ts');
    const c = canvasWorkflowController('p');
    await c.edit([{ ...newWorkflowNode('comfy-video', 650, 50, 'codex'), id: 'h3', prompt: '雨中回头，说「等一下」。',
      comfyVideo: comfyVideoOptionsForMode(DEFAULT_COMFY_VIDEO, 'r2v'), inputs: { 'reference-image': [{ assetId: 'a' }] } }]);
    api.cloudAgentGet = async runId => ({ runId, status: 'succeeded', snapshot: { run: {}, events: [
      { type: 'text.result', display_payload: { schemaVersion: 1, text } }] } });
    await c.optimizeComfyPrompt('h3', { referenceImageCount: 1, referenceVideoCount: 0, referenceAudioCount: 0 });
  }, sixFields);
  await preview.click();
  await card.getByRole('button', { name: '结构化', exact: true }).click();
  assert.equal(await card.locator('.h3-struct-field').count(), 7, 'six Ref2VA fields plus a dialogue shortcut');
  assert.equal(await card.getByLabel('主体定义', { exact: true }).inputValue(), '<Picture 1> 指定人物。');
  assert.equal(await card.getByLabel('内容概要', { exact: true }).inputValue(), '雨声中，她回头。');
  await card.getByLabel('对白快捷编辑', { exact: true }).fill('好，$1。');
  await card.getByRole('button', { name: '原文 (Raw)' }).click();
  assert.equal(await card.getByRole('textbox', { name: '优化后提示词全文', exact: true }).inputValue(), sixFields.replaceAll('\r\n', '\n').replace('等一下。','好，$$1。'));
  await card.getByRole('button', { name: '结构化', exact: true }).click();
  await card.getByLabel('对白快捷编辑', { exact: true }).fill('我们走吧。');
  await card.screenshot({ path: '.tmp/h3-optimization/structured.png' });
  await card.getByRole('button', { name: '收起', exact: true }).click();
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  const parameterCenters = await card.locator('.comfy-video-options').evaluate(row => Array.from(row.children, item => {
    const { top, height } = item.getBoundingClientRect(); return Math.round(top + height / 2);
  }));
  assert.equal(parameterCenters.length, 5);
  const videoParameters = card.locator('.comfy-video-options');
  for (const icon of ['.model-select-source svg', '.lucide-film', '.lucide-timer', '.tactical-menu-trigger > span[aria-hidden="true"]', '.lucide-gauge']) {
    await videoParameters.locator(icon).waitFor();
  }
  assert.ok(Math.max(...parameterCenters) - Math.min(...parameterCenters) < 3, `R2V parameter centers: ${parameterCenters}`);
  await card.screenshot({ path: '.tmp/h3-optimization/card-dark.png' });
  await preview.click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(n => n.id === 'h3')?.h3Prompt?.expanded);
  await page.reload();
  await card.getByLabel('对白快捷编辑', { exact: true }).waitFor();
  assert.equal(await card.getByLabel('对白快捷编辑', { exact: true }).inputValue(), '我们走吧。');
  assert.equal(await draft.inputValue(), '雨中回头，说「等一下」。');
  assert.deepEqual(errors, []);
  console.log('H3 explicit and opted-in optimization: manual editing, chained generation, stop, account, failure and original-job recovery passed');
} catch (error) { console.error(error, errors); throw error; }
finally { await browser.close(); await server.close(); }
