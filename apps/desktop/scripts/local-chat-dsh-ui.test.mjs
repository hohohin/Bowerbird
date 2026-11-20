import assert from 'node:assert/strict';
import { createServer } from 'vite';
const { chromium } = await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE || '../../html-renderer/node_modules/playwright/index.mjs');

const server = await createServer({ cacheDir: '.tmp/local-chat-dsh-test/vite', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const composer = page.locator('.creation-dock');
const panel = page.locator('[data-project-inspector="chat"]');
const settings = page.getByRole('dialog', { name: 'DSH 设置', exact: true });
const menu = page.getByRole('dialog', { name: '对话模型', exact: true });
const openMenu = () => composer.getByRole('button', { name: /选择对话模型$/ }).click();
const inspect = () => page.evaluate(async () => (await import('/scripts/fixtures/local-chat/mock.ts')).inspect());
async function assertCompactDshControls(card) {
  const row = card.locator('.workflow-agent-provider-row');
  const provider = row.getByRole('button', { name: /选择对话模型$/ });
  const model = row.getByRole('combobox', { name: 'DSH 模型', exact: true });
  const effort = row.getByRole('combobox', { name: 'DSH 推理强度', exact: true });
  const positions = await Promise.all([provider, model, effort].map(control => control.boundingBox()));
  assert.ok(positions.every(rect => rect && rect.height > 0 && rect.width > 0));
  const [providerRect, modelRect, effortRect] = positions;
  assert.ok(positions.every(rect => Math.abs(rect.y + rect.height / 2 - providerRect.y - providerRect.height / 2) <= 2)
    && providerRect.x + providerRect.width <= modelRect.x + 1
    && modelRect.x + modelRect.width <= effortRect.x + 1, 'DSH provider, model and effort share one row');
  assert.equal(await model.locator('.tactical-select-icon svg').count(), 1);
  assert.equal(await effort.locator('.tactical-select-icon svg').count(), 1);
}

try {
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/local-chat/preview.html?settings`);
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await composer.locator('.ProseMirror').waitFor();
  const expand = composer.getByRole('button', { name: '展开创作描述', exact: true });
  if (await expand.count()) await expand.click();
  await page.getByRole('group', { name: '创作方式' }).getByRole('button', { name: '对话', exact: true }).click();
  const entitlement = page.getByRole('checkbox', {name: '本机权益', exact: true});
  await entitlement.uncheck();
  await openMenu();
  assert.equal(await menu.getByRole('button', { name: '本机 DSH', exact: true }).isDisabled(), true);
  await page.keyboard.press('Escape');
  await entitlement.check();
  const openSettings = async () => {
    await page.evaluate(async () => (await import('/src/components/creation/ProviderIssueNotice.tsx')).openProviderSettings('dsh'));
    await page.getByRole('region', {name:'DeepSeek 账号授权'}).getByRole('button', {name:'服务连接设置'}).click();
  };
  const closeModelSettings = () => page.getByRole('dialog', {name:'设置', exact:true}).getByRole('button', {name:'关闭', exact:true}).click();
  await openMenu();
  assert.equal(await menu.getByRole('button', {name:'DSH 设置', exact:true}).count(), 0);
  assert.equal(await menu.getByRole('button', {name:'本机 DSH', exact:true}).isDisabled(), true);
  await page.keyboard.press('Escape');
  await page.getByRole('combobox', { name: '测试故障' }).selectOption('dsh-setup');
  await openSettings();
  await settings.getByRole('button', {name:'一键连接本机 DSH', exact:true}).click();
  await settings.getByRole('alert').waitFor();
  assert.match(await settings.getByRole('alert').innerText(), /连接未完成/);
  await settings.getByRole('button', {name:'取消', exact:true}).click();
  await closeModelSettings();
  await page.getByRole('combobox', {name:'测试故障'}).selectOption('none');
  await openSettings();
  await settings.getByRole('button', {name: '手动配置服务地址', exact:true}).click();
  await settings.getByRole('textbox', { name: '服务地址', exact: true }).fill('http://127.0.0.1:3081');
  await settings.getByLabel('登录链接（可选）', { exact: true }).fill('http://127.0.0.1:3081/?token=fixture-secret');
  await settings.getByRole('button', { name: '连接', exact: true }).click();
  assert.equal(await settings.getByRole('button', { name: '取消', exact: true }).isDisabled(), true);
  await settings.waitFor({ state: 'detached' });
  await closeModelSettings();
  await openMenu();
  await menu.getByRole('button', { name: '本机 DSH', exact: true }).click();
  assert.equal(await composer.getByRole('combobox', {name: 'DSH 模型'}).count(), 1);
  await page.getByRole('checkbox', { name: 'Codex 已登录', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Cloud 已登录', exact: true }).uncheck();
  await composer.locator('.ProseMirror').fill('本机 DSH 独立于 Codex 登录');
  await composer.getByRole('button', { name: '发送', exact: true }).click();
  await panel.waitFor();
  assert.equal((await inspect()).conversations[await panel.getAttribute('data-local-chat-id')].provider, 'dsh-local');
  assert.equal(await panel.locator('[data-message-role="assistant"] .local-chat-message-label strong').textContent(), 'DSH');
  assert.equal(await panel.getByRole('combobox', {name: 'DSH 模型'}).count(), 1);
  const localId = await panel.getAttribute('data-local-chat-id');
  await panel.getByRole('button', { name: '关闭对话详情' }).click();
  const localCard = page.locator(`.workflow-card:has([data-local-chat-id="${localId}"])`);
  await assertCompactDshControls(localCard);
  const bubble = localCard.getByRole('group', {name: 'Agent有一个问题', exact: true});
  const input = bubble.getByRole('textbox', {name: /文字答案/});
  await page.evaluate(async id => {
    const fixture = await import('/scripts/fixtures/local-chat/mock.ts');
    const turnId = fixture.inspect().conversations[id].messages[0].turnId;
    fixture.setQuestions(id, [
      { turnId, callId: 'test-question-one', questions: [{ id: 'audience', question: '这张海报面向谁？',
        options: [{ label: '亲子家庭' }, { label: '年轻影迷' }], multiSelect: false }] },
      { turnId, callId: 'test-question-two', questions: [{ id: 'date', question: '活动在哪天？', options: [], multiSelect: false }] },
    ]);
  }, localId);
  await bubble.waitFor();
  await input.fill('接着写的答案');
  await bubble.getByRole('button', { name: '关闭问题气泡' }).click();
  await bubble.waitFor({ state: 'hidden' });
  assert.equal((await inspect()).calls.filter(call => call.command === 'local_chat_answer_question').length, 0);
  await localCard.getByRole('button', { name: '待你回答' }).click();
  assert.equal(await input.inputValue(), '接着写的答案');
  await bubble.getByRole('button', { name: '亲子家庭', exact: true }).dblclick({ delay: 10 });
  await bubble.getByText('活动在哪天？', { exact: true }).waitFor();
  await input.fill('周六');
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true });
  assert.equal((await inspect()).calls.filter(call => call.command === 'local_chat_answer_question').length, 1);
  await input.press('Enter');
  await bubble.waitFor({ state: 'hidden' });
  const answerCalls = (await inspect()).calls.filter(call => call.command === 'local_chat_answer_question');
  assert.deepEqual(answerCalls.map(call => [call.args.callId, call.args.answers]), [
    ['test-question-one', [{ id: 'audience', selected: ['亲子家庭'] }]],
    ['test-question-two', [{ id: 'date', selected: [], custom: '周六' }]],
  ]);
  assert.equal((await inspect()).conversations[localId].status, 'running', 'answer acceptance alone does not finish the turn');
  const cardComposer = localCard.locator('.workflow-agent-composer');
  assert.equal(await cardComposer.getByRole('button').count(), 1);
  await cardComposer.getByRole('button', { name: '停止回复', exact: true }).click();
  await cardComposer.getByRole('button', { name: '发送续聊消息', exact: true }).waitFor();
  await localCard.getByRole('button', { name: '查看 Agent 详情' }).click();
  await panel.waitFor();
  await panel.getByRole('button', { name: '取回回复', exact: true }).click();
  await panel.getByText('花影入月', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('button', {name:'DSH 设置', exact:true}).count(), 0);
  await openSettings();
  await settings.getByRole('button', {name: '手动配置服务地址', exact:true}).click();
  assert.equal(await settings.getByRole('textbox', { name: '服务地址', exact: true }).inputValue(), 'http://127.0.0.1:3081');
  assert.equal(await settings.getByLabel('登录链接（可选）', { exact: true }).inputValue(), '');
  await settings.getByRole('button', {name: '手动配置服务地址', exact:true}).click();
  await settings.getByRole('button', {name:'一键连接本机 DSH', exact:true}).click();
  await settings.waitFor({state:'detached'});
  await closeModelSettings();
  assert.deepEqual((await inspect()).calls.filter(c => c.command === 'local_chat_dsh_setup').map(c=>c.args.mode), ['auto', 'local', 'auto']);

  const terminalText = "本机 DSH 本轮失败：模型回复格式异常，请核对本轮已创建的卡片后重试。";
  await page.evaluate(async ({id, text}) => {
    const store = (await import('/src/lib/localChatStore.ts')).useLocalChatStore.getState();
    const chat = store.conversations[id];
    store.applyConversation({...chat, status: 'failed', revision: chat.revision + 1, error: text,
      messages: chat.messages.map(m => m.role === 'assistant' ? {...m, status: 'failed', dshTerminalError: text, dshFailureCode: 'MALFORMED_RESPONSE'} : m)});
  }, {id: await panel.getAttribute('data-local-chat-id'), text: terminalText});
  await panel.getByText(terminalText, {exact: true}).waitFor();
  assert.equal(await panel.getByRole('button', {name: '取回回复'}).count(), 0);
  assert.doesNotMatch(await panel.innerText(), /MALFORMED_RESPONSE/);

  await panel.getByRole('button', { name: '发起新对话', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Cloud 已登录', exact: true }).check();
  await page.getByRole('checkbox', { name: '本机权益', exact: true }).uncheck();
  await openMenu();
  await menu.getByRole('button', { name: 'DSH · Cloud', exact: true }).click();
  assert.equal(await composer.getByRole('combobox', {name: '云端技能'}).count(), 0);

  await composer.locator('.ProseMirror').fill('Cloud DSH 零价聊天');
  await composer.getByRole('combobox', {name: 'DSH 模型'}).click();
  await page.getByRole('option', {name: /Pro/i}).click();
  await composer.getByRole('combobox', {name: 'DSH 推理强度'}).click();
  await page.getByRole('option', {name: '高', exact:true}).click();
  await composer.getByRole('button', { name: '发送', exact: true }).click();
  await panel.waitFor();
  assert.match(await panel.locator('.local-chat-provider').innerText(), /DSH · Cloud · 0 Bcoin/);
  await panel.getByRole('button', { name: '停止回复', exact: true }).click();
  await panel.getByRole('button', { name: '取回回复', exact: true }).click();
  await panel.getByText('花影入月', { exact: true }).waitFor();
  const snapshot = await inspect();
  assert.deepEqual(snapshot.calls.filter(c => c.command === 'local_chat_send').at(-1).args.input.codexOptions,
    {model: 'deepseek-v4-pro', reasoningEffort: 'high'});
  assert.equal(snapshot.calls.some(c => c.command === 'local_chat_dsh_setup' && c.args.mode === 'managed'), false);
  assert.equal(snapshot.calls.filter(c => c.command === 'local_chat_send').at(-1).args.input.dshSkill, undefined);
  assert.doesNotMatch(JSON.stringify(snapshot), /fixture-secret/);
  assert.equal(snapshot.calls.filter(call => call.command === 'local_chat_send').length, 2, 'recovery never sends another request');
  assert.equal(snapshot.calls.filter(call => call.command === 'local_chat_recover').length, 2);
  assert.equal(await panel.getByRole('combobox', {name: '云端技能'}).count(), 0);
  await page.evaluate(async id => {
    const {useLocalChatStore} = await import('/src/lib/localChatStore.ts');
    useLocalChatStore.getState().setDraft(id, {text: '继续普通对话', referenceAssetIds: [], dshSkill: {id: 'text-editor'}});
  }, await panel.getAttribute('data-local-chat-id'));
  await panel.getByRole('button', { name: '发送对话消息' }).click();
  await panel.getByRole('button', {name:'停止回复'}).waitFor();
  assert.equal((await inspect()).calls.filter(c => c.command === 'local_chat_send').at(-1).args.input.dshSkill, undefined);
  await panel.getByRole('button', {name:'停止回复'}).click();
  await panel.getByRole('button', {name:'取回回复'}).click();
  const migration = panel.getByText('云端会话从这里开始。此前的对话保存在本机。', { exact: true });
  assert.equal(await migration.count(), 0);
  await page.evaluate(async id => {
    const store = (await import('/src/lib/localChatStore.ts')).useLocalChatStore.getState(), chat = store.conversations[id];
    const first = chat.messages.find(m => m.role === 'user');
    const legacy = {...first, id:'legacy-user',turnId:'legacy-turn',text:'升级前的本机消息'};
    store.applyConversation({...chat,revision:chat.revision+1,turnCount:2,messages:[legacy,...chat.messages],vpsHistoryStartTurnId:first.turnId});
  },await panel.getAttribute('data-local-chat-id'));
  await migration.waitFor();
  assert.equal(await migration.count(),1,'the cloud-history boundary appears only once');
  assert.equal(await migration.evaluate(el=>el.previousElementSibling?.getAttribute('data-message-id')), 'legacy-user');
  assert.equal(await migration.evaluate(el=>el.nextElementSibling?.getAttribute('data-message-role')), 'user');
  for (const [raw, expected] of [
    ['Cloud 本轮结果暂无法确认，未自动重发；请稍后查看原任务', '本轮云端任务已结束，没有可取回的回复。'],
    ['chat_no_reply: 上游模型服务返回 HTTP 503。本轮云端任务已结束，没有可取回的回复。', '上游模型服务返回 HTTP 503。本轮云端任务已结束，没有可取回的回复。'],
    ['chat_no_reply: 等待上游模型回复超时。本轮云端任务已结束，没有可取回的回复。', '等待上游模型回复超时。本轮云端任务已结束，没有可取回的回复。'],
  ]) {
    await page.evaluate(async ({id, raw}) => {
      const { useLocalChatStore } = await import('/src/lib/localChatStore.ts');
      const store = useLocalChatStore.getState(), chat = store.conversations[id];
      store.applyConversation({ ...chat, status: 'failed', revision: chat.revision + 1, error: raw });
    }, {id: await panel.getAttribute('data-local-chat-id'), raw});
    await panel.getByText(expected, { exact: true }).waitFor();
    assert.equal(await panel.getByRole('button', { name: '取回回复' }).count(), 0);
  }
  await page.evaluate(async () => {
    const {canvasWorkflowController} = await import('/src/lib/canvasWorkflowRuntime.ts');
    const {newWorkflowNode} = await import('/src/lib/canvasWorkflow.ts');
    const c = canvasWorkflowController('p');
    await c.edit([...c.document.nodes, {...newWorkflowNode('agent', 300, 120, 'codex'), id: 'legacy-dsh-agent', chatProvider: 'dsh-cloud', chatDshSkill: {id: 'text-editor'}}]);
  });
  const agent = page.locator('[data-workflow-card="legacy-dsh-agent"] .workflow-agent-chat-controls');
  await agent.waitFor();
  await assertCompactDshControls(agent);
  assert.equal(await agent.getByRole('combobox', {name:'云端技能'}).count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: DSH setup, credential redaction, URL restore, independent local entitlement, zero-price managed access, role labels, original-request recovery');
} finally { await browser.close(); await server.close(); }
