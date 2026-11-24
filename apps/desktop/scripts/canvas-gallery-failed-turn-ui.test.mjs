import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const entry = 'scripts/fixtures/canvas-reference/preview.html';
const server = await createServer({ cacheDir: '.tmp/gallery-failed-turn-vite', optimizeDeps: { entries: [entry] },
  server: { host: '127.0.0.1', port: 17994, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(40000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + entry);
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(() => {
    const graph = window.snapshot(), base = graph.nodes[0];
    const session = (id, job, group, status, x, y, at) => ({ ...base, id, kind: 'prompt', assetId: null, role: null,
      x, y, width: 260, height: 148, createdAt: at, payloadJson: JSON.stringify({ schema_version: 1,
        job_id: job, turn_key: 'turn-' + id, text: '提示词 ' + id, provider: 'dreamina-web55', status, workflow_generation_group: group }) });
    const picture = (assetId, parent, job) => ({ ...base, id: 'output-' + assetId, role: 'output', assetId,
      createdAt: parent.createdAt, payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: assetId, width: 190, height: 150 },
        execution: { job_id: job, turn_key: 'turn-' + parent.id }, workflow_generation_group: 'gallery' }) });
    const first = session('first', 'job-one', 'gallery', 'done', 150, 150, 1);
    const second = session('second', 'job-two', 'gallery', 'done', 500, 150, 2);
    const failed = session('latest', 'job-three', 'gallery', 'failed', 890, 150, 3);
    const noImage = session('no-image', 'empty-job', 'empty-gallery', 'failed', 560, 480, 1);
    const agent = { ...noImage, id: 'failed-agent', kind: 'agent_group', x: 850, y: 180,
      payloadJson: JSON.stringify({ schema_version: 1, run_id: 'failed-run', status: 'failed' }) };
    graph.nodes = [first, picture('a', first, 'job-one'), second, picture('b', second, 'job-two'), failed, noImage, agent];
    graph.edges = [first, second].map((node, i) => ({ id: 'produced-' + i, projectId: 'p', threadId: 't',
      fromNodeId: node.id, toNodeId: 'output-' + ['a', 'b'][i], kind: 'produced', ordinal: 0, createdAt: node.createdAt }));
    graph.view = { ...graph.view, zoom: 1, panX: 50, panY: 40 };
    sessionStorage.setItem('reference-fixture', JSON.stringify(graph));
  });
  const reason = '即梦网页控件未能确认生成参数，本次未发起生成。';
  await page.addInitScript(({ reason }) => {
    let internals;
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, get: () => internals, set(value) {
      const invoke = value.invoke;
      internals = { ...value, invoke(command, args) {
        if (command === 'generation_history') return Promise.resolve({ session_id: null, turns: [], references: [] });
        if (command !== 'generation_diagnostics') return invoke(command, args);
        const { jobId } = args;
        const attempts = jobId === 'job-three' ? [
          { turnKey: 'turn-latest', error: reason },
          { turnKey: 'unrelated-turn', error: 'InputImageSensitiveContentDetected' },
        ] : jobId === 'empty-job' ? [{ turnKey: 'turn-no-image', error: 'InputTextSensitiveContentDetected' }] : [];
        return Promise.resolve({ schemaVersion: 1, jobId, task: null, attempts: attempts.map((a, i) => ({
          attemptId: 'attempt-' + i, jobId, status: 'failed', phase: 'execution', request: {}, createdAt: i, updatedAt: i, ...a,
        })) });
      } };
    } });
  }, { reason });
  await page.reload();
  const card = page.locator('[data-canvas-node-id="first"]');
  const failure = card.getByRole('button', { name: /失败.*详情/ });
  const inspector = page.locator('[data-project-inspector]');
  await card.locator('[data-conversation-image="b"]').waitFor();
  assert.match(await card.getAttribute('class'), /is-image-only/, 'a failed latest turn retains the last successful image surface');
  assert.equal(await card.locator('.canvas-prompt-content').count(), 0);
  await card.hover();
  await card.getByRole('button', { name: '上一张生成图片' }).click();
  await card.locator('[data-conversation-image="a"]').click();
  const preview = page.getByRole('dialog', { name: /^(媒体预览|图片与生成记录预览)/ });
  await preview.waitFor();
  assert.equal(await inspector.count(), 0, 'the successful image opens its own preview');
  await page.keyboard.press('Escape');
  await preview.waitFor({ state: 'detached' });
  await failure.focus();
  await page.keyboard.press('Enter');
  await inspector.getByText(reason, { exact: true }).waitFor();
  assert.equal(await inspector.getByText(/参考图未通过内容审核/).count(), 0);
  await inspector.getByTitle('关闭详情（进行中的任务不会中断）').click();
  const noImage = page.locator('[data-canvas-node-id="no-image"]');
  const agent = page.locator('[data-canvas-node-id="failed-agent"]');
  await agent.getByRole('button', { name: '关闭本次错误提示' }).click();
  assert.doesNotMatch(await agent.getAttribute('class'), /is-failed/);
  assert.doesNotMatch(await noImage.getAttribute('class'), /is-image-only/);
  await noImage.locator('.canvas-prompt-content').click();
  await inspector.getByText('提示词未通过内容审核，请调整文字后重试。', { exact: true }).waitFor();
  await inspector.getByTitle('关闭详情（进行中的任务不会中断）').click();
  await card.getByRole('button', { name: '关闭本次错误提示' }).click();
  assert.equal(await failure.count(), 0);
  assert.doesNotMatch(await card.getAttribute('class'), /is-failed/);
  assert.match(await noImage.getAttribute('class'), /is-failed/, 'dismissal is scoped to the exact failure');
  await noImage.getByRole('button', { name: '关闭本次错误提示' }).focus();
  await page.keyboard.press('Enter');
  assert.doesNotMatch(await noImage.getAttribute('class'), /is-failed/);
  assert.equal(await inspector.count(), 0);
  await page.reload();
  await card.locator('[data-conversation-image="b"]').waitFor();
  assert.equal(await failure.count(), 0, 'acknowledged failure stays dismissed after reload');
  assert.equal(await agent.getByRole('button', { name: '关闭本次错误提示' }).count(), 0);
  const details = card.getByRole('button', { name: '查看会话详情', exact: true });
  await card.hover();
  await details.click();
  await inspector.getByText(reason, { exact: true }).waitFor();
  await inspector.getByTitle('关闭详情（进行中的任务不会中断）').click();
  await page.evaluate(() => {
    const job = { id: 'job-three', sessionId: null, projectId: 'p', threadId: 't', running: false,
      streaming: '', createdAt: 3, provider: 'dreamina-web55', media: 'image', lastPrompt: '提示词 latest',
      lastRefs: [], refAssets: [], lastRatio: null, turns: [{ id: 3, turnKey: 'turn-latest',
        prompt: '提示词 latest', error: '生成失败', images: [], refs: [], refAssets: [] }] };
    window.store.setState({ genJobs: { [job.id]: job }, genJobOrder: [job.id] });
  });
  await card.hover();
  await details.click();
  await inspector.getByText(reason, { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.store.getState().activeJobId), 'job-three', 'live jobs retain their normal actions');
  await inspector.getByTitle('关闭详情（进行中的任务不会中断）').click();
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const latest = window.snapshot().nodes.find(node => node.id === 'latest');
    await api.projectCanvasNodeCreate({ ...latest, id: 'another-failure', payloadJson: JSON.stringify({
      ...JSON.parse(latest.payloadJson), turn_key: 'new-attempt' }) });
    window.emitChange();
  });
  await failure.waitFor();
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const nodes = window.snapshot().nodes, latest = nodes.find(node => node.id === 'latest');
    const payload = JSON.parse(latest.payloadJson);
    const id = 'recovered';
    await api.projectCanvasNodeCreate({ ...latest, id, payloadJson: JSON.stringify({
      ...payload, job_id: 'recovery-job', turn_key: id, status: 'done' }) });
    const output = nodes.find(node => node.id === 'output-a');
    await api.projectCanvasNodeCreate({ ...output, id: 'output-c', assetId: 'c', payloadJson: JSON.stringify({
      ...JSON.parse(output.payloadJson), execution: { job_id: 'recovery-job', turn_key: id } }) });
    window.emitChange();
  });
  await card.locator('[data-conversation-image="c"]').waitFor();
  assert.equal(await failure.count(), 0, 'a later successful attempt clears the failure affordance');
  assert.match(await card.getAttribute('class'), /is-image-only/);
  assert.deepEqual(errors, []);
  console.log('PASS prior gallery images, exact failed-turn diagnostics, empty first failure, reopen and subsequent success');
} finally {
  await browser.close();
  await server.close();
}
