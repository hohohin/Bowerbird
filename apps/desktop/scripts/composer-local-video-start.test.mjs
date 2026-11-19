import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ configFile: false, cacheDir: '.tmp/library-generation/h3-vite', server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/canvas-reference/preview.html`);
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  const result = await page.evaluate(async () => {
    const { startComposerLocalVideo } = await import('/src/lib/composerLocalVideo.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const controller = canvasWorkflowController('p');
    await controller.load();
    window.store.setState({ activeProjectId: null, cloudAuth: { logged_in: true, user_id: 'test' },
      cloudEntitlement: { user_id: 'test', tier: 'pro', offline_state: 'fresh' } });
    const calls = [];
    controller.start = async (...args) => { calls.push(['start', ...args]); };
    const request = { prompt: '镜头推进', firstFrame: 'a', lastFrame: 'b', options: { endpoint: 'http://127.0.0.1:8000', seconds: 8, ratio: '9:16', resolution: .8 } };
    const node = await startComposerLocalVideo(controller, request, { x: 110, y: 240 }, async nodes => {
      await controller.edit(nodes);
      calls.push(['saved', JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.at(-1).id]);
    });
    const routeAfter = window.store.getState().activeProjectId;
    const count = controller.document.nodes.length;
    let failed = '';
    try { await startComposerLocalVideo(controller, request, { x: 0, y: 0 }, async () => { throw new Error('save refused'); }); }
    catch (error) { failed = error.message; }
    window.store.setState({ cloudEntitlement: { user_id: 'test', tier: 'free', offline_state: 'fresh' } });
    let denied = '';
    try { await startComposerLocalVideo(controller, request, { x: 0, y: 0 }); }
    catch (error) { denied = error.message; }
    return { node, calls, routeAfter, count, finalCount: controller.document.nodes.length, failed, denied };
  });
  assert.equal(result.node.kind, 'comfy-video');
  assert.equal(result.node.prompt, '镜头推进');
  assert.deepEqual(result.node.inputs, { 'first-frame': [{ assetId: 'a' }], 'last-frame': [{ assetId: 'b' }] });
  assert.deepEqual([result.node.x, result.node.y], [110, 240]);
  assert.deepEqual(result.calls, [['saved', result.node.id], ['start', result.node.id, true, true]]);
  assert.equal(result.routeAfter, null, 'headless H3 keeps the library route');
  assert.equal(result.failed, 'save refused', 'failed persistence never starts a video');
  assert.match(result.denied, /Pro/);
  assert.equal(result.count, result.finalCount, 'permission rejection does not create a card');
  const modes = await page.evaluate(async () => {
    const { startComposerLocalVideo } = await import('/src/lib/composerLocalVideo.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    window.store.setState({ cloudEntitlement: { user_id: 'test', tier: 'pro', offline_state: 'fresh' } });
    const controller = canvasWorkflowController('p');
    const options = { endpoint: 'http://127.0.0.1:8000', seconds: 5, ratio: '16:9', resolution: .98 };
    const text = await startComposerLocalVideo(controller, { prompt: '海边日落', firstFrame: '', options: { ...options, mode: 'text' } }, { x: 0, y: 0 });
    const reference = await startComposerLocalVideo(controller, { prompt: '<Picture 1> 沿海岸行走', firstFrame: 'a', options: { ...options, mode: 'reference' } }, { x: 0, y: 0 });
    return { text, reference };
  });
  assert.deepEqual(modes.text.inputs, {}, 'text mode persists no empty image binding');
  assert.deepEqual(modes.reference.inputs, { 'first-frame': [{ assetId: 'a' }] });
  assert.equal(modes.text.comfyVideo.mode, 'text');
  assert.equal(modes.reference.comfyVideo.mode, 'reference');
  console.log('PASS: shared H3 card submission persists before execution, preserves home, rejects save and entitlement failures');
} finally { await browser.close(); await server.close(); }
