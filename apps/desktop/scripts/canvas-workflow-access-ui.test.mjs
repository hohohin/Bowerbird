import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
import { selectCanvasTool } from './fixtures/canvas-reference/place-card.mjs';

const server = await createServer({ configFile: false, resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
  cacheDir: '.tmp/canvas-workflow-access/vite', optimizeDeps: { entries: ['scripts/fixtures/canvas-reference/preview.html'] },
  server: { host: '127.0.0.1', port: 1741, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const denial = '运行工作流卡片需要 Pro。已有结果仍可查看和导出';
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:1741/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(denial => {
    window.store.setState({ cloudAuth: null, cloudEntitlement: null });
    window.accessCalls = [];
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'canvas_workflow_authorize') {
        window.accessCalls.push(command);
        const { cloudAuth, cloudEntitlement } = window.store.getState();
        if (!cloudAuth?.logged_in || cloudAuth.user_id !== cloudEntitlement?.user_id || cloudEntitlement.tier !== 'pro'
          || !['fresh', 'grace'].includes(cloudEntitlement.offline_state)) {
          throw denial;
        }
        return;
      }
      if (command === 'comfy_video_environment') return { phase: 'ready', mode: args.mode, endpoint: args.endpoint, message: '本机环境已就绪' };
      if (command === 'comfy_video') {
        window.accessCalls.push(command);
        return { status: 'failed', message: 'Error: {"diagnostic":"mock traceback"}' };
      }
      return invoke(command, args);
    };
  }, denial);
  await selectCanvasTool(page, '本地 H3 视频');
  await page.mouse.click(890, 180);
  const card = page.locator('.workflow-card.is-comfy-video');
  const prompt = card.locator('.comfy-video-prompt');
  await prompt.waitFor({ timeout: 10000 });
  const saved = value => page.waitForFunction(value => {
    const node = JSON.parse(sessionStorage.getItem('workflow-p') ?? '{}').document?.nodes.find(node => node.kind === 'comfy-video');
    return node?.prompt === value;
  }, value);
  await prompt.fill('已保存的原始镜头');
  await saved('已保存的原始镜头');
  const expired = await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const controller = canvasWorkflowController('p');
    await controller.flush();
    window.store.setState({ cloudAuth: { logged_in: true, user_id: 'tester', cloud_available: true },
      cloudEntitlement: { user_id: 'tester', tier: 'pro', offline_state: 'expired' } });
    window.accessCalls = [];
    const h3 = controller.document.nodes.find(node => node.kind === 'comfy-video');
    const editError = await controller.edit([{ ...h3, prompt: '过期后仍可保存的修改' }]).then(() => '', String);
    return { editError, prompt: controller.document.nodes[0].prompt, run: controller.document.run };
  });
  assert.deepEqual(expired, { editError: '', prompt: '过期后仍可保存的修改', run: null });
  await card.getByRole('button', { name: '运行', exact: true }).click();
  await page.getByRole('alert', { name: '工作流问题' }).locator('p').filter({ hasText: denial }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.accessCalls), ['canvas_workflow_authorize']);

  await page.evaluate(() => window.store.setState({ cloudAuth: { logged_in: true, user_id: 'tester', cloud_available: true },
    cloudEntitlement: { user_id: 'tester', tier: 'pro', offline_state: 'fresh', balances: { daily: 0, sub: 0, topup: 0 },
      policy: { can_use_cloud: true, can_use_byo: true }, generation_services: [] } }));
  await card.getByLabel('H3 模式', { exact: true }).click();
  await page.getByRole('option', { name: '文生视频', exact: true }).click();
  await prompt.fill('登录后继续编辑的镜头');
  await saved('登录后继续编辑的镜头');
  assert.ok(await page.evaluate(() => window.accessCalls.every(command => command === 'canvas_workflow_authorize')));
  await card.getByRole('button', { name: '运行', exact: true }).click();
  await page.waitForFunction(() => window.accessCalls.includes('comfy_video'));
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.run?.status === 'failed');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: async value => { window.copiedDispatch = value; } } });
  });
  await card.getByRole('button', { name: '生成历史' }).click();
  const history = page.getByRole('dialog', { name: '生成历史' });
  const dispatch = history.locator('.h3-dispatch-record');
  await dispatch.locator('summary').click();
  assert.match(await dispatch.innerText(), /失败原因/);
  assert.match(await dispatch.innerText(), /执行阶段|建议操作/);
  assert.doesNotMatch(await dispatch.innerText(), /[{}]|"diagnostic"|Error:|mock traceback/);
  assert.equal(await dispatch.locator('time').count(), 1);
  await dispatch.getByRole('button', { name: '复制调度记录' }).click();
  const copied = JSON.parse(await page.evaluate(() => window.copiedDispatch));
  assert.ok(copied.runId && copied.jobId);
  assert.match(copied.diagnostic.message, /mock traceback/);
  await page.keyboard.press('Escape');

  const queue = await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const controller = canvasWorkflowController('p');
    await controller.flush();
    const edit = change => controller.edit(controller.document.nodes.map(change));
    const invoke = window.__TAURI_INTERNALS__.invoke;
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    let enter;
    const entered = new Promise(resolve => { enter = resolve; });
    try {
      window.__TAURI_INTERNALS__.invoke = async (command, args) => {
        if (command === 'canvas_workflow_save' && enter) {
          enter(); enter = undefined;
          await waiting;
          throw new Error('模拟首次写入失败');
        }
        return invoke(command, args);
      };
      const first = edit(node => ({ ...node, prompt: '首次写入未成功的提示词' })).then(() => '', String);
      await entered;
      const second = edit(node => ({ ...node, y: 123 }));
      release();
      const firstError = await first;
      await second;
      await controller.flush();
      const node = JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node => node.kind === 'comfy-video');
      return { firstError, prompt: node.prompt, y: node.y, error: controller.error };
    } finally {
      release();
      window.__TAURI_INTERNALS__.invoke = invoke;
    }
  });
  assert.match(queue.firstError, /模拟首次写入失败/);
  assert.deepEqual([queue.prompt, queue.y, queue.error], ['首次写入未成功的提示词', 123, '']);

  for (const rejection of ['模拟运行检查点保存失败', '运行工作流卡片需要 Pro。已有结果仍可查看和导出', '']) {
    const outcome = await page.evaluate(async rejection => {
      const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
      const { newWorkflowNode, workflowRuns } = await import('/src/lib/canvasWorkflow.ts');
      const controller = canvasWorkflowController('p');
      const countBefore = workflowRuns(controller.document).length;
      const existingCalls = window.accessCalls.filter(command => command === 'comfy_video').length;
      const h3 = controller.document.nodes.find(node => node.kind === 'comfy-video');
      const note = { ...newWorkflowNode('text', 80, 140, ''), prompt: '运行检查点写入期间的新草稿' };
      const invoke = window.__TAURI_INTERNALS__.invoke;
      let release, acceptCheckpoint;
      const waiting = new Promise(resolve => { release = resolve; });
      const checkpoint = new Promise(resolve => { acceptCheckpoint = resolve; });
      window.__TAURI_INTERNALS__.invoke = async (command, args) => {
        if (command === 'canvas_workflow_save' && acceptCheckpoint && args.document.run?.status === 'running') {
          acceptCheckpoint(); acceptCheckpoint = undefined;
          await waiting;
          if (rejection) throw new Error(rejection);
        }
        return invoke(command, args);
      };
      try {
        const run = controller.start(h3.id, true).then(() => '', String);
        await checkpoint;
        const edit = controller.edit([...controller.document.nodes, note]);
        release();
        const [runError] = await Promise.all([run, edit]);
        await controller.flush();
        const saved = JSON.parse(sessionStorage.getItem('workflow-p')).document;
        return { runError, runs: workflowRuns(saved).length - countBefore, note: saved.nodes.find(node => node.id === note.id)?.prompt,
          submissions: window.accessCalls.filter(command => command === 'comfy_video').length - existingCalls };
      } finally {
        release();
        window.__TAURI_INTERNALS__.invoke = invoke;
      }
    }, rejection);
    assert.equal(outcome.note, '运行检查点写入期间的新草稿');
    assert.equal(outcome.runError, rejection ? `Error: ${rejection}` : '');
    assert.deepEqual([outcome.runs, outcome.submissions], rejection ? [0, 0] : [1, 1]);
  }
  assert.deepEqual(errors, []);
  console.log('Workflow editing and serialized save recovery: passed');
} finally {
  await browser.close();
  await server.close();
}
