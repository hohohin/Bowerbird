import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/agent-workflow-stop/vite',
  server: { host: '127.0.0.1', port: 18374, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const phase of ['authorize', 'thread', 'send']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    try {
      await page.goto(server.resolvedUrls.local[0] + 'scripts/fixtures/local-chat/preview.html');
      await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
      await page.evaluate(async phase => {
        const { api } = await import('/src/lib/api.ts');
        const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
        const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
        const c = canvasWorkflowController('p');
        await c.edit([...c.document.nodes, { ...newWorkflowNode('agent', 180, 130, 'codex'), id: 'stop-agent', prompt: '写一段文字' }]);
        window.stopFixture = { controller: c, cancels: [] };
        const fixture = window.stopFixture;
        const hold = result => new Promise(resolve => { fixture.release = () => resolve(result); });
        if (phase === 'authorize') api.canvasWorkflowAuthorize = () => hold(undefined);
        if (phase === 'thread') api.projectThreadCreate = () => hold(undefined);
        if (phase === 'send') {
          const nativeTimeout = window.setTimeout;
          window.setTimeout = (callback, delay, ...args) => nativeTimeout(callback, delay === 20000 ? 60 : delay, ...args);
          const bridge = window.__TAURI_INTERNALS__;
          const invoke = bridge.invoke;
          bridge.invoke = async (command, args) => {
            if (command === 'local_chat_send') {
              fixture.requestId = args.input.requestId;
              return hold({ id: 'late-chat', nodeId: 'stop-agent', projectId: 'p', threadId: 'late-thread', provider: 'codex-local',
                revision: 1, title: '迟到回执', status: 'running', turnCount: 1, submittedTurnId: 'late-turn', messages: [], actions: [] });
            }
            if (command === 'local_chat_stop') { fixture.cancels.push([args.conversationId, args.turnId]); return null; }
            return invoke(command, args);
          };
        }
      }, phase);
      const card = page.locator('[data-workflow-card="stop-agent"]');
      await card.getByRole('button', { name: '运行此卡片', exact: true }).click();
      await page.waitForFunction(() => !!window.stopFixture.release);
      if (phase !== 'send') {
        assert.equal(await card.getByText('准备运行', { exact: true }).count(), 1);
        assert.equal(await card.getByText('未运行', { exact: true }).count(), 0);
      }
      await card.getByRole('button', { name: '停止回复', exact: true }).click();
      await card.getByRole('button', { name: '运行此卡片', exact: true }).waitFor({ timeout: 3000 });
      assert.equal(await card.getAttribute('aria-busy'), 'false');
      await card.getByRole('button', { name: '删除卡片', exact: true }).click({ timeout: 3000 });
      await card.waitFor({ state: 'detached', timeout: 3000 });
      await page.evaluate(() => window.stopFixture.release());
      if (phase === 'send') {
        await page.waitForFunction(() => window.stopFixture.cancels.length > 0);
        assert.deepEqual(await page.evaluate(() => window.stopFixture.cancels), [['late-chat', 'late-turn']]);
        assert.equal(await page.evaluate(async () => !!(await import('/src/lib/localChatStore.ts')).useLocalChatStore.getState().summaries['late-chat']), false);
      }
      const document = await page.evaluate(async () => {
        const { controller } = window.stopFixture;
        await controller.flush();
        return controller.document;
      });
      assert.ok(!document.nodes.some(node => node.id === 'stop-agent'));
      assert.ok(!document.runs?.some(run => run.status === 'running' || run.status === 'waiting'));
    } finally { await page.close(); }
  }
  console.log('PASS: Agent stops during authorization, preparation and an in-flight send; the card can be removed and late turns are stopped');
} finally { await browser.close(); await server.close(); }
