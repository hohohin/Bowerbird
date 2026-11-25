import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({
  cacheDir: '.tmp/generation-result-routing-vite',
  optimizeDeps: { entries: ['scripts/fixtures/canvas-auto-connect/preview.html'] },
  server: { host: '127.0.0.1', port: 17966, strictPort: false, hmr: false, watch: null },
});
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1900, height: 1100 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const sinks = ['with-ref', 'no-ref', 'plus'];

async function connectWithPlus(sourceId, targetName) {
  const add = page.locator(`[data-workflow-card="${sourceId}"]`).getByRole('button', { name: '添加下游', exact: true });
  await add.focus();
  await add.press('Enter');
  await page.getByRole('menu', { name: '添加下游', exact: true }).getByRole('menuitem', { name: '连接已有卡片', exact: true }).click();
  await page.getByRole('menu', { name: '连接已有卡片', exact: true }).getByRole('menuitem', { name: targetName, exact: true }).click();
}

async function checkWire(sourceId, targetId) {
  const path = page.locator(`path[data-workflow-target="${targetId}"]`);
  // A horizontal SVG path has zero bounding-box height but still draws a valid wire.
  await path.waitFor({ state: 'attached' });
  const source = page.locator(`[data-workflow-card="${sourceId}"],[data-canvas-node-id="${sourceId}"]`);
  await source.waitFor();
  const { d, length, start, end } = await path.evaluate(el => {
    const matrix = el.getScreenCTM();
    const length = el.getTotalLength();
    if (!matrix) throw new Error('Workflow wire has no screen transform');
    const start = el.getPointAtLength(0).matrixTransform(matrix);
    const end = el.getPointAtLength(length).matrixTransform(matrix);
    return { d: el.getAttribute('d'), length, start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y } };
  });
  assert.match(d, /^M\s/);
  assert.ok(Number.isFinite(length) && length > 0 && [start.x, start.y, end.x, end.y].every(Number.isFinite),
    `${targetId} has a non-empty wire with finite screen endpoints`);
  const box = await source.boundingBox();
  assert.ok(Math.abs(start.x - box.x - box.width) <= 2,
    `${targetId} starts at ${start.x.toFixed(1)} instead of ${sourceId}'s right edge ${(box.x + box.width).toFixed(1)}`);
}

