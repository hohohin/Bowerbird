import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/agent-dsh-model-options/vite',
  server: { host: '127.0.0.1', port: 18373, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(server.resolvedUrls.local[0] + 'scripts/fixtures/local-chat/preview.html');
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await page.evaluate(async () => {
    const { setupChatDsh } = await import('/src/lib/chatCapabilities.ts');
    await setupChatDsh({ mode: 'auto' });
  });
  const panel = page.locator('[data-project-inspector="chat"]');
  const modelControl = scope => scope.getByRole('combobox', { name: 'DSH 模型', exact: true });
  const effortControl = scope => scope.getByRole('combobox', { name: 'DSH 推理强度', exact: true });
  const list = page.getByRole('listbox');
  const selected = () => list.getByRole('option', { selected: true }).innerText();

  for (const [provider, label, effort] of [['dsh-cloud', 'max', 'max'], ['dsh-local', 'none', 'off']]) {
    const id = await page.evaluate(async provider => {
      const { useLocalChatStore } = await import('/src/lib/localChatStore.ts');
      const { finish } = await import('/scripts/fixtures/local-chat/mock.ts');
      const chat = await useLocalChatStore.getState().send({ projectId: 'p', provider, text: '旧配置', referenceAssetIds: [],
        placement: { x: 300, y: provider === 'dsh-cloud' ? 160 : 520, width: 350, height: 220, zIndex: 4 } });
      finish(chat.id);
      return chat.nodeId;
    }, provider);
    const card = page.locator(`[data-workflow-card="${id}"]`);
    for (const scope of [card, panel]) {
      if (scope === panel) await card.getByRole('button', { name: '查看 Agent 详情' }).click();
      await modelControl(scope).click();
      assert.deepEqual(await list.getByRole('option').allTextContents(), ['DeepSeek V4.1 Flash', 'DeepSeek V4 Pro']);
      assert.equal(await selected(), 'DeepSeek V4.1 Flash');
      await page.keyboard.press('Escape');
      await effortControl(scope).click();
      assert.deepEqual(await list.getByRole('option').allTextContents(), ['none', 'low', 'high', 'max']);
      assert.equal(await selected(), 'high');
      await page.keyboard.press('Escape');
    }
    await effortControl(panel).click();
    await list.getByRole('option', { name: label, exact: true }).click();
    await panel.getByRole('textbox').fill('继续对话');
    await panel.getByRole('button', { name: '发送对话消息' }).click();
    await page.waitForFunction(async provider => {
      const { calls } = await import('/scripts/fixtures/local-chat/mock.ts');
      return calls.some(call => call.command === 'local_chat_send' && call.args.input.provider === provider && call.args.input.text === '继续对话');
    }, provider);
    const sent = await page.evaluate(async () => {
      const { calls } = await import('/scripts/fixtures/local-chat/mock.ts');
      return calls.filter(call => call.command === 'local_chat_send').at(-1).args.input.codexOptions;
    });
    assert.deepEqual(sent, { model: 'deepseek-flash', reasoningEffort: effort });
    await panel.getByRole('button', { name: '关闭对话详情' }).click();
  }
  console.log('PASS: legacy DSH cards and their details use explicit model choices and send max/off correctly');
} finally { await browser.close(); await server.close(); }
