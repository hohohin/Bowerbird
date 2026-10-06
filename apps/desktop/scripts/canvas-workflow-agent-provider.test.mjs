import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 1631, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
try {
  await page.goto('http://127.0.0.1:1631/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  const result = await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { CanvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const { useStore } = await import('/src/store.ts');
    const check = (ok, message) => { if (!ok) throw Error(message); };
    let deliveries = 0, generations = 0, active, pending, ack, failReply = false, failGenerate = false, loseResult = false;
    const requests = new Map(), responses = new Map(), providers = [], jobs = new Map();
    api.agentDsWorkflowGenerationJob = async id => jobs.get(id) ?? null;
    const originalNodes = window.snapshot().nodes.length;
    useStore.setState({ activeJobId: null, startGeneration: async () => { throw Error("Agent must not create an ordinary generation conversation"); } });
    api.agentDsWorkflowStart = async (id, _prompt, _source, _purpose, _images, _scope, provider) => {
      deliveries++; check(provider === useStore.getState().defaultProvider, 'delivery takes starred default, not active or card provider');
      requests.set(id, { id: crypto.randomUUID(), prompt: '一只猫', images: _images, ratio: '1:1' });
      pending = id; return { autoDelivered: true, path: 'isolated' };
    };
    api.agentDsWorkflowGenerationRequest = async id => responses.has(id) ? null : requests.get(id) ?? null;
    api.agentDsWorkflowGenerationResponse = async (id, request, response) => {
      check(active.document.run.steps.agent.localDsGenerations[request.id].response, 'response is persisted before acknowledgement');
      if (failReply) { failReply = false; throw Error('模拟回写中断'); }
      ack = response; responses.set(id, response);
    };
    api.agentDsWorkflowResult = async id => responses.has(id) ? { schemaVersion: 1, requestId: id, text: ack.error || '图片已完成', ...(ack.images ? { images: ['output.png'] } : {}) } : null;
    api.agentDsWorkflowIngestImages = async () => api.getAssetsByIds(['a']);
    api.localAgentFindAssetId = async path => (await api.getAssetsByIds(['a'])).find(asset => asset.store_path === path)?.id;
    api.codexCreateImage = async args => {
      generations++; providers.push(args.provider);
      check(args.internalAgent === true, 'native execution explicitly suppresses ordinary generation projection');
      check(args.provider === active.document.run.steps.agent.localDsImageProvider, 'provider is locked by application');
      check(args.referenceImages.length === 1 && args.referenceImages[0] === requests.get(pending).images[0] && args.ratio === '1:1', 'reference image and ratio reach chosen provider');
      check(active.document.run.steps.agent.localDsGenerations[requests.get(pending).id].jobId === args.jobId, 'job identity persisted before side effect');
      useStore.setState({ defaultProvider: 'codex', activeGenProvider: 'codex' });
      if (failGenerate) throw Error('引擎未登录');
      if (!loseResult) jobs.set(args.jobId, { status: 'done', images: ['/tmp/generated.png'] });
      return 'provider-session';
    };
    const setup = async provider => {
      useStore.setState({ defaultProvider: provider, activeGenProvider: provider === 'codex' ? 'jimeng' : 'codex' });
      active = new CanvasWorkflowController(`provider-${crypto.randomUUID()}`); await active.load();
      await active.edit([{ ...newWorkflowNode('agent', 0, 0, 'ignored-provider'), id: 'agent', prompt: '画一只猫', inputs: { image: [{ assetId: 'a' }] } }]);
    };
    for (const provider of ['jimeng', 'codex', 'bowerbird-cloud-image_hd']) {
      await setup(provider); await active.start('agent', true);
      check(active.document.run.status === 'done', JSON.stringify(active.issue));
      check(providers.at(-1) === provider && active.document.nodes[0].outputs.image.assetIds[0] === 'a', 'default provider returns through original Agent image port');
    }
    // Recover after generation succeeded but delivery failed; no second provider call.
    await setup('jimeng'); failReply = true; await active.start('agent', true);
    check(active.document.run.status === 'waiting', 'acknowledgement failure is recoverable');
    const before = { deliveries, generations }, projectId = active.projectId;
    active = new CanvasWorkflowController(projectId); await active.load(); await active.continue();
    check(active.document.run.status === 'done' && deliveries === before.deliveries && generations === before.generations, 'reload only replays saved response');
    check(active.document.run.steps.agent.localDsImageProvider === 'jimeng', 'changed default cannot alter recovered request');
    // Recover a job whose result was absent when the first call returned.
    await setup('bowerbird-cloud-image_fast'); loseResult = true;
    await active.start('agent', true); check(active.document.run.status === 'waiting', 'unknown completion parks without resubmission');
    const call = Object.values(active.document.run.steps.agent.localDsGenerations)[0], priorGenerations = generations;
    jobs.set(call.jobId, { status: 'done', images: ['/tmp/recovered.png'] });
    const recoveredProject = active.projectId; active = new CanvasWorkflowController(recoveredProject); await active.load(); await active.continue();
    check(active.document.run.status === 'done' && generations === priorGenerations && ack.images[0] === '/tmp/recovered.png', 'job recovery preserves provider and output');
    loseResult = false;
    await setup('jimeng'); failGenerate = true; const prior = generations; await active.start('agent', true);
    check(generations === prior + 1 && ack.error.includes('引擎未登录'), 'provider error returned without fallback');
    failGenerate = false;
    await setup('jimeng');
    let release, entered, cancelled;
    const started = new Promise(resolve => { entered = resolve; });
    const generate = api.codexCreateImage;
    api.codexCreateImage = async () => { entered(); await new Promise(resolve => { release = resolve; }); throw Error('取消'); };
    api.cancelCodexCreate = async id => { cancelled = id; };
    const running = active.start('agent', true); await started;
    const job = Object.values(active.document.run.steps.agent.localDsGenerations)[0].jobId;
    const stopping = active.stop(); release(); await Promise.all([running, stopping]);
    check(active.document.run.status === 'stopped' && cancelled === job && !responses.has(pending), 'stop cancels the exact in-flight generation and never acknowledges late output');
    api.codexCreateImage = generate;
    await setup('codex');
    api.agentDsWorkflowGenerationRequest = async () => null;
    api.agentDsWorkflowResult = async id => ({ schemaVersion: 1, requestId: id, text: '普通回答' });
    const count = generations; await active.start('agent', true);
    check(generations === count, 'text-only Agent never invokes generation');
    check(useStore.getState().activeJobId === null && Object.keys(useStore.getState().genJobs).length === 0, 'internal generation never selects or populates ordinary sessions');
    check(window.snapshot().nodes.length === originalNodes, 'provider output creates no ordinary canvas cards');
    return { deliveries, generations, providers };
  });
  console.log('PASS Agent default provider, real runtime routing, recovery, no fallback and text-only behavior', result);
} finally { await browser.close(); await server.close(); }
