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

try {
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/local-chat/preview.html`);
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await composer.locator('.ProseMirror').waitFor();
  const expand = composer.getByRole('button', { name: '展开创作描述', exact: true });
  if (await expand.count()) await expand.click();
  await page.getByRole('group', { name: '创作方式' }).getByRole('button', { name: '对话', exact: true }).click();
  await openMenu();
  assert.equal(await menu.getByRole('button', { name: '本机 DSH', exact: true }).isDisabled(), true);
  await menu.getByRole('button', { name: 'DSH 设置', exact: true }).click();
  await settings.getByRole('textbox', { name: '服务地址', exact: true }).fill('http://127.0.0.1:3081');
  await settings.getByLabel('登录链接（可选）', { exact: true }).fill('http://127.0.0.1:3081/?token=fixture-secret');
  await settings.getByRole('button', { name: '连接', exact: true }).click();
  assert.equal(await settings.getByRole('button', { name: '取消', exact: true }).isDisabled(), true);
  await settings.waitFor({ state: 'detached' });
  await openMenu();
  await menu.getByRole('button', { name: '本机 DSH', exact: true }).click();
  assert.equal(await composer.locator('.chat-codex-options').count(), 0);
  await page.getByRole('checkbox', { name: 'Codex 已登录', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Cloud 已登录', exact: true }).uncheck();
  await composer.locator('.ProseMirror').fill('本机 DSH 独立于 Codex 登录');
  await composer.getByRole('button', { name: '发送', exact: true }).click();
  await panel.waitFor();
  assert.equal((await inspect()).conversations[await panel.getAttribute('data-local-chat-id')].provider, 'dsh-local');
  assert.equal(await panel.locator('[data-message-role="assistant"] .local-chat-message-label strong').textContent(), 'DSH');
  assert.equal(await panel.locator('.chat-codex-options').count(), 0);
  await panel.getByRole('button', { name: '停止回复', exact: true }).click();
  await panel.getByRole('button', { name: '取回回复', exact: true }).click();
  await panel.getByText('花影入月', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'DSH 设置', exact: true }).click();
  assert.equal(await settings.getByRole('textbox', { name: '服务地址', exact: true }).inputValue(), 'http://127.0.0.1:3081');
  assert.equal(await settings.getByLabel('登录链接（可选）', { exact: true }).inputValue(), '');
  await settings.getByRole('button', { name: '取消', exact: true }).click();

  await panel.getByRole('button', { name: '发起新对话', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Cloud 已登录', exact: true }).check();
  await page.getByRole('checkbox', { name: '本机权益', exact: true }).uncheck();
  await openMenu();
  await menu.getByRole('button', { name: 'DSH · Cloud', exact: true }).click();
  await composer.getByRole('combobox', {name: '云端技能'}).click();
  await page.getByRole('option', {name:'文本编辑',exact:true}).click();
  await composer.locator('.ProseMirror').fill('Cloud DSH 零价聊天');
  await composer.getByRole('button', { name: '发送', exact: true }).click();
  await panel.waitFor();
  assert.match(await panel.locator('.local-chat-provider').innerText(), /DSH · Cloud · 0 Bcoin/);
  await panel.getByRole('button', { name: '停止回复', exact: true }).click();
  await panel.getByRole('button', { name: '取回回复', exact: true }).click();
  await panel.getByText('花影入月', { exact: true }).waitFor();
  const snapshot = await inspect();
  assert.equal(snapshot.calls.some(c => c.command === 'local_chat_dsh_setup' && c.args.mode === 'managed'), false);
  assert.deepEqual(snapshot.calls.filter(c => c.command === 'local_chat_send').at(-1).args.input.dshSkill, {id:'text-editor'});
  assert.doesNotMatch(JSON.stringify(snapshot), /fixture-secret/);
  assert.equal(snapshot.calls.filter(call => call.command === 'local_chat_send').length, 2, 'recovery never sends another request');
  assert.equal(snapshot.calls.filter(call => call.command === 'local_chat_recover').length, 2);
  await panel.getByRole('combobox', {name: '云端技能'}).click();
  await page.getByRole('option', {name: 'H3 视频提示词', exact: true}).click();
  await panel.getByRole('combobox', {name: '视频素材'}).click();
  await page.getByRole('option', {name: '首尾帧', exact: true}).click();
  await panel.getByRole('combobox', {name: '画面比例'}).click();
  await page.getByRole('option', {name: '16:9', exact: true}).click();
  await panel.getByRole('spinbutton', {name: '视频时长'}).fill('8');
  const h3 = await page.evaluate(async id => (await import('/src/lib/localChatStore.ts')).localChatDraft(id).dshSkill, await panel.getAttribute('data-local-chat-id'));
  assert.deepEqual(h3, {id: 'h3-video-prompt', parameters: {mode: 'frames', firstFrameCount: 1, lastFrameCount: 1, ratio: '16:9', seconds: 8}});
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
  assert.deepEqual(errors, []);
  console.log('PASS: DSH setup, credential redaction, URL restore, independent local entitlement, zero-price managed access, role labels, original-request recovery');
} finally { await browser.close(); await server.close(); }
