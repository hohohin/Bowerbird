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
  await editedClip.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '固定生成卡', exact: true }).click();
  await editCard.getByRole('button', { name: '取消固定并收起' }).waitFor();
  await page.evaluate(() => { window.holdEditRun = new Promise(resolve => { window.resumeEditRun = resolve; }); });
  await editCard.getByRole('button', { name: /^(运行|重试)$/ }).click();
  await page.waitForFunction(() => window.holdingEditRun);
  assert.equal(await editCard.getAttribute('aria-busy'), 'true');
  assert.equal(await editCard.getByRole('button', { name: '取消固定并收起' }).isDisabled(), true);
  await page.evaluate(() => window.resumeEditRun());
  await editCard.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  console.log('PASS new + and saved direct inputs, image/video result wires, whole video delivery, completion signal, fan-out, with/without @, rerun, single-card run and reload');
} finally {
  await browser.close();
  await server.close();
}
