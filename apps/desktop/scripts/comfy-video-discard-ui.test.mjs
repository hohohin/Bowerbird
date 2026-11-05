import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ configFile: false, cacheDir: '.tmp/h3-discard/vite', server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.setDefaultTimeout(10000);
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/canvas-reference/preview.html`);
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    window.store.setState({ cloudAuth: { logged_in: true, user_id: 'test' }, cloudEntitlement: { user_id: 'test', tier: 'pro', offline_state: 'fresh', balances: { daily: 0, sub: 0, topup: 0 } } });
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.videoCalls = [];
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'comfy_video_environment') return { phase: 'ready', message: 'ready', endpoint: args.endpoint };
      if (command === 'comfy_video') {
        window.videoCalls.push(args.action);
        if (args.action !== 'start') throw Error('ComfyUI is offline');
        return new Promise(resolve => { window.interruptVideo = () => resolve({ status: 'unknown', message: '生成已中断' }); });
      }
      return invoke(command, args);
    };
    const c = canvasWorkflowController('p'); await c.load();
    const node = { ...newWorkflowNode('comfy-video', 400, 60, 'codex'), id: 'h3', prompt: '海边日落', comfyVideo: { mode: 'text', seconds: 5, ratio: '9:16', resolution: .98, endpoint: 'http://127.0.0.1:8000' } };
    await c.edit([node]); await c.start(node.id, true, true);
  });
  const card = page.locator('[data-workflow-card="h3"]');
  await page.waitForFunction(() => !!window.interruptVideo);
  assert.equal(await card.getByRole('button', { name: '删除卡片', exact: true }).isDisabled(), true, 'active submission remains protected');
  const interruptedSnapshot = await page.evaluate(() => sessionStorage.getItem('workflow-p'));
  await page.evaluate(() => window.interruptVideo());
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.run?.status === 'waiting');
  assert.equal(await card.getByRole('button', { name: '删除卡片', exact: true }).isEnabled(), true);
  // Reload the actual in-flight snapshot, as after an abrupt dev-process restart.
  await page.evaluate(snapshot => sessionStorage.setItem('workflow-p', snapshot), interruptedSnapshot);
  await page.reload();
  await card.waitFor();
  await page.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.videoCalls = [];
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'comfy_video') { window.videoCalls.push(args.action); throw Error('ComfyUI is offline'); }
      return invoke(command, args);
    };
  });
  assert.equal(await card.getByRole('button', { name: '删除卡片', exact: true }).isEnabled(), true, 'offline local video must be deletable without cancellation');
  await card.getByRole('button', { name: '删除卡片', exact: true }).click();
  await card.waitFor({ state: 'detached' });
  const saved = await page.evaluate(() => ({ data: JSON.parse(sessionStorage.getItem('workflow-p')).document, calls: window.videoCalls }));
  assert.ok(!saved.data.nodes.some(node => node.id === 'h3'));
  assert.deepEqual(saved.calls, [], 'deletion neither recovers nor cancels through the unavailable server');
  await page.reload();
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  assert.equal(await page.locator('[data-workflow-card="h3"]').count(), 0, 'deleted card stays deleted after reload');
  console.log('PASS interrupted local video deletion without ComfyUI, persistent removal and existing canvas retained');
} finally { await browser.close(); await server.close(); }
