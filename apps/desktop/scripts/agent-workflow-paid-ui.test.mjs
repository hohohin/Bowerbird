import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/agent-workflow-paid/vite',
  server: { host: '127.0.0.1', port: 18375, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(server.resolvedUrls.local[0] + 'scripts/fixtures/local-chat/preview.html?toolbar-pro');
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await page.evaluate(async () => {
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const controller = canvasWorkflowController('p');
    const bridge = window.__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    const observations = { quotes: [], threads: [], saves: [], sends: [], rebinds: [] };
    window.paidFixture = { controller, observations };
    bridge.invoke = async (command, args) => {
      if (command === 'local_chat_quote') return { service: 'chat_deepseek', paid_available: true, dsh_vps_v2_available: true };
      if (command === 'local_chat_quote_paid') {
        observations.quotes.push(args.model);
        return { available: true, account_id: 'local-chat-toolbar-fixture', model: args.model, pricing_version: 3,
          max_credits: args.model === 'deepseek-v4-pro' ? 312 : 71, max_output_tokens: 16384,
          rates_nano: { cache_hit: 1280, cache_miss: 64000, output: 256000 } };
      }
      if (command === 'project_thread_create') observations.threads.push(args);
      if (command === 'canvas_workflow_save') observations.saves.push(args.document?.run?.id ?? null);
      if (command === 'local_chat_new_on_card') observations.rebinds.push(args);
      if (command === 'local_chat_send') observations.sends.push(args);
      return invoke(command, args);
    };
    const agent = { ...newWorkflowNode('agent', 180, 130, 'codex'), id: 'paid-agent', prompt: '写一段文字', chatProvider: 'dsh-cloud' };
    await controller.edit([...controller.document.nodes, agent]);
    observations.saves.length = 0;
    window.paidFixture.execution = controller.start(agent.id, true);
  });
  const dialog = page.getByRole('dialog', { name: '确认工作流云端对话费用' });
  await dialog.waitFor({ timeout: 3500 });
  assert.match(await dialog.innerText(), /1 张 Agent 卡片/);
  assert.match(await dialog.innerText(), /71 Bcoin/);
  assert.deepEqual(await page.evaluate(() => {
    const { observations } = window.paidFixture;
    return [observations.quotes, observations.threads.length, observations.rebinds.length, observations.sends.length];
  }), [['deepseek-flash'], 0, 0, 0]);
  await dialog.getByRole('button', { name: '取消', exact: true }).and(page.locator(':focus')).waitFor();
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.paidFixture.execution);
  assert.deepEqual(await page.evaluate(() => {
    const { controller, observations } = window.paidFixture;
    return [controller.document.run, observations.saves.length, observations.threads.length, observations.sends.length];
  }), [null, 0, 0, 0]);
  const card = page.locator('[data-workflow-card="paid-agent"]');
  await card.getByRole('button', { name: '运行此卡片', exact: true }).click();
  await dialog.getByRole('button', { name: '授权并运行', exact: true }).click();
  await page.waitForFunction(() => window.paidFixture.observations.sends.length === 1);
  const authorization = await page.evaluate(() => window.paidFixture.observations.sends[0].paidAuthorization);
  assert.deepEqual(authorization, { account_id: 'local-chat-toolbar-fixture', model: 'deepseek-flash', pricing_version: 3,
    max_credits: 71, max_output_tokens: 16384 });
  await page.evaluate(async () => { (await import('/scripts/fixtures/local-chat/mock.ts')).finish(); });
  await page.waitForFunction(() => window.paidFixture.controller.document.run?.status === 'done');
  const rerun = card.getByRole('button', { name: '按当前输入重跑', exact: true });
  await rerun.click();
  await dialog.waitFor();
  assert.equal(await page.evaluate(() => window.paidFixture.observations.rebinds.length), 0);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await rerun.waitFor();
  assert.deepEqual(await page.evaluate(() => {
    const { observations } = window.paidFixture;
    return [observations.rebinds.length, observations.threads.length, observations.sends.length];
  }), [0, 1, 1]);
  console.log('PASS: Cloud Agent payment confirmation precedes writes, forwards authorization and preserves the existing conversation on rerun cancellation');
} finally { await browser.close(); await server.close(); }
