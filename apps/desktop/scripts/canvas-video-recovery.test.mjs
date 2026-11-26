import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ configFile: false, resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
  optimizeDeps: { entries: ['scripts/fixtures/canvas-reference/preview.html'] },
  cacheDir: '.tmp/video-recovery/vite', server: { host: '127.0.0.1', port: 1698, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:1698/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const { DEFAULT_VIDEO_OPTIONS } = await import('/src/lib/videoGeneration.ts');
    const node = { ...newWorkflowNode('generation', 820, 60, 'codex'), id: 'video', prompt: '镜头推进',
      generation: { media: 'video', videoChannel: 'cloud', videoOptions: DEFAULT_VIDEO_OPTIONS },
      inputs: { image: [{ assetId: 'deleted-input' }] } };
    const run = { id: 'run', startId: 'video', threadId: 't', order: ['video'], status: 'running',
      lockedNodeIds: ['video'], steps: { video: { status: 'running', jobId: 'original-job', turnKey: 'original-turn' } } };
    window.seedVideoRecovery = { schema_version: 1, nodes: [node], run };
    sessionStorage.setItem('workflow-p', JSON.stringify({ revision: 1, document: window.seedVideoRecovery }));
    sessionStorage.setItem('recovery-seed', JSON.stringify(window.seedVideoRecovery));
  });
  // Real remount simulates closing/updating while generation was running.
  await page.reload();
  const card = page.locator('[data-workflow-card="video"]');
  await card.waitFor();
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    window.recoveryCalls = []; window.recoveryResult = { status: 'running', images: [] };
    api.agentDsWorkflowGenerationJob = async (jobId, turnKey) => {
      window.recoveryCalls.push({ jobId, turnKey });
      if (window.queryError) throw Error('模拟连接中断');
      return window.recoveryResult;
    };
    api.localAgentFindAssetId = async path => path === '/result.mp4' ? 'result-video' : null;
    api.recentGenSessions = async () => { throw Error('Recovery must not search recent sessions'); };
    window.cancelled = [];
    api.cancelCodexCreate = async id => { window.cancelled.push(id); };
    window.store.setState({ startGeneration: async () => { throw Error('Recovery must never submit generation'); } });
  });
  await card.getByRole('button', { name: '继续工作流', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.run.status === 'waiting' && window.recoveryCalls.length > 0);
  assert.match(await card.innerText(), /原视频仍在生成或恢复中/);
  assert.equal(await card.getByRole('button', { name: '删除卡片', exact: true }).isDisabled(), true, 'active original video must be stopped before deletion');
  await page.evaluate(() => window.recoveryResult = { status: 'done', images: ['/result.mp4'] });
  await card.getByRole('button', { name: '继续工作流', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.run.status === 'done');
  assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes[0].outputs.image.assetIds), ['result-video']);
  assert.deepEqual(await page.evaluate(() => window.recoveryCalls), Array(2).fill({ jobId: 'original-job', turnKey: 'original-turn' }));

  const checks = await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { CanvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { removeWorkflowNodes } = await import('/src/lib/workflowRemoval.ts');
    const check = (condition, message) => { if (!condition) throw Error(message); };
    const seed = JSON.parse(sessionStorage.getItem('recovery-seed'));
    const tail = { nodeId: 'video', portId: 'image', videoFrame: { position: 'last' } };
    const still = { assetId: 'another-reference' };
    const parked = { ...seed.nodes[0], id: 'parked', inputs: { image: [tail, still] },
      savedComfyR2V: { 'reference-image': [tail, still] } };
    const [survivor] = removeWorkflowNodes([...seed.nodes, parked], ['video']);
    for (const inputs of [survivor.inputs.image, survivor.savedComfyR2V['reference-image']]) {
      check(inputs.length === 1 && inputs[0].assetId === still.assetId, 'removing a video clears both active and parked frame references');
    }
    let count = 0;
    for (const [result, message] of [
      [null, '未找到原视频任务'],
      [{ status: 'cancelled', images: [] }, '已停止'],
      [{ status: 'cancelled_local', images: [] }, '已停止'],
      [{ status: 'failed', error: '原视频编码失败', images: [] }, '原视频编码失败'],
      [{ status: 'done', images: [] }, '本地结果已缺失'],
      [{ status: 'done', images: ['/removed.mp4'] }, '本地结果已缺失'],
    ]) {
      const id = `recovery-${crypto.randomUUID()}`;
      await api.canvasWorkflowSave(id, 0, structuredClone(seed));
      const controller = new CanvasWorkflowController(id); await controller.load();
      window.recoveryResult = result;
      await controller.continue();
      check(controller.document.run.status === 'failed', 'terminal failure releases the run');
      check(controller.document.run.steps.video.error.includes(message), message);
      check(!controller.isLocked('video'), 'terminal failure unlocks the card');
      await controller.edit(removeWorkflowNodes(controller.document.nodes, ['video']));
      check(controller.document.nodes.length === 0, 'terminal card can be deleted'); count++;
    }
    const id = `offline-${crypto.randomUUID()}`;
    await api.canvasWorkflowSave(id, 0, structuredClone(seed));
    const controller = new CanvasWorkflowController(id); await controller.load();
    window.queryError = true; await controller.continue();
    check(controller.document.run.status === 'waiting', 'transport failure preserves original job');
    check(controller.document.run.steps.video.jobId === 'original-job', 'identity retained');
    window.queryError = false; window.recoveryResult = { status: 'done', images: ['/result.mp4'] };
    await controller.continue();
    check(controller.document.run.status === 'done', 'transport retry retrieves original result');
    return count;
  });
  assert.equal(checks, 6);
  // Restore a stale waiting card and delete using its actual header button.
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const controller = canvasWorkflowController('p');
    const seed = JSON.parse(sessionStorage.getItem('recovery-seed'));
    seed.run.status = 'waiting'; seed.run.steps.video.status = 'waiting';
    await controller.save(seed);
    window.recoveryResult = { status: 'running', images: [] };
  });
  await card.getByRole('button', { name: '删除卡片', exact: true }).click();
  await card.waitFor({ state: 'detached' });
  assert.deepEqual(await page.evaluate(() => window.cancelled), ['original-job']);
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.length === 0);
  await page.reload();
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  assert.equal(await card.count(), 0, 'deleted waiting card stays deleted after reopening');

  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const controller = canvasWorkflowController('p');
    await controller.load();
    window.seedanceSubmissions = [];
    api.localAgentFindAssetId = async path => path === '/synthetic-seedance.mp4' ? 'result-video' : null;
    const getAssetsByIds = api.getAssetsByIds;
    api.getAssetsByIds = async ids => (await getAssetsByIds(ids)).map(asset => asset.id === 'a' || asset.id === 'b'
      ? { ...asset, store_path: `/synthetic-${asset.id}.png` } : asset);
    window.store.setState({ dreaminaHealth: { ok: true },
      cloudAuth: { logged_in: true, cloud_available: true, user_id: 'video-test' },
      cloudEntitlement: { user_id: 'video-test', tier: 'pro', offline_state: 'fresh', policy: { can_use_byo: true }, balances: { daily: 0, sub: 0, topup: 0 }, generation_services: [] },
      startGeneration: async (prompt, ...args) => {
        const generation = args[10], { jobId, turnKey } = args[11];
        const { document } = JSON.parse(sessionStorage.getItem('workflow-p'));
        const step = document.run.steps.video;
        const video = document.nodes.find(node => node.id === 'video');
        window.seedanceSubmissions.push({ prompt, x: video.x, kind: generation.videoOptions.kind, jobId,
          checkpoint: step.status === 'running' && step.jobId === jobId && step.turnKey === turnKey
            && video.activeSessionNodeId === `gen-prompt:${jobId}:${turnKey}:0` });
        if (window.seedanceSubmissions.length === 1) return { accepted: false, error: '模拟即梦上传失败' };
        window.store.setState(state => ({ genJobs: { ...state.genJobs, [jobId]: { turns: [{ turnKey, images: ['/synthetic-seedance.mp4'] }] } } }));
        return { accepted: true, jobId };
      },
    });
    await controller.edit([{ ...newWorkflowNode('generation', 410, 110, 'jimeng'), id: 'video', prompt: '镜头推进',
      generation: { media: 'video', videoChannel: 'jimeng', videoOptions: { kind: 'multimodal2video', model_version: 'seedance2.5', duration: 4, video_resolution: '480p' } },
      inputs: { image: [{ assetId: 'a', autoConnect: 'still-a' }, { assetId: 'b', autoConnect: 'still-b' }] } }]);
  });
  const runVideo = card.getByRole('button', { name: /^(运行|重试)$/ });
  await runVideo.click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.run?.status === 'failed');
  assert.match(await page.evaluate(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.run.steps.video.error), /模拟即梦上传失败/);
  const firstRunId = await page.evaluate(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.run.id);
  await card.getByLabel('卡片指令', { exact: true }).fill('失败后修改的镜头');
  const header = await card.locator('header strong').boundingBox();
  await page.mouse.move(header.x + 10, header.y + 8);
  await page.mouse.down();
  await page.mouse.move(header.x + 95, header.y + 55, { steps: 8 });
  await page.mouse.up();
  await runVideo.click();
  await page.waitForFunction(previous => {
    const run = JSON.parse(sessionStorage.getItem('workflow-p')).document.run;
    return run && run.id !== previous && ['done', 'failed', 'waiting'].includes(run.status);
  }, firstRunId, { timeout: 8000 });
  const { run, submissions: [firstAttempt, retry] } = await page.evaluate(() => ({
    run: JSON.parse(sessionStorage.getItem('workflow-p')).document.run, submissions: window.seedanceSubmissions,
  }));
  assert.equal(run.status, 'done', run.steps.video.error);
  assert.equal(firstAttempt.kind, 'multimodal2video');
  assert.equal(retry.kind, 'multimodal2video');
  assert.ok(firstAttempt.checkpoint && retry.checkpoint, 'both attempts save session and step together before provider submission');
  assert.notEqual(firstAttempt.jobId, retry.jobId);
  assert.notEqual(firstAttempt.x, retry.x);
  assert.match(retry.prompt, /失败后修改的镜头/);
  assert.deepEqual(errors, []);
  console.log('Video restart recovery and immediate Seedance retry after a failed upload, prompt edit and drag passed');
} finally { await browser.close(); await server.close(); }
