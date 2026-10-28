import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
const { chromium } = await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE || '../../html-renderer/node_modules/playwright/index.mjs');

// Real desktop components with the closed synthetic IPC fixture. No Tauri app or provider.
const server = await createServer({ cacheDir: '.tmp/local-chat-test/vite', server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const panel = page.locator('[data-project-inspector="chat"]');
const card = page.locator('.canvas-chat-node');
const editor = page.locator('.creation-dock .ProseMirror');
const mode = name => page.getByRole('group', { name: '创作方式' }).getByRole('button', { name, exact: true });
const close = () => panel.getByRole('button', { name: '关闭对话详情', exact: true }).click();
async function ready() { await page.locator('.canvas-workspace[aria-busy="false"]').waitFor(); }
async function expandComposer() {
  await editor.waitFor();
  const expand = page.getByRole('button', { name: '展开创作描述', exact: true });
  if (await expand.count()) await expand.click();
}
async function fixture(command) { await page.getByRole('button', { name: command, exact: true }).click(); }

try {
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/local-chat/preview.html`);
  await ready(); await expandComposer();
  await mode('图片').click(); await editor.fill('图片模式的独立草稿');
  await mode('视频').click(); await editor.fill('视频模式的独立草稿');
  await mode('对话').click(); await editor.fill('给荷月礼盒三个视觉方向');
  await mode('图片').click(); assert.equal(await editor.innerText(), '图片模式的独立草稿');
  await mode('视频').click(); assert.equal(await editor.innerText(), '视频模式的独立草稿');
  await mode('对话').click(); assert.equal(await editor.innerText(), '给荷月礼盒三个视觉方向');
  await editor.click(); await editor.press('Control+End');
  // Native selectionchange follows the key event; let the editor observe the
  // restored draft's caret before the next key splits its paragraph.
  await page.waitForFunction(() => {
    const selection = window.getSelection();
    return selection?.isCollapsed && selection.anchorNode?.textContent === '给荷月礼盒三个视觉方向'
      && selection.anchorOffset === '给荷月礼盒三个视觉方向'.length;
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await editor.press('Enter'); await page.keyboard.insertText('保留粉灰色关系');
  await editor.press('Shift+Enter'); await page.keyboard.insertText('包装正面留白');
  const openingText = '给荷月礼盒三个视觉方向\n保留粉灰色关系\n包装正面留白';
  assert.deepEqual(await editor.locator('p').allTextContents(), openingText.split('\n'));
  assert.equal(await card.count(), 0, 'Enter and Shift+Enter only insert paragraphs');
  assert.equal(await panel.count(), 0, 'typing a new line never opens a conversation');
  await editor.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, ctrlKey: true, isComposing: true, bubbles: true, cancelable: true });
  assert.equal(await card.count(), 0, 'IME confirmation cannot send the opening message');
  await editor.press('Control+Enter');
  await panel.waitFor(); await card.waitFor();
  assert.equal(await card.count(), 1);
  assert.equal(await panel.locator('[data-message-role="user"] .local-chat-text').first().textContent(), openingText, 'opening message preserves both newlines');
  const id = await panel.getAttribute('data-local-chat-id');
  await fixture('追加回复片段');
  await panel.getByText('花影入月', { exact: true }).waitFor();
  await panel.getByRole('button', { name: '停止回复', exact: true }).click();
  await panel.getByText('已停止 · 已收到的内容已保留', { exact: true }).waitFor();
  assert.equal(await panel.locator('[data-message-role="user"]').count(), 1);

  const reply = panel.getByRole('textbox', { name: '继续对话', exact: true });
  await reply.fill('把第一个方向整理为一段提示词');
  await reply.press('End'); await reply.press('Enter'); await page.keyboard.insertText('使用中文');
  await reply.press('Shift+Enter'); await page.keyboard.insertText('保留参考图配色');
  const replyText = '把第一个方向整理为一段提示词\n使用中文\n保留参考图配色';
  assert.equal(await reply.inputValue(), replyText);
  assert.equal(await panel.locator('[data-message-role="user"]').count(), 1, 'reply newline keys do not send');
  await reply.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, ctrlKey: true, isComposing: true, bubbles: true, cancelable: true });
  assert.equal(await panel.locator('[data-message-role="user"]').count(), 1, 'IME confirmation cannot send a reply');
  await reply.press('Control+Enter');
  await panel.locator('[data-message-role="user"]').nth(1).waitFor();
  assert.equal(await panel.locator('[data-message-role="user"] .local-chat-text').last().textContent(), replyText, 'reply send preserves both newlines');
  await close();
  await fixture('追加回复片段');
  await card.locator('[data-chat-status="running"]').waitFor();
  await fixture('完成回复');
  await card.click(); await panel.waitFor();
  assert.equal(await panel.getAttribute('data-local-chat-id'), id);
  assert.equal(await card.count(), 1, 'continuations keep one canvas card');
  assert.equal(await panel.locator('[data-message-role="user"]').count(), 2);
  await panel.getByRole('button', { name: '查看对话历史', exact: true }).click();
  await panel.getByRole('textbox', { name: '搜索对话历史', exact: true }).fill('荷月');
  assert.equal(await panel.locator('.local-chat-history-entry').count(), 1);
  await panel.locator('.local-chat-history-entry').click();
  const beforeStale = await panel.locator('.local-chat-messages').innerText();
  await fixture('发送过期事件');
  assert.equal(await panel.locator('.local-chat-messages').innerText(), beforeStale, 'older event never rewinds visible history');

  // History is reachable while composing the first message, without discarding that draft.
  await close(); await expandComposer();
  await editor.fill('尚未发送的创作框草稿'); await editor.press('End'); await editor.press('Enter'); await page.keyboard.insertText('第二行仍要保留');
  const unsentParagraphs = ['尚未发送的创作框草稿', '第二行仍要保留'];
  await page.locator('.creation-dock').getByRole('button', { name: '打开对话记录', exact: true }).click();
  const composerHistory = page.locator('.canvas-chat-history');
  await composerHistory.getByRole('textbox', { name: '搜索对话历史', exact: true }).fill('给荷月礼盒');
  assert.equal(await composerHistory.locator('.local-chat-history-entry').count(), 1);
  await composerHistory.getByRole('button', { name: '关闭对话历史', exact: true }).click();
  assert.deepEqual(await editor.locator('p').allTextContents(), unsentParagraphs, 'closing history keeps the unsent multiline draft');
  await page.locator('.creation-dock').getByRole('button', { name: '打开对话记录', exact: true }).click();
  await composerHistory.getByRole('textbox', { name: '搜索对话历史', exact: true }).fill('给荷月礼盒');
  await composerHistory.locator('.local-chat-history-entry').click(); await panel.waitFor();
  assert.equal(await panel.getAttribute('data-local-chat-id'), id, 'composer history opens the selected earlier conversation');
  await close(); await expandComposer();
  assert.deepEqual(await editor.locator('p').allTextContents(), unsentParagraphs, 'returning from an earlier conversation preserves the new draft');
  await fixture('刷新界面'); await ready(); await expandComposer();
  assert.deepEqual(await editor.locator('p').allTextContents(), unsentParagraphs, 'reloading restores paragraph boundaries');
  await card.click(); await panel.waitFor();

  await page.getByRole('combobox', { name: '测试故障', exact: true }).selectOption('send');
  await panel.getByRole('textbox', { name: '继续对话', exact: true }).fill('发送失败时仍保留的草稿');
  await panel.getByRole('button', { name: '发送对话消息', exact: true }).click();
  await panel.locator('.local-chat-reply-area [role="alert"]').waitFor();
  assert.equal(await panel.getByRole('textbox', { name: '继续对话', exact: true }).inputValue(), '发送失败时仍保留的草稿');
  assert.doesNotMatch(await panel.innerText(), /private|auth\.json|token_missing/);
  assert.equal(await panel.locator('[data-message-role="user"]').count(), 2);
  await page.getByRole('combobox', { name: '测试故障', exact: true }).selectOption('none');
  await panel.getByRole('button', { name: '发送对话消息', exact: true }).click();
  await fixture('追加回复片段');
  await page.getByRole('combobox', { name: '测试故障', exact: true }).selectOption('stop');
  await panel.getByRole('button', { name: '停止回复', exact: true }).click();
  await panel.getByText('尚未确认停止，请稍后查看状态后重试。', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('button', { name: '停止回复', exact: true }).isEnabled(), true);
  await page.getByRole('combobox', { name: '测试故障', exact: true }).selectOption('none');
  await fixture('模拟本轮失败');
  await panel.getByText('本轮回复未完成，请检查连接后继续对话。', { exact: true }).waitFor();
  assert.doesNotMatch(await panel.innerText(), /private|auth\.json|token_missing/);
  await panel.getByRole('textbox', { name: '继续对话', exact: true }).fill('刷新后继续编辑的草稿');
  await fixture('刷新界面'); await ready(); await card.click(); await panel.waitFor();
  assert.equal(await panel.getByRole('textbox', { name: '继续对话', exact: true }).inputValue(), '刷新后继续编辑的草稿');
  assert.equal(await panel.locator('[data-message-role="user"]').count(), 3);

  await page.getByRole('combobox', { name: '测试项目', exact: true }).selectOption('q'); await ready();
  await panel.waitFor({ state: 'detached' });
  assert.equal(await card.count(), 0, 'project B never displays project A chat cards');
  await expandComposer(); await mode('对话').click(); await editor.fill('项目 B 的独立对话');
  await page.locator('.creation-dock').getByRole('button', { name: '发送', exact: true }).click();
  await panel.waitFor(); await fixture('模拟进程中断');
  await panel.getByText('上次回复已中断，已收到的内容已保留。可以发送消息继续对话。', { exact: true }).waitFor();
  await page.getByRole('combobox', { name: '测试项目', exact: true }).selectOption('p'); await ready();
  await card.click(); await panel.waitFor();
  assert.equal(await panel.getAttribute('data-local-chat-id'), id);
  assert.doesNotMatch(await panel.innerText(), /项目 B 的独立对话/);

  await page.getByRole('checkbox', { name: 'Codex 已登录', exact: true }).uncheck();
  assert.equal(await panel.getByRole('button', { name: '发送对话消息', exact: true }).isDisabled(), true);
  await page.getByRole('checkbox', { name: 'Codex 已登录', exact: true }).check();
  await page.getByRole('checkbox', { name: '本机权益', exact: true }).uncheck();
  assert.equal(await panel.getByRole('button', { name: '发送对话消息', exact: true }).isDisabled(), true);
  await page.getByRole('checkbox', { name: '本机权益', exact: true }).check();

  // Removing the canvas projection keeps history; continuing it restores the same node.
  await close();
  const originalCard = page.locator(`.canvas-chat-node[data-local-chat-id="${id}"]`);
  const originalNodeId = await originalCard.getAttribute('data-canvas-node-id');
  await originalCard.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除', exact: true }).click();
  await page.getByRole('menuitem', { name: '从画布移出', exact: true }).click();
  await originalCard.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '项目对话记录', exact: true }).click();
  const history = page.locator('.canvas-chat-history');
  await history.getByRole('textbox', { name: '搜索对话历史', exact: true }).fill('给荷月礼盒');
  assert.equal(await history.locator('.local-chat-history-entry').count(), 1, 'removing a card keeps its history');
  await history.locator('.local-chat-history-entry').click(); await panel.waitFor();
  assert.equal(await panel.getAttribute('data-local-chat-id'), id);
  await panel.getByRole('textbox', { name: '继续对话', exact: true }).fill('移出画布后从历史继续这段对话');
  await panel.getByRole('button', { name: '发送对话消息', exact: true }).click();
  await originalCard.waitFor();
  assert.equal(await originalCard.getAttribute('data-canvas-node-id'), originalNodeId, 'continuation restores the original stable canvas node');
  assert.equal(await card.count(), 1, 'continuation cannot create a duplicate chat card');
  await fixture('完成回复');

  // A native acceptance may return after the user has already begun work in another project.
  await panel.getByRole('button', { name: '发起新对话', exact: true }).click();
  await expandComposer();
  await page.getByRole('checkbox', { name: '延迟发送回执', exact: true }).check();
  await editor.fill('项目 A 延迟回执中的新对话');
  await page.locator('.creation-dock').getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('button', { name: '释放发送回执（1）', exact: true }).waitFor();
  await page.getByRole('combobox', { name: '测试项目', exact: true }).selectOption('q'); await ready(); await expandComposer();
  await mode('对话').click(); await editor.fill('项目 B 正在编辑，迟到回执不应清空');
  await fixture('释放发送回执（1）');
  assert.equal(await page.getByRole('combobox', { name: '测试项目', exact: true }).inputValue(), 'q');
  assert.equal(await editor.innerText(), '项目 B 正在编辑，迟到回执不应清空');
  assert.equal(await panel.count(), 0, 'late project A response cannot open its inspector in B');
  await page.getByRole('checkbox', { name: '延迟发送回执', exact: true }).uncheck();
  await fixture('完成回复');
  await page.getByRole('combobox', { name: '测试项目', exact: true }).selectOption('p'); await ready();
  await expandComposer(); await mode('对话').click();
  assert.equal((await editor.innerText()).trim(), '', 'a delayed accepted send clears its original project chat draft');
  await mode('图片').click(); assert.equal(await editor.innerText(), '图片模式的独立草稿');
  await mode('视频').click(); assert.equal(await editor.innerText(), '视频模式的独立草稿');
  await mode('对话').click(); assert.equal((await editor.innerText()).trim(), '');
  await page.locator(`.canvas-chat-node[data-local-chat-id="${id}"]`).click(); await panel.waitFor();
  await mkdir('.tmp/local-chat', { recursive: true });
  await page.screenshot({ path: '.tmp/local-chat/desktop-light.png' });
  await fixture('深色'); await page.screenshot({ path: '.tmp/local-chat/desktop-dark.png' });
  await page.setViewportSize({ width: 900, height: 700 });
  const bounds = await panel.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 901 && bounds.y + bounds.height <= 701, JSON.stringify(bounds));
  await page.screenshot({ path: '.tmp/local-chat/desktop-narrow.png' });
  assert.deepEqual(errors, []);
  console.log('PASS: independent and multiline drafts, Enter/Shift+Enter newlines, Ctrl+Enter sending, IME protection, composer history, stable/removable/restorable chat card, streaming/stop/close, revision ordering, failure recovery, refresh, project isolation and delayed draft cleanup, local access gates and layouts');
} finally { await browser.close(); await server.close(); }