try {
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/canvas-auto-connect/preview.html`);
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const input = { nodeId: 'draw', portId: 'image' };
    const producer = { ...newWorkflowNode('generation', 40, 80, 'codex'), id: 'draw', prompt: 'draw' };
    const receivers = ['with-ref', 'no-ref'].map((id, index) => ({
      ...newWorkflowNode('generation', 1050, 40 + index * 430, 'codex'), id, inputs: { image: [input] },
      prompt: index ? id : id + ' @[pic]',
      promptReferences: index ? [] : [{ id: 'pic', type: 'image', input, label: '图片来源 1' }],
    }));
    const unconnected = { ...newWorkflowNode('generation', 510, 600, 'codex'), id: 'plus', prompt: 'plus' };
    const controller = canvasWorkflowController('p');
    await controller.save({ ...controller.document, nodes: [producer, ...receivers, unconnected], cardNames: { ...controller.document.cardNames, plus: '下游加号' } });
  });
  // Use the visible add/connect menu on a fresh card, alongside two saved precise bindings.
  await connectWithPlus('draw', '下游加号');
  await page.locator('path[data-workflow-target="plus"]').waitFor({ state: 'attached' });
  const connected = await page.evaluate(() => ({
    ids: JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.map(n => n.id),
    newContent: window.snapshot().nodes.filter(n => n.kind === 'note' && n.id !== 'far').length,
  }));
  assert.equal(connected.newContent, 0, 'connecting does not insert a blank content card');
  assert.deepEqual(connected.ids, ['draw', 'with-ref', 'no-ref', 'plus']);
  for (const sink of sinks) await checkWire('draw', sink);

  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { publishGeneration } = await import('/scripts/fixtures/canvas-reference/generation.ts');
    const controller = canvasWorkflowController('p');
    let round = 0;
    let inputs;
    api.localAgentFindAssetId = async path => path.replace('.png', '');
    window.store.setState({
      codexHealth: { ok: true }, cloudEntitlement: { balances: { daily: 0, sub: 0, topup: 0 }, policy: { can_use_byo: true, max_parallel_jobs: 10 } },
      startGeneration: async (...args) => {
        const prompt = args[0], producing = prompt === 'draw';
        if (!producing) inputs[prompt.split(' ')[0]] = args[1].map(asset => asset.id);
        const { jobId, turnKey } = args[12];
        const paths = producing ? [round === 1 ? 'a.png' : 'b.png'] : ['c.png'];
        await publishGeneration(args, paths);
        const session = `gen-prompt:${jobId}:${turnKey}:0`;
        await api.projectCanvasNodeUpdate(session, { x: producing ? 510 + 45 * round : 1500, y: 100 + 55 * round, width: 240, height: 190 });
        const [asset] = await api.getAssetsByIds([await api.localAgentFindAssetId(paths[0])]);
        await api.projectCanvasNodeUpdate(`gen-output:${jobId}:${turnKey}:0`, { payloadJson: JSON.stringify({
          schema_version: 1, snapshot: { name: asset.name, width: asset.width, height: asset.height },
          execution: { job_id: jobId, turn_key: turnKey },
        }) });
        return { accepted: true };
      },
    });
    window.runChain = async (single = false) => {
      inputs = {};
      round++;
      await controller.start('draw', single);
      if (single) for (const id of ['with-ref', 'no-ref', 'plus']) await controller.start(id, true);
      if (controller.document.run.status !== 'done') throw Error(JSON.stringify(controller.issue));
      const session = controller.document.nodes.find(node => node.id === 'draw').activeSessionNodeId;
      window.save();
      window.emitChange();
      return { session, inputs };
    };
  });

  const drawCard = page.locator('[data-workflow-card="draw"]');
  let latest;
  for (const [asset, single] of [['a', false], ['b', true]]) {
    const { session, inputs } = await page.evaluate(single => window.runChain(single), single);
    assert.notEqual(session, latest, 'each production run has a fresh identity');
    latest = session;
    const result = page.locator(`[data-canvas-node-id="${session}"]`);
    await result.locator(`[data-conversation-image="${asset}"]`).waitFor();
    await drawCard.waitFor({ state: 'detached' });
    for (const sink of sinks) {
      await checkWire(session, sink);
      assert.deepEqual(inputs[sink], [asset], `${sink} receives the result of this run`);
    }
    const sessionWire = page.locator(`path[data-workflow-session-link="${session}"]`);
    assert.equal(await sessionWire.count(), 0, 'collapsed producer does not draw an internal wire to its own result');
    await result.hover();
    await drawCard.getByRole('button', { name: '固定在画板上', exact: true }).click();
    await sessionWire.waitFor({ state: 'attached' });
    assert.match(await sessionWire.getAttribute('d'), /^M\s/);
    await drawCard.getByRole('button', { name: '取消固定并收起', exact: true }).click();
    await drawCard.waitFor({ state: 'detached' });
  }
  await page.reload();
  for (const sink of sinks) await checkWire(latest, sink);

  // The video generator exposes its asset card while its prompt is hidden.
  await page.evaluate(async () => {
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { DEFAULT_VIDEO_OPTIONS } = await import('/src/lib/videoGeneration.ts');
    const video = (id, x) => ({ ...newWorkflowNode('generation', x, 100, 'jimeng'), id, prompt: id,
      generation: { media: 'video', videoChannel: 'jimeng', ratio: '16:9', videoOptions: DEFAULT_VIDEO_OPTIONS } });
    const controller = canvasWorkflowController('p');
    const trigger = { ...newWorkflowNode('trigger', 1000, 580, ''), id: 'completion', triggerMode: 'completion', triggerCount: 0,
      inputs: { completion: [{ nodeId: 'clip', portId: 'image' }] } };
    await controller.save({ ...controller.document, nodes: [video('clip', 40), video('edit-clip', 1000), trigger],
      run: null, runs: [], cardNames: { 'edit-clip': '视频下游' } });
    const graph = window.snapshot();
    graph.nodes = graph.nodes.filter(n => n.id === 'old');
    sessionStorage.setItem('reference-fixture', JSON.stringify(graph));
    sessionStorage.setItem('reference-drafts', JSON.stringify(['clip', 'edit-clip'].map(id => ({
      id: id + '-asset', name: id, duration: 5, width: 320, height: 180, ext: 'mp4', store_path: '/fixture/' + id + '.mp4',
    }))));
  });
  await page.reload();
  await connectWithPlus('clip', '视频下游');
  await page.getByRole('menu', { name: '引用视频', exact: true }).getByRole('menuitem', { name: '引用完整视频', exact: true }).click();
  await checkWire('clip', 'edit-clip');
  const clipCard = page.locator('[data-workflow-card="clip"]');
  const editCard = page.locator('[data-workflow-card="edit-clip"]');
  assert.equal(await clipCard.locator('.workflow-preview').count(), 0);
  assert.equal(await editCard.locator('.workflow-preview').count(), 0);
  const video = await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { publishGeneration } = await import('/scripts/fixtures/canvas-reference/generation.ts');
    const c = canvasWorkflowController('p');
    const calls = [];
    const results = {};
    api.localAgentFindAssetId = async path => path.split('/').pop().replace('.mp4', '-asset');
    window.store.setState({ dreaminaHealth: { ok: true },
      cloudEntitlement: { policy: { can_use_byo: true, max_parallel_jobs: 10 }, balances: { daily: 0, sub: 0, topup: 0 } },
      startGeneration: async (...args) => {
        const { jobId, turnKey } = args[12];
        const id = args[0], path = '/fixture/' + id + '.mp4';
        if (id === 'edit-clip' && window.holdEditRun) {
          window.holdingEditRun = true;
          await window.holdEditRun;
        }
        calls.push({ inputs: args[1].map(asset => asset.store_path), kind: args[11].videoOptions.kind });
        await publishGeneration(args, [path]);
        const resultId = `gen-output:${jobId}:${turnKey}:0`;
        results[id] = resultId;
        await api.projectCanvasNodeUpdate(resultId, { x: id === 'clip' ? 560 : 1000, y: 100, width: 240, height: 135, positionLocked: true,
          payloadJson: JSON.stringify({ schema_version: 1, execution: { job_id: jobId, turn_key: turnKey }, snapshot: { name: id, width: 320, height: 180 } }) });
        window.store.setState({ genJobs: { [jobId]: { turns: [{ turnKey, images: [path] }] } } });
        return { accepted: true };
      },
    });
    await c.start('clip');
    if (c.document.run.status !== 'done') throw Error(JSON.stringify(c.issue));
    window.save();
    window.emitChange();
    return { calls, clipResultId: results.clip, editResultId: results['edit-clip'] };
  });
  assert.deepEqual(video.calls, [
    { inputs: [], kind: 'text2video' },
    { inputs: ['/fixture/clip.mp4'], kind: 'multimodal2video' },
  ], 'the downstream request includes the original video file');
  await page.locator(`path[data-workflow-generated-link="${video.clipResultId}"]`).waitFor({ state: 'attached' });
  await checkWire(video.clipResultId, 'edit-clip');
  await checkWire('clip', 'completion');
  const editedClip = page.locator(`[data-canvas-node-id="${video.editResultId}"]`);
  await editedClip.waitFor();
  await editCard.waitFor({ state: 'detached' });
  assert.equal(await page.locator(`path[data-workflow-generated-link="${video.editResultId}"]`).count(), 0, 'a collapsed video does not draw a wire to itself');
  const incoming = page.locator('path[data-workflow-target="edit-clip"]');
  const end = await incoming.evaluate(el => el.getPointAtLength(el.getTotalLength()).matrixTransform(el.getScreenCTM()).x);
  assert.ok(Math.abs(end - (await editedClip.boundingBox()).x) <= 2, 'the incoming link ends at the collapsed video');
  assert.equal(await editedClip.locator('.canvas-generation-actions,.canvas-video-badge').count(), 0, 'the video preview carries no generation corner actions');
  await editedClip.hover();
  await editCard.locator('[data-workflow-reference-asset="clip-asset"]').waitFor();
  assert.equal(await clipCard.locator('.workflow-preview').count(), 0, 'the completion trigger keeps its producer on the canvas');
  assert.equal(await editCard.locator('.workflow-preview > *').count(), 1, 'only the upstream clip is shown inside the downstream generator');
  await editedClip.click();
  const preview = page.getByRole('dialog', { name: '视频与生成记录预览', exact: true });
  await preview.waitFor();
  assert.equal(await preview.getByRole('button', { name: /在画布.*生成卡/ }).count(), 0);
  await page.keyboard.press('Escape');
  await preview.waitFor({ state: 'detached' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('.canvas-zoom-controls').getByRole('button', { name: '缩小', exact: true }).click();
  await editCard.waitFor({ state: 'detached' });
  await editedClip.hover();
  await editCard.waitFor();
  const zoom = await editedClip.evaluate(el => new DOMMatrix(getComputedStyle(el.closest('.canvas-plane')).transform).a);
  assert.ok(zoom >= 0.35 && zoom < 1, 'exercise Peek against a zoomed video material');
  const clipBeforeDrag = await editedClip.boundingBox();
  const checkPeekGap = async () => {
    const card = await editCard.boundingBox(), anchor = await editedClip.boundingBox();
    assert.ok(Math.abs(anchor.x - card.x - card.width - 12 * zoom) < 1);
    assert.ok(Math.abs(anchor.y - card.y) < 1);
  };
  await checkPeekGap();
  await editedClip.evaluate(el => {
    // The shared drag renderer falls back to data geometry when a loop frame is present.
    const frame = document.createElement('div');
    frame.className = 'workflow-loop-frame';
    frame.hidden = true;
    frame.dataset.testLoopFrame = '';
    el.closest('.canvas-plane').append(frame);
  });
  const grip = { x: clipBeforeDrag.x + 55, y: clipBeforeDrag.y + 40 };
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x + 64, grip.y + 50, { steps: 5 });
  await page.waitForFunction(({ id, previous }) => {
    const material = document.querySelector(`[data-canvas-node-id="${id}"]`);
    return material && Math.abs(material.getBoundingClientRect().x - previous) > 30 && !material.style.translate;
  }, { id: video.editResultId, previous: clipBeforeDrag.x });
  await checkPeekGap();
  await page.mouse.up();
  await checkPeekGap();
  await page.locator('[data-test-loop-frame]').evaluate(frame => frame.remove());
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`);
  await page.waitForFunction(({ id, previous }) => {
    const material = document.querySelector(`[data-canvas-node-id="${id}"]`);
    return material && Math.abs(material.getBoundingClientRect().x - previous) < 1;
  }, { id: video.editResultId, previous: clipBeforeDrag.x });
  await checkPeekGap();

  const resizeVideo = editedClip.getByRole('button', { name: '调整素材大小', exact: true });
  await editedClip.hover();
  assert.equal(await resizeVideo.evaluate(el => getComputedStyle(el).opacity), '1');
  const handle = await resizeVideo.boundingBox();
  const gripX = handle.x + handle.width / 2, gripY = handle.y + handle.height / 2;
  await page.mouse.move(gripX, gripY);
  await page.mouse.down();
  await page.mouse.move(gripX + 51, gripY + 24, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(({ id, width }) => window.snapshot().nodes.find(node => node.id === id)?.width > width,
    { id: video.editResultId, width: clipBeforeDrag.width / zoom + 50 });
  const resizedVideo = await page.evaluate(id => window.snapshot().nodes.find(node => node.id === id), video.editResultId);
  assert.ok(Math.abs((resizedVideo.height - 32) / (resizedVideo.width - 2) - 9 / 16) < 0.001);
  const clipAfterResize = await editedClip.boundingBox();
  assert.ok(Math.abs(clipAfterResize.width - clipBeforeDrag.width - 51) < 1);
  assert.equal(clipAfterResize.x, clipBeforeDrag.x);
  assert.equal(clipAfterResize.y, clipBeforeDrag.y);
  assert.equal(await preview.count(), 0);
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`);
  await page.waitForFunction(({ id, width }) => Math.abs(window.snapshot().nodes.find(node => node.id === id)?.width - width) < 1,
    { id: video.editResultId, width: clipBeforeDrag.width / zoom });
  await editedClip.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '固定生成卡', exact: true }).click();
  await editCard.getByRole('button', { name: '取消固定并收起' }).waitFor();
  await page.evaluate(() => { window.holdEditRun = new Promise(resolve => { window.resumeEditRun = resolve; }); });
  await editCard.getByRole('button', { name: /^(运行|重试)$/ }).click();
  await page.waitForFunction(() => window.holdingEditRun);
  assert.equal(await editCard.getAttribute('aria-busy'), 'true');
  assert.equal(await editCard.getByRole('button', { name: '取消固定并收起' }).isDisabled(), true);
  await page.evaluate(() => window.resumeEditRun());
  await page.waitForFunction(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { workflowNodeRun } = await import('/src/lib/canvasWorkflow.ts');
    return workflowNodeRun(canvasWorkflowController('p').document, 'edit-clip')?.status === 'done';
  });
  assert.equal(await editCard.count(), 1, 'the pinned card remains until the board receives its result');
  await page.evaluate(() => { window.save(); window.emitChange(); });
  await editCard.waitFor({ state: 'detached' });
  const audio = await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { newWorkflowNode, workflowBindingKey } = await import('/src/lib/canvasWorkflow.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { DEFAULT_VIDEO_OPTIONS } = await import('/src/lib/videoGeneration.ts');
    const { publishGeneration } = await import('/scripts/fixtures/canvas-reference/generation.ts');
    const c = canvasWorkflowController('p');
    const card = (id, x) => ({ ...newWorkflowNode('generation', x, 100, 'jimeng'), id, prompt: id,
      generation: { media: 'video', videoChannel: 'jimeng', ratio: '16:9', videoOptions: DEFAULT_VIDEO_OPTIONS } });
    const producer = card('audio-source', 40);
    const receiver = card('audio-receiver', 690);
    await c.save({ ...c.document, nodes: [producer, receiver], run: null, runs: [] });
    await c.connectAutomatic([{ binding: { nodeId: producer.id, portId: 'image', videoAudio: {} }, type: 'image', media: 'audio' }],
      { nodeId: receiver.id });
    const storedBinding = () => c.document.nodes.find(node => node.id === receiver.id).inputs.image[0];
    const before = structuredClone(storedBinding());
    const assets = new Map();
    const getAssets = api.getAssetsByIds;
    api.getAssetsByIds = async ids => [...await getAssets(ids.filter(id => !assets.has(id))), ...ids.flatMap(id => assets.get(id) ?? [])];
    api.localAgentFindAssetId = async path => path.split('/').pop();
    const addAsset = (path, ext) => {
      const id = path.split('/').pop();
      const asset = { id, name: id, ext, duration: 5, width: 320, height: 180, store_path: path };
      assets.set(id, asset);
      return asset;
    };
    const extracted = [], delivered = [];
    let turn = 0, noAudio = false;
    api.extractVideoAudio = async (path, _operationId, projectId) => {
      extracted.push([path, projectId]);
      if (noAudio) throw '视频没有可提取的音轨，请选择带声音的视频';
      return addAsset(path.replace('.mp4', '.wav'), 'wav');
    };
    window.store.setState({
      startGeneration: async (...args) => {
        const { jobId, turnKey } = args[12];
        const path = args[0] === producer.id ? `/fixture/current-video-${++turn}.mp4` : `/fixture/derived-video-${turn}.mp4`;
        if (args[0] === receiver.id) delivered.push(args[1].map(asset => asset.store_path));
        addAsset(path, 'mp4');
        await publishGeneration(args, [path]);
        window.store.setState({ genJobs: { [jobId]: { turns: [{ turnKey, images: [path] }] } } });
        return { accepted: true };
      },
    });
    for (let i = 0; i < 2; i++) {
      await c.start(producer.id);
      if (c.document.run.status !== 'done') throw Error(JSON.stringify(c.issue));
    }
    noAudio = true;
    await c.start(receiver.id, true);
    const issue = c.issue;
    const after = storedBinding();

    const voiceCard = { ...newWorkflowNode('voice', 690, 100, ''), id: 'audio-preview', voice: { sampleText: '试听视频声音' } };
    const calls = [];
    window.store.setState(state => ({
      cloudAuth: { ...state.cloudAuth, logged_in: true, user_id: 'test' },
      cloudEntitlement: { ...state.cloudEntitlement, user_id: 'test', tier: 'pro', offline_state: 'fresh' },
    }));
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'voice_environment') return { phase: 'ready' };
      if (command === 'voice_start') {
        const id = "spoken-" + (calls.length + 1);
        calls.push({ id, args, asset: addAsset("/fixture/" + id + ".wav", 'wav') });
        return id;
      }
      if (command === 'voice_snapshot') return { config: {}, voices: [], jobs: calls.map(({ id, args, asset }) => ({
        id, request_key: args.requestKey, status: 'succeeded', asset_id: asset.id, purpose: args.preview ? 'preview' : 'speech',
      })), assets: calls.map(({ asset }) => asset) };
      return invoke(command, args);
    };
    noAudio = false;
    await c.save({ ...c.document, nodes: [producer, voiceCard], run: null, runs: [] });
    await c.connectAutomatic([{ binding: { nodeId: producer.id, portId: 'image', videoAudio: {} }, type: 'image', media: 'audio' }],
      { nodeId: voiceCard.id });
    const waitForVoice = async (ready, message) => {
      for (let i = 0; i < 100; i++) {
        const card = document.querySelector('[data-workflow-card="audio-preview"]');
        if (card && ready(card)) return;
        await new Promise(resolve => setTimeout(resolve, 35));
      }
      throw new Error(message);
    };
    const voiceWaveform = '[data-audio-preview][data-asset-id="spoken-1.wav"]';
    await waitForVoice(card => card.textContent.includes('等待上游素材'), 'voice card marks the pending video audio source');
    await c.start(producer.id);
    if (c.document.run.status !== 'done') throw Error(JSON.stringify(c.issue));
    const preview = c.document.run.steps[voiceCard.id].voiceRequest;
    const previewOutputs = c.document.nodes.find(node => node.id === voiceCard.id).outputs;
    await waitForVoice(card => card.querySelector(voiceWaveform), 'voice card shows the generated audition waveform');
    await c.start(producer.id, true);
    if (c.document.run.status !== 'done') throw Error(JSON.stringify(c.issue));
    await waitForVoice(card => card.textContent.includes('等待上游素材') && !card.querySelector(voiceWaveform), 'replacement video hides the old audition');

    const fixed = { ...voiceCard, voice: { id: 'selected-voice' }, prompt: '正式台词' };
    await c.save({ ...c.document, nodes: [fixed], run: null, runs: [] });
    await c.start(fixed.id, true);
    if (c.document.run.status !== 'done') throw Error(JSON.stringify(c.issue));
    return { before, after, extracted, delivered, preview, previewOutputs, voiceCalls: calls.map(({ args }) => args),
      issue: { code: issue?.code, message: issue?.message, sameSource: issue?.source && workflowBindingKey(issue.source) === workflowBindingKey(before) } };
  });
  assert.deepEqual(audio.before.videoAudio, {});
  assert.deepEqual(audio.after, audio.before, 'the two runs and failure keep the dynamic reference');
  assert.deepEqual(audio.extracted, [['/fixture/current-video-1.mp4', 'p'], ['/fixture/current-video-2.mp4', 'p'], ['/fixture/current-video-2.mp4', 'p'], ['/fixture/current-video-3.mp4', 'p']]);
  assert.deepEqual(audio.delivered, [['/fixture/current-video-1.wav'], ['/fixture/current-video-2.wav']]);
  assert.equal(audio.issue.code, 'INPUT_UNAVAILABLE');
  assert.match(audio.issue.message, /视频没有可提取的音轨/);
  assert.equal(audio.issue.sameSource, true);
  assert.equal(audio.voiceCalls.length, 2);
  assert.equal(audio.voiceCalls[0].preview.assetId, 'current-video-3.wav');
  assert.equal(audio.voiceCalls[0].voiceId, null);
  assert.equal(audio.voiceCalls[0].text, '试听视频声音');
  assert.equal(audio.preview.assetId, 'spoken-1.wav');
  assert.deepEqual(audio.preview.videoAudio, { sourceAssetId: 'current-video-3.mp4', assetId: 'current-video-3.wav' });
  assert.deepEqual(audio.previewOutputs, {}, 'preview stays in the voice card');
  assert.equal(audio.voiceCalls[1].preview, null);
  assert.equal(audio.voiceCalls[1].voiceId, 'selected-voice');
  assert.equal(audio.voiceCalls[1].text, '正式台词');
  assert.deepEqual(errors, []);
  console.log('PASS new + and saved direct inputs, image/video result wires, video material Peek drag/resize/undo at zoom, whole video and derived audio delivery, completion signal, fan-out, with/without @, rerun, single-card run and reload');
} finally {
  await browser.close();
  await server.close();
}
