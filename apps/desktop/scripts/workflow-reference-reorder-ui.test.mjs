import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const entry = 'scripts/fixtures/canvas-reference/preview.html';
const server = await createServer({ cacheDir: '.tmp/workflow-reference-reorder-vite', optimizeDeps: { entries: [entry] },
  server: { host: '127.0.0.1', port: 17978, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + entry);
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const { newWorkflowNode, emptyWorkflow } = await import('/src/lib/canvasWorkflow.ts');
    const canvas = window.snapshot(), base = canvas.nodes.find(node => node.id === 'old');
    const pair = { canvasNodeId: 'table', cellId: 'pair' };
    const solo = { assetId: 'c' };
    const draw = { ...newWorkflowNode('generation', 550, 130, 'codex'), id: 'draw',
      inputs: { image: [pair, solo] }, prompt: '主体 @[pair-ref]，背景 @[solo-ref]',
      promptReferences: [{ id: 'pair-ref', type: 'image', input: pair, label: '图片来源 1' },
        { id: 'solo-ref', type: 'image', input: solo, label: '图片来源 2' }] };
    const table = { ...base, id: 'table', kind: 'note', assetId: null, role: null, x: 40, y: 120, width: 320, height: 200,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', text: '', member_ids: [], cells: [[{
        id: 'pair', content_type: 'image', text: '', image_refs: [{ token: '@图片1', asset_id: 'a' }, { token: '@图片2', asset_id: 'b' }],
      }]] }) };
    canvas.nodes = [table];
    canvas.view = { ...canvas.view, zoom: 0.85, panX: 60, panY: 40 };
    sessionStorage.setItem('reference-fixture', JSON.stringify(canvas));
    sessionStorage.setItem('workflow-p', JSON.stringify({ revision: 1, document: { ...emptyWorkflow(), nodes: [draw] } }));
  });
  await page.reload();

  const card = page.locator('[data-workflow-card="draw"]');
  const item = id => card.locator(`[data-workflow-reference-asset="${id}"]`);
  const expectOrder = expected => page.waitForFunction(expected =>
    Array.from(document.querySelectorAll('[data-workflow-card="draw"] [data-workflow-reference-asset]'),
      el => el.getAttribute('data-workflow-reference-asset')).join() === expected.join(), expected, { timeout: 5000 });
  async function dragFirstToLast() {
    const a = await item('a').boundingBox(), c = await item('c').boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(c.x + c.width * .8, c.y + c.height / 2, { steps: 12 });
    await page.mouse.up();
  }
  async function generate() {
    return page.evaluate(async () => {
      const { api } = await import('/src/lib/api.ts');
      const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
      const controller = canvasWorkflowController('p');
      const assets = await api.getAssetsByIds(['existing', 'a', 'b', 'c', 'd']);
      const requests = [];
      window.store.setState({ codexHealth: { ok: true, reason: '' },
        cloudEntitlement: { policy: { can_use_byo: true, max_parallel_jobs: 3 }, balances: { daily: 0, topup: 0, sub: 0 } } });
      api.codexCreateImage = async args => {
        requests.push({ ids: args.referenceImages.map(path => assets.find(a => a.store_path === path)?.id), prompt: args.prompt });
        return null;
      };
      await controller.start('draw', true);
      if (controller.document.run.status !== 'done') throw Error(JSON.stringify(controller.issue));
      return requests;
    });
  }
  await expectOrder(['a', 'b', 'c']);
  const before = await card.boundingBox();
  await dragFirstToLast();
  await expectOrder(['b', 'c', 'a']);
  const after = await card.boundingBox();
  assert.deepEqual([after.x, after.y], [before.x, before.y], 'dragging a thumbnail leaves the card in place');
  await item('a').focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expectOrder(['a', 'b', 'c']);
  await dragFirstToLast();
  await expectOrder(['b', 'c', 'a']);
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    await canvasWorkflowController('p').flush();
  });
  await page.reload();
  await expectOrder(['b', 'c', 'a']);
  assert.deepEqual(await generate(), [{ ids: ['b', 'c', 'a'], prompt: '主体 @图片3 @图片1，背景 @图片2' }]);
  // A shared template carries positions across different sources and asset identities.
  const rebound = await page.evaluate(async () => {
    const { compileGenerationPrompt, generationInputNode, workflowInputValues } = await import('/src/lib/canvasWorkflow.ts');
    const { captureWorkflowTemplate, instantiateWorkflowTemplate } = await import('/src/lib/workflowTemplates.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const template = captureWorkflowTemplate(canvasWorkflowController('p').document.nodes, new Set(['draw']), '参考顺序');
    const instance = instantiateWorkflowTemplate(template, {
      source1: { groupId: 'replacement-group', assetIds: ['new-a', 'new-b'] },
      source2: { assetId: 'new-c' },
    }, {}, 'codex', [], 0, 0);
    const draw = instance.find(node => node.kind === 'generation');
    const values = workflowInputValues(instance, generationInputNode(draw, instance));
    return compileGenerationPrompt(draw, values, instance);
  });
  assert.deepEqual(rebound, { assetIds: ['new-b', 'new-c', 'new-a'], prompt: '主体 @图片3 @图片1，背景 @图片2' });
  // The cell now contains new images. Their positions still belong to the live source.
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const table = window.snapshot().nodes.find(node => node.id === 'table');
    const note = JSON.parse(table.payloadJson);
    note.cells[0][0].image_refs = [{ token: '@图片1', asset_id: 'd' }, { token: '@图片2', asset_id: 'existing' }];
    await api.projectCanvasNoteUpdate(table.id, JSON.stringify(note));
    window.emitChange();
  });
  await expectOrder(['existing', 'c', 'd']);
  assert.deepEqual(await generate(), [{ ids: ['existing', 'c', 'd'], prompt: '主体 @图片3 @图片1，背景 @图片2' }]);

  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const { DEFAULT_VIDEO_OPTIONS } = await import('/src/lib/videoGeneration.ts');
    const clip = { ...newWorkflowNode('generation', 550, 130, 'jimeng'), id: 'draw', prompt: '首尾过渡',
      generation: { media: 'video', videoChannel: 'jimeng', ratio: '16:9', videoOptions: { ...DEFAULT_VIDEO_OPTIONS, kind: 'frames2video' } },
      inputs: { image: ['a', 'b'].map(id => ({ assetId: id, autoConnect: 'wire-' + id })) } };
    await canvasWorkflowController('p').edit([clip]);
  });
  await expectOrder(['a', 'b']);
  await item('b').press('ArrowLeft');
  await expectOrder(['b', 'a']);
  const simulatedVideo = page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { api } = await import('/src/lib/api.ts');
    api.localAgentFindAssetId = async () => 'existing';
    const getAssets = api.getAssetsByIds;
    // The preview fixture uses data URLs. Video validation reads real file extensions.
    api.getAssetsByIds = async ids => (await getAssets(ids)).map(asset => ({ ...asset, store_path: '/fixture/' + asset.id + '.png' }));
    let request;
    window.store.setState({ dreaminaHealth: { ok: true }, startGeneration: async (...args) => {
      request = { ids: args[1].map(asset => asset.id), mode: args[11].videoOptions.kind };
      await new Promise(resolve => { window.finishTestClip = resolve; });
      const { jobId, turnKey } = args[12];
      window.store.setState({ genJobs: { [jobId]: { turns: [{ turnKey, images: ['test.mp4'] }] } } });
      return { accepted: true };
    } });
    const controller = canvasWorkflowController('p');
    await controller.start('draw', true);
    if (controller.document.run.status !== 'done') throw Error(JSON.stringify(controller.issue));
    return request;
  });
  const checkLock = async () => {
    await page.waitForFunction(() => typeof window.finishTestClip === 'function', undefined, { timeout: 5000 });
    try {
      assert.equal(await item('b').isDisabled(), true, 'running card keeps its submitted order');
    } finally {
      await page.evaluate(() => window.finishTestClip());
    }
  };
  const [videoRequest] = await Promise.all([simulatedVideo, checkLock()]);
  assert.deepEqual(videoRequest, { mode: 'frames2video', ids: ['b', 'a'] });
  assert.deepEqual(errors, []);
  console.log('PASS thumbnail drag, undo, reload, template rebinding, dynamic inputs, prompt numbering, keyboard reorder, frame order and running lock');
} finally {
  await browser.close();
  await server.close();
}
