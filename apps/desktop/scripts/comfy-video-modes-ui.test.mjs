import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

await mkdir('.tmp/h3-modes', { recursive: true });
const server = await createServer({ optimizeDeps: { entries: ["scripts/fixtures/canvas-reference/preview.html"] }, cacheDir: '.tmp/h3-modes/vite', server: { host: '127.0.0.1', port: 1698, strictPort: true, hmr: false, watch: null } });
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
      if (command === 'plugin:dialog|open' && args.options?.title === '选择已有 ComfyUI') return 'D:/Local/ComfyUI';
      if (command === 'comfy_video_environment') {
        window.envCalls.push(args);
        if (args.action === 'select_existing') window.selectedComfyPath = args.existingDirectory;
        if (args.action === 'install') window.needModels = null;
        return window.needModels === args.mode
          ? { mode: args.mode, phase: 'unavailable', endpoint: args.endpoint, directory: 'C:/AppData/Bowerbird-ComfyUI',
            existing: window.selectedComfyPath ? [{ path: window.selectedComfyPath, canStart: true, modelsFound: 3 }] : [],
            message: '缺少此模式的模型', canInstall: true, canAddModels: true, installed: false, downloadBytes: 21e9, requiredBytes: 24e9 }
          : { mode: args.mode, phase: 'ready', endpoint: args.endpoint, message: '已就绪' };
      }
      if (command === 'comfy_video') {
        window.h3Calls.push(args);
        if (args.action === 'cancel' && window.h3CancelStalls) return new Promise(() => {});
        if (args.action === 'start' && window.h3StartStalls) {
          return new Promise(resolve => { window.finishH3Start = resolve; });
        }
        if (window.h3Status === 'offline') {
          window.h3Status = window.afterRestart ?? 'done';
          return { status: 'offline', originalService: ['http://127.0.0.1:18189','text','D:/Original/ComfyUI'], message: '本机视频服务已断开。' };
        }
        return { status: args.action === 'cancel' ? 'cancelled' : window.h3Status, message: '模拟', asset: window.h3Asset };
      }
      return invoke(command, args);
    };
    const { api } = await import('/src/lib/api.ts');
    api.getAssetsByIds = async ids => ids.map(id => id === 'h3-result' ? window.h3Asset : {
      id, store_path: '/synthetic.png', width: 256, height: 256,
      thumb_path: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">
        <rect width="256" height="256" fill="${id === 'a' ? '#395264' : '#63455a'}"/>
        <circle cx="${id === 'a' ? 150 : 96}" cy="135" r="48" fill="#c0a49a"/></svg>`)}`,
    });
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
    await c.edit([
      { ...newWorkflowNode('trigger', 120, 560, 'codex'), id: 'source' },
      { ...newWorkflowNode('comfy-video', 400, 60, 'codex'), id: 'h3', prompt: '主体 <Picture 1> 在雨中行走',
        inputs: { signal: [{ nodeId: 'source', portId: 'signal' }], 'first-frame': [{ assetId: 'a' }], 'last-frame': [{ assetId: 'b' }] } },
    ]);
  });
  const card = page.locator('[data-workflow-card="h3"]');
  const frame = card.locator('.comfy-frame-slot[aria-label="首帧输入"]');
  assert.ok(await frame.evaluate(element => element.offsetHeight <= 56), 'compact first-frame slot');
  await frame.getByRole('img', { name: '首帧', exact: true }).hover();
  await card.locator('.comfy-frame-preview').waitFor();
  await card.locator('header').hover();
  await card.locator('.comfy-frame-preview').waitFor({ state: 'hidden' });
  const runButton = card.getByRole('button', { name: '运行', exact: true });
  assert.equal(await runButton.getAttribute('title'), '本机算力·不扣额度');
  const autoOptimize = card.getByRole('checkbox', { name: '自动优化提示词' });
  assert.equal(await autoOptimize.isChecked(), false);
  await autoOptimize.check();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.id === 'h3')?.comfyAutoOptimize === true);
  assert.equal(await card.getByText('本机算力·不扣额度', { exact: true }).count(), 0);
  assert.equal(await card.locator('.workflow-bindings').count(), 0);
  const controls = await card.getByRole('group', { name: '视频参数' }).evaluate(group => [...group.children].map(child => {
    const { top, width, height } = child.getBoundingClientRect();
    return { name: child.textContent, center: top + height / 2, width };
  }));
  const centers = controls.map(control => control.center);
  assert.ok(Math.max(...centers) - Math.min(...centers) <= 2, `H3 options share a single row: ${JSON.stringify(controls)}`);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await card.screenshot({ path: `.tmp/h3-modes/compact-frames-${theme}.png` });
  }
  const waitFrames = (first, last) => page.waitForFunction(([first, last]) => {
    const node = JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(n => n.id === 'h3');
    return (node.inputs['first-frame']?.[0]?.assetId ?? null) === first
      && (node.inputs['last-frame']?.[0]?.assetId ?? null) === last;
  }, [first, last]);
  const swap = card.getByRole('button', { name: /交换首尾帧|调换首尾帧/ });
  await swap.click();
  await waitFrames('b', 'a');
  await page.reload(); await card.waitFor(); await mock();
  assert.equal(await autoOptimize.isChecked(), true);
  await autoOptimize.uncheck();
  await waitFrames('b', 'a');
  await card.locator('.comfy-frame-slot[aria-label="尾帧输入"]').hover();
  await card.getByRole('button', { name: /断开尾帧/ }).click();
  await waitFrames('b', null);
  await card.locator('.comfy-frame-slot[aria-label="首帧输入"]').hover();
  await card.getByRole('button', { name: /断开首帧/ }).click();
  await waitFrames(null, null);
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const c = canvasWorkflowController('p');
    await c.edit(c.document.nodes.map(n => n.id === 'h3' ? { ...n, inputs: { 'first-frame': [{ assetId: 'a' }], 'last-frame': [{ assetId: 'b' }] } } : n));
  });
  assert.match(await card.locator('header').innerText(), /视频生成/);
  const modelTrigger = card.getByTitle('选择视频模型', { exact: true });
  const modelMenu = page.getByRole('dialog', { name: '视频模型', exact: true });
  await modelTrigger.click();
  await modelMenu.waitFor({ state: 'visible' });
  await card.locator('header').click();
  await modelMenu.waitFor({ state: 'hidden', timeout: 1500 });
  assert.equal(await modelTrigger.getAttribute('aria-expanded'), 'false');
  await modelTrigger.click();
  await modelMenu.waitFor({ state: 'visible' });
  await page.locator('[data-canvas-stage]').click({ position: { x: 80, y: 80 } });
  await modelMenu.waitFor({ state: 'hidden' });
  await modelTrigger.click();
  await modelMenu.waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await modelMenu.waitFor({ state: 'hidden' });
  assert.equal(await modelTrigger.evaluate(button => document.activeElement === button), true);
  await modelTrigger.click();
  await page.evaluate(() => window.store.setState({ dreaminaHealth: { ok: true } }));
  await modelMenu.locator('[data-model-key="jimeng:seedance2.5"]').click();
  await card.getByLabel('视频时长（秒）').waitFor();
  await card.getByTitle('选择视频模型', { exact: true }).click();
  await modelMenu.locator('[data-model-key="local:h3"]').click();
  await card.getByLabel('H3 模式', { exact: true }).click();
  await page.getByRole('option', { name: '单图', exact: true }).click();
  assert.equal(await card.locator('.comfy-frame-slot').count(), 1);
  assert.equal(await card.getByLabel('参考图输入', { exact: true }).count(), 1);
  assert.match(await card.getByLabel('H3 时长', { exact: true }).innerText(), /5 秒/);
  await card.getByLabel('H3 分辨率', { exact: true }).click();
  assert.deepEqual(await page.getByRole('listbox', { name: 'H3 分辨率', exact: true }).getByRole('option').allTextContents(), ['低', '中', '高']);
  await page.keyboard.press('Escape');
  assert.equal(await card.getByRole('button', { name: '添加上游', exact: true }).count(), 1);
  await runButton.click();
  await page.waitForFunction(() => window.h3Calls.some(call => call.action === 'start'));
  let input = await page.evaluate(() => window.h3Calls.find(call => call.action === 'start').input);
  assert.equal(input.mode, 'reference'); assert.equal(input.firstFrame, 'a'); assert.equal(input.lastFrame, undefined);
  assert.equal(input.resolution, .98); assert.equal(input.seconds, 5); assert.match(input.prompt, /<Picture 1>/);
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.run.status === 'done');
  // Completion refreshes the canvas. Reopen if that refresh dismissed the first popup.
  const modePicker = card.getByLabel('H3 模式', { exact: true });
  const textOption = page.getByRole('option', { name: '文生视频', exact: true });
  await modePicker.click();
  try { await textOption.click({ timeout: 1500 }); }
  catch (error) {
    if (await modePicker.getAttribute('aria-expanded') === 'true') throw error;
    await modePicker.click();
    await textOption.click();
  }
  assert.equal(await card.locator('.comfy-frame-slot').count(), 0);
  await card.getByLabel('H3 比例', { exact: true }).click();
  assert.equal(await page.getByRole('option', { name: '自动', exact: true }).count(), 0);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.envCalls.some(call => call.action === 'detect' && call.mode === 'text'));
  await page.reload(); await card.waitFor(); await mock();
  assert.match(await card.getByLabel('H3 模式', { exact: true }).innerText(), /文生视频/);
  await runButton.click();
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
    const restored = new CanvasWorkflowController(c.projectId); await restored.load(); window.h3Status = 'offline'; await restored.continue();
    check(window.envCalls.some(call => call.action === 'recover' && call.endpoint === 'http://127.0.0.1:18189' && call.mode === 'text' &&
      call.existingDirectory === 'D:/Original/ComfyUI'), 'restart original local service and installation');
    check(restored.document.run.status === 'done', 'text task recovered');
    check(window.h3Calls.at(-1).requestId === jobId && window.h3Calls.at(-1).action === 'status', 'recovery queries original job');
    check(window.h3Calls.filter(call => call.action === 'start').length === starts, 'recovery cannot resubmit');
    const lost = new CanvasWorkflowController(`lost-${crypto.randomUUID()}`); await lost.load();
    await lost.edit([base]); window.h3Status = 'unknown'; await lost.start('gen', true);
    const beforeRestart = window.h3Calls.filter(call => call.action === 'start').length;
    window.h3Status = 'offline'; window.afterRestart = 'unknown'; await lost.continue();
    check(lost.document.run.status === 'failed' && !lost.isLocked('gen'), 'lost job releases original Run control');
    check(window.h3Calls.filter(call => call.action === 'start').length === beforeRestart, 'lost job never replays automatically');
    window.h3Status = 'done'; await lost.start('gen', true);
    check(lost.document.run.status === 'done', 'existing Run works after lost job');
    const stalled = new CanvasWorkflowController(`stop-${crypto.randomUUID()}`); await stalled.load();
    await stalled.edit([base]); window.h3Status = 'unknown'; await stalled.start('gen', true);
    const originalJob = stalled.document.run.steps.gen.jobId;
    window.h3CancelStalls = true;
    const realTimeout = window.setTimeout;
    window.setTimeout = (callback, delay, ...args) => realTimeout(callback, delay === 20000 ? 50 : delay, ...args);
    try {
      await stalled.stop().then(() => { throw Error('stop should time out'); }, error => check(String(error).includes('超时'), 'stop reports timeout'));
      const step = stalled.document.run.steps.gen;
      check(stalled.document.run.status === 'waiting' && !step.comfyStopping && !step.comfyCancelled &&
        step.jobId === originalJob && step.detail.includes('尚未确认'), 'timeout clears stopping and preserves the original job');
    } finally {
      window.setTimeout = realTimeout;
      window.h3CancelStalls = false;
    }
    await stalled.stop();
    check(window.h3Calls.at(-1).requestId === originalJob && stalled.document.run.steps.gen.comfyCancelled, 'retry stops the same job');
    const inFlight = new CanvasWorkflowController(`stop-start-${crypto.randomUUID()}`); await inFlight.load();
    await inFlight.edit([base]); window.h3StartStalls = true;
    const starting = inFlight.start('gen', true);
    try {
      while (!window.finishH3Start) await new Promise(resolve => setTimeout(resolve, 5));
      const job = inFlight.document.run.steps.gen.jobId;
      await inFlight.stop();
      check(window.h3Calls.at(-1).action === 'cancel' && window.h3Calls.at(-1).requestId === job &&
        inFlight.document.run.status === 'stopped', 'cancel reaches the original job while start IPC is still pending');
    } finally {
      window.h3StartStalls = false;
      window.finishH3Start?.({ status: 'running', message: 'late start response' });
      await starting;
    }
    check(inFlight.document.run.status === 'stopped', 'late start cannot reopen the stopped job');
    window.h3Status = 'done';
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
  const modes = card.getByLabel('H3 模式', { exact: true });
  await modes.focus();
  await modes.press('ArrowUp');
  const referenceOption = page.getByRole('option', { name: '单图', exact: true });
  try { await referenceOption.press('Enter', { timeout: 1500 }); }
  catch (error) {
    if (await modes.getAttribute('aria-expanded') === 'true') throw error;
    await modes.press('ArrowUp');
    await referenceOption.press('Enter');
  }
  await page.waitForFunction(() => window.envCalls.at(-1)?.mode === 'reference');
  await card.getByRole('button', { name: '本地部署工作流：环境未就绪，打开环境设置', exact: true }).click();
  const environmentDialog = page.getByRole('dialog', { name: '本地部署工作流环境设置', exact: true });
  await environmentDialog.getByRole('button', { name: '选择已有 ComfyUI', exact: true }).click();
  await environmentDialog.getByText('D:/Local/ComfyUI', { exact: true }).waitFor();
  assert.equal(await environmentDialog.getByText('C:/AppData/Bowerbird-ComfyUI', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '下载模型', exact: true }).click();
  await page.waitForFunction(() => window.envCalls.some(call => call.action === 'install' && call.mode === 'reference'));
  await page.getByRole('dialog', { name: '本地部署工作流环境设置', exact: true }).waitFor({ state: 'hidden' });
  console.log('H3 modes UI/runtime: reference + text inputs, defaults, ports, persistence, scoped detection, invalid sources and original-task recovery passed');
} catch (error) { console.error('page errors', errors, 'body', (await page.locator('body').innerText()).slice(-3500)); throw error; }
finally { await browser.close(); await server.close(); }
