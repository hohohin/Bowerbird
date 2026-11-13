import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

// Real store, canvas and inspector; synthetic IPC, no model calls or user library.
const server = await createServer({ cacheDir: '.tmp/generation-progress/vite', server: { host: '127.0.0.1', port: 17935, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await mkdir('.tmp/generation-progress', { recursive: true });
try {
  await page.goto('http://127.0.0.1:17935/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(() => {
    const saved = window.snapshot(), base = saved.nodes[0];
    saved.nodes = [{ ...base, id: 'gen-prompt:progress-job:current:0', kind: 'prompt', assetId: null, role: null,
      x: 120, y: 110, width: 300, height: 148, payloadJson: JSON.stringify({ schema_version: 1, job_id: 'progress-job',
        turn_key: 'current', text: '生成一张产品海报', provider: 'jimeng', status: 'running' }) }];
    saved.edges = []; saved.view = { ...saved.view, panX: 60, panY: 70, zoom: 1 };
    sessionStorage.setItem('reference-fixture', JSON.stringify(saved));
  });
  await page.reload();
  const card = page.locator('[data-canvas-node-id="gen-prompt:progress-job:current:0"]');
  await card.waitFor();
  await page.evaluate(() => {
    const job = { id: 'progress-job', conversationId: 'progress-job', sessionId: null, projectId: 'p', threadId: 't',
      provider: 'jimeng', media: 'image', createdAt: Date.now(), running: true, streaming: '', lastPrompt: '生成一张产品海报',
      lastRefs: [], refAssets: [], lastRatio: '1:1', turns: [{ id: 1, turnKey: 'current', prompt: '生成一张产品海报',
        provider: 'jimeng', media: 'image', ratio: '1:1', refs: [], refAssets: [], images: [], startedAt: Date.now() - 12000 }] };
    window.store.setState({ genJobs: { [job.id]: job }, genJobOrder: [job.id], activeJobId: null, boardOpen: false, generating: true });
  });
  await card.click();
  const panel = page.locator('[data-project-inspector]');
  await panel.waitFor();
  const send = data => page.evaluate(data => window.store.getState().applyGenChunk({ kind: 'progress', job_id: 'progress-job', turn_key: 'current', ...data }), data);
  for (const [stage, label] of [['waiting_slot', '等待本机提交名额'], ['submitting', '正在提交任务'], ['processing', '上游处理中'], ['tool_running', '正在执行工具'], ['generating', '正在生成图像'], ['saving', '正在保存结果']]) {
    await send({ stage });
    await card.getByText(label, { exact: true }).waitFor();
    await panel.getByRole('status').filter({ hasText: label }).waitFor();
  }
  await send({ stage: 'queued', queue_position: 3, queue_length: 9 });
  await card.getByText('排队中 · 队列位置 3 / 9', { exact: true }).waitFor();
  await send({ stage: 'saving', turn_key: 'previous' });
  await send({ stage: 'saving', job_id: 'unrelated-job' });
  assert.equal(await card.getByText('排队中 · 队列位置 3 / 9', { exact: true }).count(), 1);
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.screenshot({ path: `.tmp/generation-progress/${theme}.png` });
  }
  await send({ kind: 'submit', submit_id: 'synthetic-submit' });
  await card.getByText('上游处理中', { exact: true }).waitFor();
  await send({ kind: 'recover_started', prompt: '生成一张产品海报', provider: 'jimeng', submit_id: 'synthetic-submit' });
  assert.equal(await page.evaluate(() => window.store.getState().genJobs['progress-job'].progress), undefined);
  await send({ stage: 'querying' });
  await panel.getByRole('status').filter({ hasText: '正在查询原任务' }).waitFor();
  await page.evaluate(() => window.store.setState(state => ({ genJobs: { ...state.genJobs, 'progress-job': { ...state.genJobs['progress-job'], running: false } } })));
  await send({ stage: 'saving' });
  assert.equal(await page.evaluate(() => window.store.getState().genJobs['progress-job'].progress.stage), 'querying');
  assert.equal(await panel.getByRole('status').filter({ hasText: '正在查询原任务' }).count(), 0);
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    api.codexCreateImage = async () => new Promise(resolve => { window.finishProgressRevise = resolve; });
    window.store.setState(state => ({ codexHealth: { ok: true }, cloudEntitlement: { tier: 'pro', balances: { daily: 100, sub: 0, topup: 0 },
      policy: { can_use_byo: true, max_parallel_jobs: 4 } },
      genJobs: { ...state.genJobs, 'progress-job': { ...state.genJobs['progress-job'], sessionId: 'synthetic-session', provider: 'codex' } } }));
    window.progressRevise = window.store.getState().sendGenRevise('progress-job', '换一个构图', 'codex');
  });
  await page.waitForFunction(() => window.store.getState().genJobs['progress-job'].turns.length === 2);
  await panel.getByRole('status').filter({ hasText: '准备生成' }).waitFor();
  await send({ stage: 'queued', queue_position: 3, queue_length: 9 });
  assert.equal(await page.evaluate(() => window.store.getState().genJobs['progress-job'].progress), undefined, 'previous round cannot overwrite preparing next round');
  const { turnKey, previewUrl, finalPath } = await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const turnKey = window.store.getState().genJobs['progress-job'].turns.at(-1).turnKey;
    const previous = window.snapshot().nodes[0];
    await api.projectCanvasNodeCreate({ ...previous, id: `gen-prompt:progress-job:${turnKey}:0`,
      payloadJson: JSON.stringify({ schema_version: 1, job_id: 'progress-job', turn_key: turnKey,
        provider: 'codex', text: '换一个构图', status: 'running' }) });
    window.emitChange();
    const canvas = document.createElement('canvas');
    canvas.width = 80; canvas.height = 40;
    canvas.getContext('2d').fillRect(0, 0, 80, 40);
    return { turnKey, previewUrl: canvas.toDataURL('image/png'), finalPath: window.store.getState().assets.find(asset => asset.id === 'a').store_path };
  });
  const preview = { kind: 'preview', turn_key: turnKey, data_url: previewUrl };
  const readJob = () => page.evaluate(() => window.store.getState().genJobs['progress-job']);
  for (const foreign of [{ turn_key: 'current' }, { turn_key: undefined }, { job_id: 'another-job' }]) await send({ ...preview, ...foreign });
  assert.equal((await readJob()).preview, undefined);
  await send(preview);
  for (const box of [card, panel]) {
    const image = box.getByAltText('本轮生成预览');
    await image.waitFor();
    assert.equal(await image.evaluate(async el => { await el.decode(); return el.naturalWidth; }), 80);
  }
  assert.equal((await readJob()).running, true);
  assert.deepEqual((await readJob()).turns.at(-1).images, []);
  await page.evaluate(async turnKey => {
    const { api } = await import('/src/lib/api.ts');
    const prompt = window.snapshot().nodes.find(node => JSON.parse(node.payloadJson).turn_key === turnKey);
    await api.projectCanvasNodeUpdate(prompt.id, { payloadJson: JSON.stringify({ ...JSON.parse(prompt.payloadJson), status: 'done' }) });
    await api.projectCanvasNodeCreate({ ...prompt, id: `gen-output:progress-job:${turnKey}:a`, kind: 'asset', role: 'output', assetId: 'a',
      payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: '正式图片', width: 190, height: 150 },
        execution: { job_id: 'progress-job', turn_key: turnKey } }) });
    window.emitChange();
  }, turnKey);
  await send({ kind: 'done', turn_key: turnKey, provider: 'codex-cli', session_id: 'synthetic-session', images: [finalPath] });
  const finalCardImage = card.locator('[data-conversation-image="a"] img');
  await finalCardImage.waitFor();
  assert.equal(await finalCardImage.evaluate(async image => { await image.decode(); return image.naturalWidth; }), 190);
  await page.waitForFunction(src => [...document.querySelectorAll('[data-project-inspector] img')].some(el => el.src === src && el.naturalWidth === 190), finalPath);
  await send(preview);
  assert.equal((await readJob()).preview, undefined);
  assert.equal(await page.getByAltText('本轮生成预览').count(), 0);
  await page.evaluate(async () => { window.finishProgressRevise(); await window.progressRevise; });
  await page.evaluate(() => { window.progressRevise = window.store.getState().sendGenRevise('progress-job', '再调整一次', 'codex'); });
  await page.waitForFunction(() => window.store.getState().genJobs['progress-job'].turns.length === 3);
  const nextTurn = (await readJob()).turns.at(-1).turnKey;
  await send(preview);
  assert.equal((await readJob()).preview, undefined);
  await send({ ...preview, turn_key: nextTurn });
  await panel.getByAltText('本轮生成预览').waitFor();
  await send({ kind: 'error', turn_key: nextTurn, message: '已取消' });
  await send({ ...preview, turn_key: nextTurn });
  assert.equal((await readJob()).preview, undefined);
  assert.deepEqual((await readJob()).turns.flatMap(turn => turn.images), [finalPath]);
  await panel.getByAltText('本轮生成预览').waitFor({ state: 'detached' });
  await page.evaluate(async () => { window.finishProgressRevise(); await window.progressRevise; });
  assert.deepEqual(errors, []);
  console.log('PASS: canvas + inspector progress, running preview, formal image replacement, recovery, continuation and cancellation isolation; dark/light screenshots');
} catch (error) {
  await page.screenshot({ path: '.tmp/generation-progress/failure.png' });
  throw error;
} finally {
  await browser.close();
  await server.close();
}
