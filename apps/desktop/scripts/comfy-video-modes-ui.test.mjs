import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
import { placeWorkflowCard } from './fixtures/canvas-reference/place-card.mjs';

await mkdir('.tmp/h3-modes', { recursive: true });
const server = await createServer({ optimizeDeps: { entries: ["scripts/fixtures/canvas-reference/preview.html"] }, cacheDir: '.tmp/h3-modes/vite', server: { host: '127.0.0.1', port: 1698, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(8000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
const syntheticVoice = { id: 'voice', name: '合成录音.wav', ext: 'wav', store_path: '/synthetic-voice.wav', duration: 3, source: 'external' };
const syntheticClip = { id: 'r2v-clip', name: '合成参考视频.mp4', ext: 'mp4', store_path: '/synthetic-clip.mp4', duration: 3, source: 'external' };
async function mock() {
  await page.evaluate(async ([voice, clip]) => {
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
    api.getAssetsByIds = async ids => ids.filter(id => id !== 'missing-audio').map(id => id === 'h3-result' ? window.h3Asset : id === voice.id ? voice : id === clip.id ? clip : {
      id, store_path: '/synthetic.png', width: 256, height: 256,
      thumb_path: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">
        <rect width="256" height="256" fill="${id === 'a' ? '#395264' : '#63455a'}"/>
        <circle cx="${id === 'a' ? 150 : 96}" cy="135" r="48" fill="#c0a49a"/></svg>`)}`,
    });
    window.store.setState({ startGeneration: async () => { throw Error('Must use local H3'); } });
  }, [syntheticVoice, syntheticClip]);
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
  assert.match(await card.getByLabel('H3 比例', { exact: true }).innerText(), /自动/);
  const frame = card.locator('.comfy-frame-slot[aria-label="首帧输入"]');
  assert.ok(await frame.evaluate(element => element.offsetHeight <= 56), 'compact first-frame slot');
  await frame.getByRole('img', { name: '首帧', exact: true }).hover();
  await card.locator('.comfy-frame-preview').waitFor();
  await card.locator('header').hover();
  await card.locator('.comfy-frame-preview').waitFor({ state: 'hidden' });
  const runButton = card.getByRole('button', { name: /^(运行|重试)$/ });
  assert.equal(await runButton.getAttribute('title'), '本机算力·不扣额度');
  const autoOptimize = card.getByRole('checkbox', { name: '自动优化提示词' });
  assert.equal(await autoOptimize.isChecked(), false);
  await autoOptimize.check();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('canvas-settings')).h3_auto_optimize_prompt === true);
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
  assert.equal(await card.locator('.comfy-frame-disconnect').first().evaluate(button => getComputedStyle(button).borderTopLeftRadius), '0px');
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
  const setDragged = ids => page.evaluate(async ids => (await import('/src/lib/dragPayload.ts')).setDragAssets(ids), ids);
  await setDragged(['voice']);
  const referenceAudio = card.getByRole('group', { name: '参考音频' });
  await referenceAudio.getByText('（可选，如角色声音）', { exact: true }).waitFor();
  await referenceAudio.dispatchEvent('drop');
  await setDragged(null);
  await card.getByText('合成录音.wav', { exact: true }).waitFor();
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
  assert.equal(await card.getByText('合成录音.wav', { exact: true }).count(), 0);
  await card.getByTitle('选择视频模型', { exact: true }).click();
  await modelMenu.locator('[data-model-key="local:h3"]').click();
  await card.getByLabel('H3 模式', { exact: true }).click();
  await page.getByRole('option', { name: '单图', exact: true }).click();
  await card.getByRole('group', { name: '参考音频' }).getByText('合成录音.wav').waitFor();
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
  assert.equal(input.ratio, 'auto');
  assert.equal(input.resolution, .98); assert.equal(input.seconds, 5); assert.match(input.prompt, /<Picture 1>/);
  assert.equal(input.audioAssetId, 'voice'); assert.match(input.prompt, /<Audio 1>/);
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.run.status === 'done');

  // A normal image-card save writes the whole board, including the existing H3 recording and run.
  const readBoard = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('workflow-p')));
  const beforeImage = await readBoard();
  const audioInput = beforeImage.document.nodes.find(node => node.id === 'h3').inputs['reference-audio'];
  const oldRun = beforeImage.document.run;
  await placeWorkflowCard(page, '新增生成卡片');
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.some(node =>
    node.kind === 'generation' && node.generation?.media !== 'video'));
  const withImage = await readBoard();
  const imageCard = withImage.document.nodes.find(node => node.kind === 'generation' && node.generation?.media !== 'video');
  assert.ok(withImage.revision > beforeImage.revision);
  assert.deepEqual(withImage.document.nodes.find(node => node.id === 'h3').inputs['reference-audio'], audioInput);
  assert.deepEqual(withImage.document.run, oldRun);
  // The reloaded fixture must see the attached audio during its initial asset read.
  await page.evaluate(voice => {
    const drafts = JSON.parse(sessionStorage.getItem('reference-drafts') || '[]');
    sessionStorage.setItem('reference-drafts', JSON.stringify([...drafts, voice]));
  }, syntheticVoice);
  await page.reload(); await card.waitFor(); await mock();
  await page.locator(`[data-workflow-card="${imageCard.id}"]`).waitFor();
  await card.getByRole('group', { name: '参考音频' }).getByText('合成录音.wav').waitFor();
  assert.equal(await page.locator('.workflow-save-error').count(), 0);
  await runButton.click();
  await page.waitForFunction(() => window.h3Calls.some(call => call.action === 'start'));
  assert.deepEqual(await page.evaluate(() => window.h3Calls.find(call => call.action === 'start').input), input);
  await page.waitForFunction(runId => {
    const run = JSON.parse(sessionStorage.getItem('workflow-p')).document.run;
    return run.id !== runId && run.status === 'done';
  }, oldRun.id);

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
  assert.equal(input.ratio, '9:16');
  assert.equal(input.audioAssetId, 'voice'); assert.doesNotMatch(input.prompt, /<Audio 1>/);
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.run.status === 'done');
  await card.getByRole('button', { name: '断开参考音频' }).click();
  await page.waitForFunction(() => !JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.id === 'h3').inputs['reference-audio']?.length);
  const checks = await page.evaluate(async () => {
    const { CanvasWorkflowController, filterAutomaticMediaValues } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode, selectWorkflowVideoProvider, workflowExecutionNodes, workflowInputs } = await import('/src/lib/canvasWorkflow.ts');
    const { DEFAULT_COMFY_VIDEO, comfyEnvironmentReady, comfyVideoOptionsForMode } = await import('/src/lib/comfyVideo.ts');
    const { planAutomaticConnection } = await import('/src/lib/workflowAutoConnect.ts');
    const check = (value, message) => { if (!value) throw Error(message); };
    const base = { ...newWorkflowNode('comfy-video', 0, 0, 'codex'), id: 'gen', prompt: '测试', comfyVideo: comfyVideoOptionsForMode(DEFAULT_COMFY_VIDEO, 'text'), inputs: { 'first-frame': [{ nodeId: 'missing', portId: 'image' }], 'last-frame': [{ assetId: 'stale' }] } };
    const linkedH3 = { ...base, inputs: { 'reference-audio': [{ nodeId: 'worker', portId: 'image', mediaFilter: ['audio'] }] } };
    const remote = selectWorkflowVideoProvider(linkedH3, 'cloud');
    for (const hiddenDependency of [false, true]) {
      const board = new CanvasWorkflowController(`parked-audio-${crypto.randomUUID()}`); await board.load();
      const hiddenReader = { ...base, id: 'hidden', inputs: { 'first-frame': [{ nodeId: remote.id, portId: 'image' }] } };
      const worker = { ...newWorkflowNode('agent', 0, 0, 'codex'), id: 'worker',
        inputs: { image: [{ nodeId: hiddenDependency ? hiddenReader.id : remote.id, portId: 'image' }] } };
      await board.edit([remote, worker, ...(hiddenDependency ? [hiddenReader] : [])]);
      const readSaved = () => sessionStorage.getItem(`workflow-${board.projectId}`);
      const prior = readSaved();
      const state = JSON.stringify(board.document);
      const restoreH3 = () => board.edit(board.document.nodes.map(node =>
        node.id === remote.id ? selectWorkflowVideoProvider(node, 'h3') : node));
      await restoreH3().then(() => { throw Error('a parked recording must not restore a circular connection'); },
        error => check(String(error).includes('循环'), 'cycle is rejected during provider switch'));
      check(readSaved() === prior && JSON.stringify(board.document) === state, 'failed switch leaves saved revision and current provider intact');
      const image = newWorkflowNode('generation', 320, 0, 'codex');
      await board.edit([...board.document.nodes, image]);
      const saved = JSON.parse(readSaved());
      check(saved.revision > JSON.parse(prior).revision && saved.document.nodes.some(node => node.id === image.id), 'normal image card saves after rejected switch');
      await board.edit(board.document.nodes.filter(node => node.id === remote.id || node.id === image.id));
      await restoreH3();
      const restored = board.document.nodes.find(node => node.id === remote.id);
      check(restored.kind === 'comfy-video' && !restored.inputs['reference-audio']?.length, 'missing parked source is removed when restoring H3');
    }
    check(Object.keys(workflowExecutionNodes([base], 'gen')[0].inputs).length === 0, 'text must not resolve hidden inputs');
    check(workflowInputs(base).map(p => p.id).join() === 'text,reference-audio', 'text mode has text and audio without picture ports');
    check(planAutomaticConnection([base], [{ binding: { assetId: 'a' }, type: 'image', media: 'image' }], 'gen').error, 'text mode rejects automatic image connections');
    const mixedOutput = { binding: { canvasNodeId: 'mix', cellId: '*' }, type: 'image', media: ['image', 'audio'] };
    const mixed = planAutomaticConnection([base], [mixedOutput], 'gen');
    check(mixed.bindings[0]?.inputId === 'reference-audio', 'text mode projects audio from a known mixed source');
    check(planAutomaticConnection([base], [{ ...mixedOutput, media: undefined }], 'gen').error, 'unknown sources cannot silently occupy optional audio');
    const projected = { 'reference-audio': [{ type: 'image', assetIds: ['a', 'voice'] }] };
    await filterAutomaticMediaValues({ ...base, inputs: { 'reference-audio': [mixed.bindings[0].binding] } }, projected);
    check(projected['reference-audio'][0].assetIds.join() === 'voice', 'mixed source resolves one audio asset');
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
    const frameAudio = new CanvasWorkflowController(`frame-audio-${crypto.randomUUID()}`); await frameAudio.load();
    await frameAudio.edit([{ ...base, comfyVideo: comfyVideoOptionsForMode(DEFAULT_COMFY_VIDEO, 'frames'), inputs: {
      'first-frame': [{ assetId: 'a' }], 'last-frame': [{ assetId: 'b' }], 'reference-audio': [{ assetId: 'voice' }],
    } }]);
    window.h3Status = 'done'; await frameAudio.start('gen', true);
    const framesInput = window.h3Calls.findLast(call => call.action === 'start').input;
    check((framesInput.mode ?? 'frames') === 'frames' && framesInput.firstFrame === 'a' && framesInput.lastFrame === 'b' && framesInput.audioAssetId === 'voice', 'frame endpoints and audio reach the same request');
    const badAudio = new CanvasWorkflowController(`bad-audio-${crypto.randomUUID()}`); await badAudio.load();
    await badAudio.edit([{ ...base, inputs: { 'reference-audio': [{ assetId: 'missing-audio' }] } }]);
    const beforeBadAudio = window.h3Calls.filter(call => call.action === 'start').length;
    await badAudio.start('gen', true);
    check(window.h3Calls.filter(call => call.action === 'start').length === beforeBadAudio, 'missing audio does not submit an H3 request');
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

  await modes.click();
  await page.getByRole('option', { name: '多素材参考（R2V）', exact: true }).click();
  const groups = [ ['参考图片输入', 'reference-image', ['a', 'b']], ['参考视频输入', 'reference-video', ['r2v-clip']], ['独立录音输入', 'r2v-audio', ['voice']] ];
  for (const [group, port, ids] of groups) {
    await setDragged(ids);
    await card.getByRole('group', { name: group, exact: true }).dispatchEvent('drop');
    await setDragged(null);
    await page.waitForFunction(([port, count]) => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.id === 'h3').inputs[port]?.length === count, [port, ids.length]);
  }
  assert.match(await card.getByRole('group', { name: '参考图片输入' }).innerText(), /<Picture 1>[\s\S]*<Picture 2>/);
  await page.evaluate(clip => {
    const refs = JSON.parse(sessionStorage.getItem('reference-drafts') || '[]');
    sessionStorage.setItem('reference-drafts', JSON.stringify([...refs, clip]));
  }, syntheticClip);
  await page.reload(); await card.waitFor(); await mock();
  await card.getByRole('group', { name: '参考视频输入', exact: true }).getByText('合成参考视频.mp4').waitFor();
  await runButton.click();
  await page.waitForFunction(() => window.h3Calls.some(call => call.action === 'start'));
  const submitted = await page.evaluate(() => window.h3Calls.find(call => call.action === 'start').input);
  assert.equal(submitted.mode, 'r2v');
  assert.equal(submitted.firstFrame, '');
  assert.equal(submitted.ratio, 'auto');
  for (const [inputField, group] of ['referenceImages', 'referenceVideos', 'referenceAudios'].map((field, i) => [field, groups[i]])) {
    assert.deepEqual(submitted[inputField], group[2]);
  }
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.run.status === 'done');
  assert.deepEqual((await readBoard()).document.run.steps.h3.generationRunInput.references, groups.map(group => group[2]));
  assert.deepEqual(errors, []);
  console.log('H3 modes UI/runtime: image-card save, R2V media ordering and reopen, invalid sources and original-task recovery passed');
} catch (error) { console.error('page errors', errors, 'body', (await page.locator('body').innerText()).slice(-3500)); throw error; }
finally { await browser.close(); await server.close(); }
