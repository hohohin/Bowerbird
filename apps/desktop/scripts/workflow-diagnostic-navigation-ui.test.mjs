import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/workflow-diagnostic-navigation-vite',
  optimizeDeps: { entries: ['scripts/fixtures/home-navigation-live/preview.html'] },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
page.setDefaultTimeout(10000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
try {
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/home-navigation-live/preview.html?source-library&detail-route&canvas-library&strict`);
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const { enableOverlayScrollbars } = await import('/src/components/OverlayScrollbars.tsx');
    enableOverlayScrollbars();
    const controller = canvasWorkflowController('p');
    await controller.load();
    const node = { ...newWorkflowNode('comfy-video', 5000, 5000, ''), id: 'failed-h3' };
    await controller.edit([node]);
    const diagnostic = { id: 'diagnostic-h3', code: 'STEP_FAILED', phase: 'execution', nodeId: node.id,
      nodeLabel: '本地 H3 视频', message: 'Agent Run 执行失败',
      action: '定位卡片检查失败原因；若涉及生成服务，先确认原任务状态，避免重复提交。可复制诊断信息反馈。',
      runId: 'failed-run', step: 1, timestamp: '2026-11-06T17:54:37.409Z' };
    const run = { id: diagnostic.runId, status: 'failed', startId: node.id, order: [node.id],
      steps: { [node.id]: { status: 'failed', diagnostic, error: diagnostic.message } } };
    await controller.save({ ...controller.document, run, runs: [run] });
    controller.showIssue(diagnostic);
  });
  const panel = page.getByRole('alert', { name: '工作流问题', exact: true });
  await panel.waitFor();
  const box = await panel.boundingBox();
  assert.ok(Math.abs(box.x + box.width - 1416) < 1 && Math.abs(box.y + box.height - 876) < 1, 'diagnostic stays anchored to the viewport, outside canvas zoom');
  await panel.getByRole('button', { name: '复制诊断信息', exact: true }).click();
  assert.equal(JSON.parse(await page.evaluate(() => navigator.clipboard.readText())).nodeId, 'failed-h3');
  await panel.getByRole('button', { name: '定位出错卡片', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-workflow-card="failed-h3"]')?.classList.contains('is-selected'));
  await panel.getByRole('button', { name: '关闭工作流问题', exact: true }).click();
  await panel.waitFor({ state: 'detached' });
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    canvasWorkflowController('p').showIssue(JSON.parse(await navigator.clipboard.readText()));
  });
  await panel.waitFor();
  await page.evaluate(() => window.store.setState({ detailAssetId: 'existing', mode: 'browse' }));
  await page.waitForFunction(() => document.querySelector('.canvas-workspace')?.closest('[inert]'));
  assert.equal(await panel.isVisible(), false, 'a suspended project must not leave an actionable-looking diagnostic over the next page');
  await page.evaluate(() => window.store.setState({ detailAssetId: null }));
  await panel.waitFor();
  await panel.getByRole('button', { name: '复制诊断信息', exact: true }).click();
  assert.equal(JSON.parse(await page.evaluate(() => navigator.clipboard.readText())).runId, 'failed-run');
  await panel.getByRole('button', { name: '关闭工作流问题', exact: true }).focus();
  await page.keyboard.press('Enter');
  await panel.waitFor({ state: 'detached' });
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    canvasWorkflowController('p').showIssue(JSON.parse(await navigator.clipboard.readText()));
  });
  await panel.waitFor();
  await page.getByRole('button', { name: '返回主页', exact: true }).click();
  await page.locator('.canvas-workspace').waitFor({ state: 'detached' });
  assert.equal(await panel.count(), 0, 'leaving a project removes its diagnostic portal');
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    canvasWorkflowController('p').showIssue(JSON.parse(await navigator.clipboard.readText()));
  });
  assert.equal(await panel.count(), 0, 'a late background failure does not recreate the project diagnostic on home');
  await page.evaluate(() => window.store.getState().enterProject('home-project-1'));
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  assert.equal(await panel.count(), 0, 'another project does not display the old diagnostic');
  await page.evaluate(() => window.store.getState().enterProject('p'));
  await panel.waitFor();
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.setViewportSize({ width: 900, height: 700 });
  await panel.getByRole('button', { name: '定位出错卡片', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-workflow-card="failed-h3"]')?.classList.contains('is-selected'));
  await panel.getByRole('button', { name: '关闭工作流问题', exact: true }).click();
  await panel.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    return canvasWorkflowController('p').document.run.steps['failed-h3'].diagnostic.runId;
  }), 'failed-run', 'closing the panel retains the failed task and its original diagnostic');
  assert.deepEqual(errors, []);
  console.log('workflow diagnostic: copy, locate, pointer/keyboard dismiss, suspended page, project exit, late failure, project isolation and retained history passed');
} finally {
  console.log('page errors:', errors);
  await browser.close();
  await server.close();
}
