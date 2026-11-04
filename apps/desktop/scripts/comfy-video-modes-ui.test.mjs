import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

await mkdir('.tmp/h3-modes', { recursive: true });
const server = await createServer({ configFile: false, cacheDir: '.tmp/h3-modes/vite', server: { host: '127.0.0.1', port: 1698, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(8000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
async function mock() {
  await page.evaluate(async () => {
    window.store.setState({ cloudAuth: { logged_in: true, user_id: 'tester' }, cloudEntitlement: { user_id: 'tester', tier: 'pro', offline_state: 'fresh', balances: { daily: 0, sub: 0, topup: 0 }, policy: { can_use_byo: true }, generation_services: [] } });
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.h3Calls = []; window.envCalls = []; window.h3Status = 'done';
    window.h3Asset = { id: 'h3-result', store_path: '/synthetic-h3.mp4', ext: 'mp4', width: 768, height: 1344, duration: 124 / 24 };
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'comfy_video_environment') {
        window.envCalls.push(args);
        if (args.action === 'install') window.needModels = null;
        return window.needModels === args.mode
          ? { mode: args.mode, phase: 'unavailable', endpoint: args.endpoint, message: '缺少此模式的模型', canInstall: true, canAddModels: true, installed: false, downloadBytes: 21e9, requiredBytes: 24e9 }
          : { mode: args.mode, phase: 'ready', endpoint: args.endpoint, message: '已就绪' };
      }
      if (command === 'comfy_video') { window.h3Calls.push(args); return { status: args.action === 'cancel' ? 'cancelled' : window.h3Status, message: '模拟', asset: window.h3Asset }; }
      return invoke(command, args);
    };
    const { api } = await import('/src/lib/api.ts');
    api.getAssetsByIds = async ids => ids.map(id => id === 'h3-result' ? window.h3Asset : { id, store_path: '/synthetic.png', width: 256, height: 256 });
    window.store.setState({ startGeneration: async () => { throw Error('Must use local H3'); } });
  });
}
try {
  await page.goto('http://127.0.0.1:1698/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor(); await mock();
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const c = canvasWorkflowController('p'); await c.load();
    await c.edit([{ ...newWorkflowNode('comfy-video', 400, 60, 'codex'), id: 'h3', prompt: '主体 <Picture 1> 在雨中行走', inputs: { 'first-frame': [{ assetId: 'a' }], 'last-frame': [{ assetId: 'b' }] } }]);
  });
  const card = page.locator('[data-workflow-card="h3"]');
  await card.getByLabel('H3 模式', { exact: true }).click();
  await page.getByRole('option', { name: '单图', exact: true }).click();
  assert.equal(await card.locator('.comfy-frame-slot').count(), 1);
  assert.equal(await card.getByLabel('参考图输入', { exact: true }).count(), 1);
  assert.equal(await card.getByLabel('H3 时长').inputValue(), '5');
  assert.match(await card.getByLabel('H3 分辨率', { exact: true }).innerText(), /768p/);
  assert.equal(await card.getByRole('button', { name: '添加上游', exact: true }).count(), 1);
  await card.getByRole('button', { name: '运行此卡片', exact: true }).click();
  await page.waitForFunction(() => window.h3Calls.some(call => call.action === 'start'));
  let input = await page.evaluate(() => window.h3Calls.find(call => call.action === 'start').input);
  assert.equal(input.mode, 'reference'); assert.equal(input.firstFrame, 'a'); assert.equal(input.lastFrame, undefined);
  assert.equal(input.resolution, .98); assert.equal(input.seconds, 5); assert.match(input.prompt, /<Picture 1>/);
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.run.status === 'done');
  await card.getByLabel('H3 模式', { exact: true }).click();
  await page.getByRole('option', { name: '文生视频', exact: true }).click();
  assert.equal(await card.locator('.comfy-frame-slot').count(), 0);
  await card.getByLabel('H3 比例', { exact: true }).click();
  assert.equal(await page.getByRole('option', { name: '自动', exact: true }).count(), 0);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.envCalls.some(call => call.action === 'detect' && call.mode === 'text'));
  await page.reload(); await card.waitFor(); await mock();
  assert.match(await card.getByLabel('H3 模式', { exact: true }).innerText(), /文生视频/);
  await card.getByRole('button', { name: '运行此卡片', exact: true }).click();
  await page.waitForFunction(() => window.h3Calls.some(call => call.action === 'start'));
  input = await page.evaluate(() => window.h3Calls.find(call => call.action === 'start').input);
  assert.equal(input.mode, 'text'); assert.equal(input.firstFrame, ''); assert.equal(input.lastFrame, undefined);
  const checks = await page.evaluate(async () => {
    const { CanvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode, workflowExecutionNodes, workflowInputs } = await import('/src/lib/canvasWorkflow.ts');
    const { DEFAULT_COMFY_VIDEO, comfyEnvironmentReady, comfyVideoOptionsForMode } = await import('/src/lib/comfyVideo.ts');
    const { planAutomaticConnection } = await import('/src/lib/workflowAutoConnect.ts');
    const check = (value, message) => { if (!value) throw Error(message); };
    const base = { ...newWorkflowNode('comfy-video', 0, 0, 'codex'), id: 'gen', prompt: '测试', comfyVideo: comfyVideoOptionsForMode(DEFAULT_COMFY_VIDEO, 'text'), inputs: { 'first-frame': [{ nodeId: 'missing', portId: 'image' }], 'last-frame': [{ assetId: 'stale' }] } };
    check(Object.keys(workflowExecutionNodes([base], 'gen')[0].inputs).length === 0, 'text must not resolve hidden inputs');
    check(workflowInputs(base).map(p => p.id).join() === 'text', 'text mode has text only');
    check(planAutomaticConnection([base], [{ binding: { assetId: 'a' }, type: 'image', media: 'image' }], 'gen').error, 'text mode rejects automatic image connections');
    check(comfyEnvironmentReady({ phase: 'stopped', modelsRequired: 4, existing: [{ canStart: true, modelsFound: 4 }] }), 'R2V readiness uses four models');
    check(!comfyEnvironmentReady({ phase: 'stopped', modelsRequired: 4, existing: [{ canStart: true, modelsFound: 3 }] }), 'missing R2V model cannot be ready');
    const c = new CanvasWorkflowController(`modes-${crypto.randomUUID()}`); await c.load();
    await c.edit([base]); window.h3Status = 'unknown'; await c.start('gen', true);
    const jobId = c.document.run.steps.gen.jobId, starts = window.h3Calls.filter(call => call.action === 'start').length;
    const restored = new CanvasWorkflowController(c.projectId); await restored.load(); window.h3Status = 'done'; await restored.continue();
    check(restored.document.run.status === 'done', 'text task recovered');
    check(window.h3Calls.at(-1).requestId === jobId && window.h3Calls.at(-1).action === 'status', 'recovery queries original job');
    check(window.h3Calls.filter(call => call.action === 'start').length === starts, 'recovery cannot resubmit');
    for (const ids of [[], ['a', 'b']]) {
      const invalid = new CanvasWorkflowController(`invalid-${crypto.randomUUID()}`); await invalid.load();
      await invalid.edit([{ ...base, comfyVideo: comfyVideoOptionsForMode(DEFAULT_COMFY_VIDEO, 'reference'), inputs: { 'first-frame': ids.map(assetId => ({ assetId })) } }]);
      const count = window.h3Calls.length; await invalid.start('gen', true);
      check(invalid.document.run.status === 'failed' && window.h3Calls.length === count, 'reference requires exactly one source');
    }
    return true;
  });
  assert.equal(checks, true); assert.deepEqual(errors, []);
  for (const theme of ['light', 'dark']) { await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme); await page.screenshot({ path: `.tmp/h3-modes/text-${theme}.png` }); }
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.run.status === 'done');
  await page.evaluate(() => window.needModels = 'reference');
  await card.getByLabel('H3 模式', { exact: true }).click(); await page.getByRole('option', { name: '单图', exact: true }).click();
  await page.waitForFunction(() => window.envCalls.at(-1)?.mode === 'reference');
  await card.getByRole('button', { name: '本地部署工作流：环境未就绪，打开环境设置', exact: true }).click();
  await page.getByRole('button', { name: '下载模型', exact: true }).click();
  await page.waitForFunction(() => window.envCalls.some(call => call.action === 'install' && call.mode === 'reference'));
  await page.getByRole('dialog', { name: '本地部署工作流环境设置', exact: true }).waitFor({ state: 'hidden' });
  console.log('H3 modes UI/runtime: reference + text inputs, defaults, ports, persistence, scoped detection, invalid sources and original-task recovery passed');
} catch (error) { console.error('page errors', errors, 'body', (await page.locator('body').innerText()).slice(-3500)); throw error; }
finally { await browser.close(); await server.close(); }
