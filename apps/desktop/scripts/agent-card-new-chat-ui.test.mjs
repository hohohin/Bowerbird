import assert from 'node:assert/strict';
import { createServer } from 'vite';
const { chromium } = await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE || '../../html-renderer/node_modules/playwright/index.mjs');

const label = '在新建对话中运行指令，消除上下文影响';
const prompt = '只分析本轮的花朵参考';
const options = { model: 'fixture-codex', reasoningEffort: 'high' };
const server = await createServer({ cacheDir: '.tmp/agent-card-new-chat/vite', server: { host: '127.0.0.1', port: 17866, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/local-chat/preview.html`);
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  const initial = await page.evaluate(async options => {
    const { useLocalChatStore } = await import('/src/lib/localChatStore.ts');
    const chat = await useLocalChatStore.getState().send({ projectId: 'p', provider: 'codex-local', text: '只有上一段对话知道的文字', referenceAssetIds: [],
      codexOptions: options, placement: { x: 175, y: 150, width: 350, height: 220, zIndex: 4 } });
    // Record only the tested actions; the fixture's general diagnostic buffer rotates after 100 IPCs.
    window.cardActions = [];
    const bridge = window.__TAURI_INTERNALS__, invoke = bridge.invoke;
    bridge.invoke = async (command, args) => {
      if (command === 'local_chat_send' || command === 'local_chat_new_on_card') window.cardActions.push({ command, args: structuredClone(args) });
      if (command === 'local_chat_new_on_card' && window.holdRebind) await new Promise(resolve => { window.releaseRebind = resolve; });
      return invoke(command, args);
    };
    return { id: chat.id, nodeId: chat.nodeId };
  }, options);
  const card = page.locator(`[data-workflow-card="${initial.nodeId}"]`);
  const fresh = card.getByRole('button', { name: '新建对话', exact: true });
  const run = card.getByRole('button', { name: '运行此卡片', exact: true });
  const providerButton = card.getByRole('button', { name: /选择对话模型/ });
  const panel = page.locator('[data-project-inspector="chat"]');
  async function expectFreshNotice() {
    const notice = page.getByRole('status').filter({ hasText: '已开启新对话，点击「运行」发送' });
    await notice.waitFor();
    await notice.getByRole('button', { name: '关闭通知' }).click();
  }
  const state = () => page.evaluate(id => {
    const db = window.localChatFixture.inspect(), node = db.projects.p.workflow.document.nodes.find(n => n.id === id);
    return { chats: db.conversations, bound: node.chatConversationId, actions: window.cardActions };
  }, initial.nodeId);
  const sends = value => value.actions.filter(a => a.command === 'local_chat_send').map(a => a.args.input);
  const rebinds = value => value.actions.filter(a => a.command === 'local_chat_new_on_card').map(a => a.args);
  const sent = count => page.waitForFunction(count => window.cardActions.filter(a => a.command === 'local_chat_send').length >= count, count);
  const finish = async () => {
    await page.getByRole('button', { name: '完成回复', exact: true }).click();
    await run.and(card.locator('button:enabled')).waitFor();
  };
  async function chooseProvider(provider) {
    await providerButton.click();
    const menu = page.getByRole('dialog', { name: '对话模型', exact: true });
    assert.deepEqual((await menu.locator('[data-model-key]').evaluateAll(options => options.map(option => option.dataset.modelKey))).sort(),
      ['codex-local', 'dsh-cloud', 'dsh-local']);
    await menu.locator(`[data-model-key="${provider}"]`).click();
    await page.waitForFunction(({id, provider}) => {
      const db = window.localChatFixture.inspect(), node = db.projects.p.workflow.document.nodes.find(n => n.id === id);
      return node.chatProvider === provider && db.conversations[node.chatConversationId]?.provider === provider;
    }, {id: initial.nodeId, provider});
  }
  await fresh.waitFor();
  assert.equal(await fresh.getAttribute('title'), label);
  assert.equal(await fresh.locator('svg.lucide-message-circle-plus').count(), 1);
  assert.equal(await fresh.isDisabled(), true);
  assert.equal(await run.isDisabled(), true);
  assert.equal(await card.getByRole('button', { name: /^停止/ }).isEnabled(), true);
  assert.equal(await fresh.evaluate(button => {
    const row = button.closest('.workflow-agent-provider-row');
    const provider = row.querySelector('button');
    button.style.transition = 'none';
    const box = button.getBoundingClientRect(), menu = provider.getBoundingClientRect();
    const label = button.querySelector('span'), textWidth = label.getBoundingClientRect().width;
    button.style.transform = label.style.transform = 'none';
    const original = button.getBoundingClientRect(), originalText = label.getBoundingClientRect().width;
    button.style.removeProperty('transform'); label.style.removeProperty('transform'); button.style.removeProperty('transition');
    return Math.abs(box.width / original.width - .9) < .01 && Math.abs(box.height / original.height - .9) < .01
      && Math.abs(textWidth / originalText - .7) < .01 && button.textContent === '新建对话' && box.left >= menu.right && box.top < menu.bottom
      && Math.abs(box.right - row.getBoundingClientRect().right) < 2;
  }), true, 'the labeled action sits at the right edge of the provider row');
  if (!await providerButton.isDisabled()) {
    await providerButton.click();
    const busyMenu = page.getByRole('dialog', { name: '对话模型', exact: true });
    assert.equal(await busyMenu.locator('[data-model-key="dsh-cloud"]').isDisabled(), true);
    await busyMenu.press('Escape');
  }
  await finish();
  await page.evaluate(async ({ id, prompt }) => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const c = canvasWorkflowController('p');
    await c.refreshExternalCards();
    await c.edit(c.document.nodes.map(n => n.id === id ? { ...n, prompt, inputs: { image: [{ assetId: 'ref-lotus' }] } } : n));
  }, {id: initial.nodeId, prompt});
  await card.getByRole('textbox', { name: 'Agent 要求' }).getByText(prompt, {exact: true}).waitFor();

  await run.evaluate(button => { button.click(); button.click(); });
  await sent(1);
  let result = await state();
  assert.equal(sends(result).length, 1, 'repeated run during the same event loop submits only once');
  assert.equal(sends(result)[0].conversationId, initial.id);
  assert.equal(sends(result)[0].manualCardRun, true);
  assert.equal(rebinds(result).length, 0);
  assert.equal(await panel.count(), 0);
  assert.equal(await fresh.isDisabled(), true);
  await finish();

  await card.getByRole('button', { name: '查看 Agent 详情', exact: true }).click();
  assert.equal(await panel.getAttribute('data-local-chat-id'), initial.id);
  await panel.getByRole('textbox', { name: '继续对话', exact: true }).fill('详情面板的续聊');
  await panel.getByRole('button', { name: '发送对话消息', exact: true }).click();
  await sent(2);
  assert.equal(sends(await state())[1].conversationId, initial.id);
  await panel.getByRole('button', { name: '关闭对话详情', exact: true }).click();
  await finish();

  // Two DOM clicks in the same task, before React has rendered the disabled state.
  await page.evaluate(() => { window.holdRebind = true; });
  await fresh.evaluate(button => { button.click(); button.click(); });
  await page.waitForFunction(() => !!window.releaseRebind);
  assert.equal(rebinds(await state()).length, 1);
  assert.equal(sends(await state()).length, 2);
  assert.equal(await run.isDisabled(), true);
  await page.evaluate(() => { window.holdRebind = false; window.releaseRebind(); });
  await expectFreshNotice();
  result = await state();
  const next = result.bound;
  assert.notEqual(next, initial.id);
  assert.equal(result.chats[next].turnCount, 0);
  assert.equal(sends(result).length, 2);
  const editor = card.getByRole('textbox', { name: 'Agent 要求' });
  assert.equal(await editor.innerText(), prompt);
  const edited = prompt + '，只写一句';
  await editor.fill(edited);
  await run.click();
  await sent(3);
  result = await state();
  assert.deepEqual(sends(result).map(input => input.conversationId), [initial.id, initial.id, next]);
  const input = sends(result)[2];
  assert.equal(input.agentNodeId, initial.nodeId);
  assert.deepEqual(input.referenceAssetIds, ['ref-lotus']);
  assert.deepEqual(input.codexOptions, options);
  assert.ok(input.text.includes(edited));
  assert.doesNotMatch(input.text, /只有上一段对话知道的文字|详情面板的续聊/);
  assert.equal(result.chats[next].turnCount, 1);
  assert.equal(result.chats[initial.id].turnCount, 3);
  assert.equal(await panel.count(), 0);
  await fresh.evaluate(button => button.click());
  assert.equal(rebinds(await state()).length, 1, 'busy card cannot start another conversation');
  await finish();

  await chooseProvider('dsh-cloud');
  result = await state();
  const empty = result.bound;
  assert.notEqual(empty, next);
  assert.equal(result.chats[next].provider, 'codex-local');
  assert.equal(result.chats[next].turnCount, 1);
  assert.equal(result.chats[empty].turnCount, 0);
  assert.equal(result.chats[empty].nodeId, initial.nodeId);
  assert.equal(await card.getByRole('combobox', {name: 'Codex 模型'}).count(), 0);
  assert.equal(rebinds(result).at(-1).provider, 'dsh-cloud');
  await chooseProvider('codex-local');
  await chooseProvider('dsh-cloud');
  result = await state();
  assert.equal(result.bound, empty, 'switching an unused session does not archive another blank chat');
  assert.equal(Object.keys(result.chats).length, 3);
  assert.equal(rebinds(result).length, 4);
  await chooseProvider('dsh-cloud');
  result = await state();
  assert.equal(rebinds(result).length, 4, 'choosing the current provider is idempotent');
  assert.equal(sends(result).length, 3, 'switching provider does not send or start a generation');
  await fresh.click();
  await expectFreshNotice();
  assert.equal(sends(await state()).length, 3);
  await run.click();
  await sent(4);
  result = await state();
  assert.equal(result.bound, empty);
  assert.equal(sends(result)[3].conversationId, empty);
  assert.equal(sends(result)[3].provider, 'dsh-cloud');
  assert.equal(Object.keys(result.chats).length, 3, 'transactionally checking the empty session does not create another chat');
  await finish();

  // A card created by the canvas has no conversation until its first submission.
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const controller = canvasWorkflowController('p');
    await controller.edit([...controller.document.nodes, { ...newWorkflowNode('agent', 600, 50, 'codex'), id: 'unbound-agent', prompt: '' }]);
  });
  const unbound = page.locator('[data-workflow-card="unbound-agent"]');
  assert.equal(await unbound.getByRole('button', { name: '新建对话', exact: true }).isEnabled(), true);
  await unbound.getByRole('button', { name: '新建对话', exact: true }).evaluate(button => { button.click(); button.click(); });
  await expectFreshNotice();
  assert.equal(sends(await state()).length, 4);
  await unbound.getByRole('textbox', { name: 'Agent 要求' }).fill('第一次从卡片发言');
  await unbound.getByRole('button', { name: '运行此卡片', exact: true }).click();
  await sent(5);
  result = await state();
  const first = sends(result)[4];
  assert.equal(first.agentNodeId, 'unbound-agent'); assert.ok(!first.conversationId);
  assert.equal(Object.values(result.chats).filter(chat => chat.nodeId === 'unbound-agent').length, 1);
  assert.equal(Object.keys(result.chats).length, 4);
  assert.equal(sends(result).length, 5);
  assert.equal(await panel.count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: new chat preserves the draft and waits for Run on used, empty and unbound cards. Run submits the edited text once to the selected conversation.');
} finally {
  await browser.close();
  await server.close();
}
