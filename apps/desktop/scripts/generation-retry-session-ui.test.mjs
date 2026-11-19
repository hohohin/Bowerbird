import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

// Real store, canvas and inspector; synthetic IPC only, no provider or user library.
const server = await createServer({ root: process.cwd(),
  cacheDir: '.tmp/retry-session/vite-cache',
  server: { host: '127.0.0.1', port: 1598, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await mkdir('.tmp/retry-session', { recursive: true });
try {
  await page.goto('http://127.0.0.1:1598/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { generationPromptNodeId } = await import('/src/lib/projectNodeIds.ts');
    const saved = window.snapshot();
    const base = saved.nodes[0];
    const jobId = 'retry-job';
    const first = { ...base, id: generationPromptNodeId(jobId, 'initial'), kind: 'prompt',
      assetId: null, role: null, x: 100, y: 100, width: 260, height: 148,
      payloadJson: JSON.stringify({ schema_version: 1, job_id: jobId, turn_key: 'initial',
        text: '合成失败重试', provider: 'codex', status: 'failed', error: '模拟首轮失败' }) };
    saved.nodes = [first]; saved.edges = [];
    saved.view = { ...saved.view, panX: 50, panY: 60, zoom: 1 };
    const originalInvoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'project_canvas_get') return structuredClone(saved);
      if (command === 'project_canvas_node_update') {
        const node = saved.nodes.find(node => node.id === args.nodeId);
        Object.assign(node, args.value);
        return structuredClone(node);
      }
      return originalInvoke(command, args);
    };
    window.retryTest = { requests: [], saved, firstId: first.id };
    window.store.setState({
      genJobs: { [jobId]: { id: jobId, conversationId: jobId, sessionId: null,
        projectId: 'p', threadId: 't', provider: 'codex', media: 'image', createdAt: 1,
        streaming: '', running: false, lastPrompt: '合成失败重试', lastRefs: [], refAssets: [], lastRatio: '1:1',
        turns: [{ id: 1, turnKey: 'initial', prompt: '合成失败重试', promptRaw: '合成失败重试',
          provider: 'codex', media: 'image', ratio: '1:1', refs: [], refAssets: [], images: [], error: '模拟首轮失败' }] } },
      genJobOrder: [jobId], activeJobId: null, boardOpen: false,
      codexHealth: { ok: true }, cloudEntitlement: { tier: 'pro', balances: { daily: 100, sub: 0, topup: 0 },
        policy: { can_use_byo: true, max_parallel_jobs: 4 } },
    });
    api.codexCreateImage = async request => {
      window.retryTest.requests.push(structuredClone(request));
      saved.nodes.push({ ...first, id: generationPromptNodeId(request.jobId, request.turnKey),
        createdAt: window.retryTest.requests.length + 1,
        payloadJson: JSON.stringify({ schema_version: 1, job_id: request.jobId, turn_key: request.turnKey,
          text: request.prompt, provider: request.provider, status: 'running' }) });
      window.emitChange();
      await new Promise(resolve => { window.retryTest.finish = async success => {
        const node = saved.nodes.find(node => node.id === generationPromptNodeId(request.jobId, request.turnKey));
        const payload = JSON.parse(node.payloadJson);
        node.payloadJson = JSON.stringify({ ...payload, status: success ? 'done' : 'failed', error: success ? null : '模拟续轮失败' });
        if (success) {
          const asset = window.store.getState().assets.find(asset => asset.id === 'a');
          saved.nodes.push({ ...base, id: `output-${request.turnKey}`, assetId: asset.id, role: 'output',
            createdAt: window.retryTest.requests.length + 1,
            payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: asset.name, width: 190, height: 150 },
              execution: { job_id: request.jobId, turn_key: request.turnKey } }) });
          window.store.getState().applyGenChunk({ kind: 'done', job_id: request.jobId,
            session_id: 'synthetic-session', provider: 'codex', images: [asset.store_path] });
        } else {
          window.store.getState().applyGenChunk({ kind: 'error', job_id: request.jobId, message: '模拟续轮失败' });
        }
        window.emitChange(); resolve();
      }; });
    };
    window.emitChange();
  });
  const firstId = await page.evaluate(() => window.retryTest.firstId);
  const card = page.locator(`[data-canvas-node-id="${firstId}"]`);
  await card.waitFor();
  await card.click();
  const panel = page.locator('[data-project-inspector]');
  await panel.waitFor();
  const originalPosition = await card.evaluate(node => node.style.transform);

  // Error action: first attempt never acquired a provider session.
  await panel.getByRole('button', { name: '↻ 重试', exact: true }).click();
  await page.waitForFunction(() => window.retryTest.requests.length === 1 && window.store.getState().genJobs['retry-job'].running);
  await page.waitForFunction(() => document.querySelectorAll('.canvas-prompt-node').length === 1);
  assert.equal(await page.evaluate(() => window.retryTest.requests[0].sessionId), null);
  assert.equal(await page.evaluate(() => window.store.getState().genJobs['retry-job'].turns[0].error), '模拟首轮失败');
  assert.equal(await panel.getByText('模拟首轮失败', { exact: true }).count(), 1);
  await page.screenshot({ path: '.tmp/retry-session/running.png' });

  // Fail again; the error action on the newest round appends a third attempt.
  await page.evaluate(() => window.retryTest.finish(false));
  await page.waitForFunction(() => !window.store.getState().genJobs['retry-job'].running);
  await panel.getByRole('button', { name: '↻ 重试', exact: true }).last().click();
  await page.waitForFunction(() => window.retryTest.requests.length === 2);
  await page.evaluate(() => window.retryTest.finish(true));
  await page.waitForFunction(() => !window.store.getState().genJobs['retry-job'].running);
  assert.equal(await page.locator('.canvas-prompt-node').count(), 1);
  await card.locator('[data-conversation-image="a"]').waitFor();
  const state = await page.evaluate(async () => {
    const { isGenerationTaskFailed, taskCenterGenerationJobs } = await import('/src/lib/projectActivity.ts');
    const { generationReminderKey } = await import('/src/lib/taskReminders.ts');
    const s = window.store.getState(), job = s.genJobs['retry-job'];
    return { ids: Object.keys(s.genJobs), order: s.genJobOrder, errors: job.turns.map(turn => turn.error ?? null),
      turnKeys: job.turns.map(turn => turn.turnKey), requests: window.retryTest.requests,
      failed: isGenerationTaskFailed(job), tasks: taskCenterGenerationJobs([job]).length, reminder: generationReminderKey(job) };
  });
  assert.deepEqual(state.ids, ['retry-job']);
  assert.deepEqual(state.order, ['retry-job']);
  assert.deepEqual(state.errors, ['模拟首轮失败', '模拟续轮失败', null]);
  assert.equal(new Set(state.turnKeys).size, 3);
  assert.equal(state.failed, false); assert.equal(state.tasks, 0); assert.equal(state.reminder, null);
  for (const request of state.requests) {
    assert.equal(request.jobId, 'retry-job'); assert.equal(request.conversationId, 'retry-job');
    assert.equal(request.prompt, '合成失败重试'); assert.deepEqual(request.referenceImages, []);
  }
  assert.equal(await card.evaluate(node => node.style.transform), originalPosition);

  // First-round retry icon must target its historical failure, not create a branch job.
  await panel.getByTitle('重试：在当前会话追加一轮', { exact: true }).click();
  await page.waitForFunction(() => window.retryTest.requests.length === 3);
  await page.evaluate(() => window.retryTest.finish(true));
  await page.waitForFunction(() => window.store.getState().genJobs['retry-job'].turns.length === 4 && !window.store.getState().genJobs['retry-job'].running);
  await page.waitForFunction(() => document.querySelector('.canvas-prompt-node')?.classList.contains('is-done'));
  assert.deepEqual(await page.evaluate(() => Object.keys(window.store.getState().genJobs)), ['retry-job']);
  assert.equal(await page.locator('.canvas-prompt-node').count(), 1);
  assert.equal(await page.locator('.canvas-prompt-node.canvas-card-running').count(), 0);
  await page.screenshot({ path: '.tmp/retry-session/completed.png' });

  // A historical turn keeps its own subscription even if newer rounds use another provider.
  await page.evaluate(() => window.store.setState(state => ({
    dreaminaHealth: { ok: false, reason: '即梦未登录' },
    genJobs: { ...state.genJobs, 'retry-job': { ...state.genJobs['retry-job'],
      turns: state.genJobs['retry-job'].turns.map((turn, index) => index === 0 ? { ...turn, provider: 'dreamina' } : turn) } },
  })));
  const oldRetry = panel.getByTitle(/即梦自有订阅未登录/);
  await oldRetry.first().waitFor();
  assert.deepEqual(await oldRetry.evaluateAll(buttons => buttons.map(button => button.disabled)), [true, true]);
  assert.ok(await panel.getByRole('button', { name: '↻ 重试', exact: true }).nth(1).isEnabled());

  // Historical Cloud video recovery must never target the job's newer successful round.
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { DEFAULT_VIDEO_OPTIONS } = await import('/src/lib/videoGeneration.ts');
    window.retryTest.recoveries = [];
    api.recoverCloudVideo = async jobId => { window.retryTest.recoveries.push(jobId); };
    window.store.setState(state => ({ genJobs: { ...state.genJobs, 'retry-job': {
      ...state.genJobs['retry-job'], turns: state.genJobs['retry-job'].turns.map((turn, index) => index === 0
        ? { ...turn, media: 'video', provider: 'bowerbird-cloud-video_seedance25_720p', videoOptions: DEFAULT_VIDEO_OPTIONS }
        : turn),
    } } }));
  });
  const historicalVideoRetry = panel.getByTitle('旧视频任务不支持在此取回', { exact: true });
  await historicalVideoRetry.first().waitFor();
  assert.equal(await historicalVideoRetry.count(), 2, 'both first-round icon and error action explain unavailable historical recovery');
  assert.deepEqual(await historicalVideoRetry.evaluateAll(buttons => buttons.map(button => button.disabled)), [true, true]);
  await historicalVideoRetry.evaluateAll(buttons => buttons.forEach(button => button.click()));
  assert.deepEqual(await page.evaluate(() => window.retryTest.recoveries), []);
  const requests = await page.evaluate(() => window.retryTest.requests);
  assert.equal(requests.length, 3, 'historical video buttons must not create or recover a newer request');
  for (const request of requests) {
    assert.deepEqual(request.referenceImages, [], 'known empty references must not inherit later output images');
    assert.equal(request.exactReferences, true);
  }
  assert.deepEqual(errors, []);
  console.log('PASS: no-session failure, repeated failure, both retry entry points, one stable canvas card, preserved failed rounds, exact empty references, successful retry clears current failure/reminder, historical Cloud video actions cannot recover a newer round');
} catch (error) {
  await page.screenshot({ path: '.tmp/retry-session/failure.png' });
  throw error;
} finally {
  await browser.close();
  await server.close();
}
