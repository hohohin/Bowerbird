import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const entry = 'scripts/fixtures/canvas-reference/preview.html';
const server = await createServer({ cacheDir: '.tmp/workflow-reconnect-vite', optimizeDeps: { entries: [entry] },
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`${server.resolvedUrls.local[0]}${entry}`);
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  const result = await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const { canvasAutomaticOutputs } = await import('/src/lib/workflowCanvasCapabilities.ts');
    const controller = canvasWorkflowController('p');
    await controller.load();
    const canvas = window.snapshot();
    const instance = canvas.nodes.find(node => node.id === 'old');
    const session = { ...instance, id: 'source-session', kind: 'prompt', assetId: null, role: null,
      payloadJson: JSON.stringify({ job_id: 'source-job', turn_key: 'source-turn', status: 'done' }) };
    const output = { ...instance, id: 'result-image', assetId: 'a', role: 'output',
      payloadJson: JSON.stringify({ execution: { job_id: 'source-job', turn_key: 'source-turn' } }) };
    canvas.nodes.push(session, output);
    api.projectCanvasGet = async () => structuredClone(canvas);
    const requests = [];
    api.codexCreateImage = async request => { requests.push(request); };
    window.store.setState({ codexHealth: { ok: true, reason: '' },
      cloudEntitlement: { policy: { can_use_byo: true }, balances: { daily: 100, sub: 0, topup: 0 } } });
    const wire = { assetId: instance.assetId, assetNodeId: instance.id, autoConnect: 'existing-wire', mediaFilter: ['image'], slot: 1 };
    const receiver = { ...newWorkflowNode('generation', 100, 80, 'codex'), id: 'receiver',
      prompt: '把 @[first] 与 @[second] 合成', inputs: { image: [wire] },
      promptReferences: ['first', 'second'].map((id, i) => ({ id, type: 'image', label: `图片来源 ${i + 1}`,
        slot: i + 1, input: { ...wire, slot: i + 1 } })) };
    await controller.edit([receiver]);
    await controller.start(receiver.id, true);
    const before = { count: requests.length, issue: controller.issue?.code, label: controller.issue?.referenceLabel };
    await controller.connectAutomatic(canvasAutomaticOutputs(session.id, controller.document.nodes, canvas.nodes, [], []), { nodeId: receiver.id });
    await controller.start(receiver.id, true);
    const assets = await api.getAssetsByIds([instance.assetId, output.assetId]);
    return { before, count: requests.length, refs: requests[0]?.referenceImages, prompt: requests[0]?.prompt,
      expected: [instance.assetId, output.assetId].map(id => assets.find(asset => asset.id === id).store_path),
      inputs: controller.document.nodes.find(n => n.id === receiver.id).inputs.image,
      issue: controller.issue?.message };
  });
  assert.deepEqual(result.before, { count: 0, issue: 'INPUT_UNAVAILABLE', label: '图片来源 2' });
  assert.equal(result.count, 1, result.issue);
  assert.deepEqual(result.refs, result.expected);
  assert.equal(new Set(result.refs).size, 2);
  assert.match(result.prompt, /把 @图片1 与 @图片2 合成/);
  assert.deepEqual(result.inputs.map(binding => binding.slot), [1, 2]);
  assert.equal(result.inputs[1].canvasNodeId, 'source-session');
  console.log('PASS a missing second reference blocks submission, reconnecting the generated output preserves both references and submits once');
} finally {
  await browser.close();
  await server.close();
}
