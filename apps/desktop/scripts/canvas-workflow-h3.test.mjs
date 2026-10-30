import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ configFile: false, cacheDir: '.tmp/workflow-h3/vite', server: { host: '127.0.0.1', port: 1697, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const saved = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes[0]);
async function mock() {
  await page.evaluate(async () => {
    window.store.setState({ cloudAuth: { logged_in: true, cloud_available: true, user_id: 'tester' }, cloudEntitlement: { user_id: 'tester', tier: 'pro', offline_state: 'fresh', balances: { daily: 100, sub: 0, topup: 0 }, policy: { can_use_byo: true }, generation_services: [] } });
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.h3Calls = []; window.h3Mode = 'done';
    window.h3Video = { id: 'h3-result', store_path: '/synthetic-h3.mp4', name: 'H3', width: 672, height: 1216, duration: 8, ext: 'mp4' };
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'comfy_video_environment') return { phase: 'ready', endpoint: args.endpoint, message: '已就绪', installed: true };
      if (command === 'comfy_video') {
        window.h3Calls.push(args);
        if (args.action === 'cancel') return { status: 'cancelled', message: '已取消' };
        return window.h3Mode === 'done' ? { status: 'done', message: '完成', asset: window.h3Video } : { status: 'unknown', message: '等待查询原任务' };
      }
      return invoke(command, args);
    };
    const { api } = await import('/src/lib/api.ts');
    api.getAssetsByIds = async ids => ids.map(id => id === 'h3-result' ? window.h3Video : { id, store_path: `/synthetic-${id}.${id === 'video' ? 'mp4' : 'png'}`, width: 500, height: 500, thumb_path: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500"><rect width="500" height="500" fill="${id === 'b' ? '#4f46e5' : '#0d9488'}"/></svg>`)}` });
    window.store.setState({ startGeneration: async () => { throw Error('H3 must not use remote generation'); } });
  });
}
try {
  await page.goto('http://127.0.0.1:1697/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await mock();
  await page.evaluate(async () => {
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { DEFAULT_VIDEO_OPTIONS } = await import('/src/lib/videoGeneration.ts');
    const controller = canvasWorkflowController('p'); await controller.load();
    await controller.edit([{ ...newWorkflowNode('generation', 400, 60, 'codex'), id: 'video-provider', prompt: '镜头推进', inputs: { image: [{ assetId: 'a' }, { assetId: 'b' }] }, generation: { media: 'video', videoChannel: 'cloud', videoOptions: { ...DEFAULT_VIDEO_OPTIONS } } }]);
  });
  const card = page.locator('[data-workflow-card="video-provider"]');
  await card.getByTitle('选择视频模型', { exact: true }).click();
  const menu = page.getByRole('dialog', { name: '视频模型', exact: true });
  const local = menu.locator('[data-model-key="local:h3"]');
  assert.match(await local.innerText(), /本地部署\s*H3\s*0/);
  await page.evaluate(() => window.store.setState({ cloudEntitlement: { ...window.store.getState().cloudEntitlement, tier: 'free' } }));
  await page.waitForFunction(() => document.querySelector('[data-model-key="local:h3"]')?.disabled);
  await page.evaluate(() => window.store.setState({ cloudEntitlement: { ...window.store.getState().cloudEntitlement, tier: 'pro' } }));
  await local.click();
  await card.getByLabel('H3 时长').fill('6');
  await card.getByLabel('H3 分辨率', { exact: true }).click();
  await page.getByRole('option', { name: '0.6', exact: true }).click();
  await card.getByLabel('H3 比例', { exact: true }).click();
  await page.getByRole('option', { name: '1:1', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes[0].comfyVideo?.ratio === '1:1');
  const selected = await saved();
  assert.equal(selected.kind, 'comfy-video');
  assert.equal(selected.comfyVideo.seconds, 6);
  assert.equal(selected.comfyVideo.resolution, 0.6);
  assert.equal(selected.inputs['first-frame'][0].assetId, 'a');
  assert.equal(selected.inputs['last-frame'][0].assetId, 'b');
  assert.equal(selected.prompt, '镜头推进', 'H3 does not require image mentions');
  assert.equal(await card.locator('.comfy-frame-slot').count(), 2);
  assert.equal(await card.getByRole('button', { name: '输入：首帧', exact: true }).count(), 1);
  assert.equal(await card.getByRole('button', { name: '输入：尾帧（可选）', exact: true }).count(), 1);
  assert.equal(await card.evaluate(el => parseFloat(el.style.width)), 416);
  // Actual slot drop must replace the first frame, not create a generic image reference.
  await page.evaluate(async () => (await import('/src/lib/dragPayload.ts')).setDragAssets(['c']));
  await card.getByLabel('首帧输入', { exact: true }).dispatchEvent('drop');
  await page.evaluate(async () => (await import('/src/lib/dragPayload.ts')).setDragAssets(null));
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes[0].inputs['first-frame'][0].assetId === 'c');
  await page.reload(); await card.waitFor(); await mock();
  assert.equal(await card.getByLabel('H3 时长').inputValue(), '6');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-workflow-card="video-provider"] .comfy-frame-slot img')].filter(img => img.complete && img.naturalWidth > 0).length === 2);
  await mkdir('.tmp/workflow-h3', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.screenshot({ path: `.tmp/workflow-h3/card-${theme}.png` });
  }
  await card.getByRole('button', { name: '运行此卡片', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.run?.status === 'done');
  const submission = await page.evaluate(() => window.h3Calls[0].input);
  assert.equal(submission.firstFrame, 'c'); assert.equal(submission.lastFrame, 'b');
  assert.equal(submission.prompt, '镜头推进');
  const result = await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { CanvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode, workflowReferenceToken } = await import('/src/lib/canvasWorkflow.ts');
    const { DEFAULT_COMFY_VIDEO } = await import('/src/lib/comfyVideo.ts');
    const check = (ok, message) => { if (!ok) throw Error(message); };
    async function setup(ids) {
      const controller = new CanvasWorkflowController(`h3-${crypto.randomUUID()}`); await controller.load();
      const refs = ids.map((assetId, i) => ({ id: `ref${i}`, type: 'image', label: `图片${i + 1}`, input: { assetId } }));
      await controller.edit([{ ...newWorkflowNode('generation', 0, 0, 'codex'), id: 'gen',
        prompt: `镜头推进 ${refs.map(ref => workflowReferenceToken(ref.id)).join(' ')}`, promptReferences: refs,
        inputs: { image: ids.map(assetId => ({ assetId })) }, generation: { media: 'video', localVideo: { ...DEFAULT_COMFY_VIDEO } } }]);
      return controller;
    }
    window.h3Calls = [];
    let controller = await setup(['tail', 'first']);
    await controller.start('gen', true);
    check(controller.document.run.status === 'done', JSON.stringify(controller.document.run));
    check(window.h3Calls[0].input.firstFrame === 'tail' && window.h3Calls[0].input.lastFrame === 'first', 'reference order determines first and last frame');
    check(window.h3Calls[0].input.prompt === '镜头推进 @图片1 @图片2', 'compiled prompt retains references');
    check(controller.document.nodes[0].outputs.image.assetIds[0] === 'h3-result' && controller.document.nodes[0].resultNodeIds.length === 1, 'video result delivered');
    for (const ids of [[], ['a', 'b', 'c'], ['video']]) {
      const count = window.h3Calls.length;
      controller = await setup(ids); await controller.start('gen', true);
      check(controller.document.run.status === 'failed' && window.h3Calls.length === count, 'invalid frames cannot submit H3');
    }
    window.h3Mode = 'unknown'; controller = await setup(['first']);
    await controller.start('gen', true);
    const jobId = controller.document.run.steps.gen.jobId;
    const starts = window.h3Calls.filter(call => call.action === 'start').length;
    check(controller.document.run.status === 'waiting', 'unknown stays recoverable');
    const oldSnapshot = await api.canvasWorkflowGet(controller.projectId);
    oldSnapshot.document.nodes = oldSnapshot.document.nodes.map(node => ({ ...node, kind: 'generation',
      generation: { media: 'video', localVideo: node.comfyVideo }, comfyVideo: undefined,
      inputs: { image: node.inputs['first-frame'] }, promptReferences: undefined }));
    await api.canvasWorkflowSave(controller.projectId, oldSnapshot.revision, oldSnapshot.document);
    const restored = new CanvasWorkflowController(controller.projectId); await restored.load();
    check(restored.document.nodes[0].kind === 'comfy-video', 'old running card migrates without changing job identity');
    window.h3Mode = 'done'; await restored.continue();
    check(restored.document.run.status === 'done', 'saved H3 generation recovers');
    check(window.h3Calls.at(-1).action === 'status' && window.h3Calls.at(-1).requestId === jobId, 'recovery queries original job');
    check(window.h3Calls.filter(call => call.action === 'start').length === starts, 'recovery never submits twice');
    window.h3Mode = 'unknown'; controller = await setup(['first']); await controller.start('gen', true); await controller.stop();
    check(window.h3Calls.at(-1).action === 'cancel' && controller.document.run.steps.gen.comfyCancelled, 'stop cancels local job');
    window.h3Mode = 'done';
    controller = await setup([]);
    await controller.edit([{ ...newWorkflowNode('comfy-video', 0, 0, 'codex'), id: 'gen', prompt: '镜头推进', inputs: { 'first-frame': [{ assetId: 'first' }] } }]);
    await controller.start('gen', true);
    check(controller.document.run.status === 'done', 'dedicated H3 cards still execute');
    const { DEFAULT_VIDEO_OPTIONS } = await import('/src/lib/videoGeneration.ts');
    // Load the previous implementation's persisted draft, bypassing edit normalization.
    const legacyId = `legacy-h3-${crypto.randomUUID()}`;
    const legacyNode = { ...newWorkflowNode('generation', 42, 61, 'codex'), id: 'legacy', prompt: '不需要引用标记',
      inputs: { image: [{ assetId: 'first' }, { assetId: 'tail' }] },
      generation: { media: 'video', localVideo: { ...DEFAULT_COMFY_VIDEO, seconds: 7 } } };
    await api.canvasWorkflowSave(legacyId, 0, { schema_version: 1, nodes: [legacyNode], run: null });
    const migrated = new CanvasWorkflowController(legacyId); await migrated.load();
    check(migrated.document.nodes[0].kind === 'comfy-video' && migrated.document.nodes[0].x === 42, 'legacy draft becomes H3 in place');
    await migrated.start('legacy', true);
    check(migrated.document.run.status === 'done', 'legacy draft runs without mentions');
    check(window.h3Calls.at(-1).input.firstFrame === 'first' && window.h3Calls.at(-1).input.lastFrame === 'tail' && window.h3Calls.at(-1).input.seconds === 7, 'legacy frames and options retained');
    // A connected upstream output remains a live binding, not a frozen image snapshot.
    controller = await setup([]);
    const producer = { ...newWorkflowNode('generation', -400, 0, 'codex'), id: 'producer', outputs: { image: { type: 'image', assetIds: ['updated-frame'] } } };
    await controller.edit([producer, { ...controller.document.nodes[0], prompt: '连接首帧', inputs: { 'first-frame': [{ nodeId: 'producer', portId: 'image' }] } }]);
    await controller.start('gen', true);
    check(controller.document.run.status === 'done' && window.h3Calls.at(-1).input.firstFrame === 'updated-frame', 'H3 resolves connected upstream image without mentions');
    api.localAgentFindAssetId = async () => 'h3-result';
    const remoteCalls = [], localCount = window.h3Calls.length;
    window.store.setState({ startGeneration: async (...args) => {
      remoteCalls.push(args); const identity = args[12];
      window.store.setState({ genJobs: { [identity.jobId]: { turns: [{ turnKey: identity.turnKey, images: ['/synthetic-h3.mp4'] }] } } });
      return { accepted: true, jobId: identity.jobId };
    } });
    for (const videoChannel of ['cloud', 'jimeng']) {
      controller = await setup([]);
      await controller.edit(controller.document.nodes.map(node => ({ ...node, kind: 'generation', inputs: {}, generation: { media: 'video', videoChannel, videoOptions: { ...DEFAULT_VIDEO_OPTIONS, kind: 'text2video' } } })));
      await controller.start('gen', true);
      check(controller.document.run.status === 'done', 'remote video generation still completes');
    }
    check(remoteCalls.length === 2 && window.h3Calls.length === localCount, 'remote providers never use H3');
    return { calls: window.h3Calls.length, recoveredJob: jobId };
  });
  assert.deepEqual(errors, []);
  console.log('Workflow H3 provider: menu, parameters, persistence, entitlement, execution, validation, recovery and cancellation passed', result);
} finally { await browser.close(); await server.close(); }
