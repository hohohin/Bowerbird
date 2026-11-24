import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
const { chromium } = await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE || '../../html-renderer/node_modules/playwright/index.mjs');

// Real desktop components with the closed synthetic IPC fixture. No Tauri app or provider.
const countWorkspaceRenders = {
  name: 'count-workspace-renders',
  enforce: 'pre',
  transform(source, id) {
    if (!id.endsWith('/components/CanvasWorkspace.tsx')) return;
    const start = '  const assets = useStore((state) => state.assets);';
    assert.ok(source.includes(start));
    return source.replace(start, '(window as any).workspaceRenders = ((window as any).workspaceRenders || 0) + 1;\n' + start);
  },
};
const server = await createServer({ plugins: [countWorkspaceRenders], cacheDir: '.tmp/local-chat-test/vite', server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const panel = page.locator('[data-project-inspector="chat"]');
const card = page.locator('.workflow-card.is-agent');
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
  await page.waitForTimeout(180);
  const renders = await page.evaluate(async () => {
    const { useLocalChatStore } = await import('/src/lib/localChatStore.ts');
    const state = useLocalChatStore.getState();
    const before = window.workspaceRenders;
    for (let revision = 1; revision <= 20; revision++) {
      state.applyConversation({ id: 'background', projectId: 'q', threadId: 't', nodeId: 'n',
        title: 'background', provider: 'codex-local', status: 'running', turnCount: 1, revision,
        createdAt: 1, updatedAt: revision, error: null, preview: '', messages: [] });
      await new Promise(requestAnimationFrame);
    }
    return [before, window.workspaceRenders];
  });
  assert.ok(renders[0] > 0);
  assert.equal(renders[1], renders[0], 'background conversation updates do not render the current canvas');
  await mode('图片').click(); await editor.fill('图片模式的独立草稿');
  await mode('视频').click(); await editor.fill('视频模式的独立草稿');
  await mode('对话').click(); await editor.fill('给荷月礼盒三个视觉方向');
  await mode('图片').click(); assert.equal(await editor.innerText(), '图片模式的独立草稿');
  await mode('视频').click(); assert.equal(await editor.innerText(), '视频模式的独立草稿');
  await mode('对话').click(); assert.equal(await editor.innerText(), '给荷月礼盒三个视觉方向');
  await editor.click(); await editor.press(process.platform === 'darwin' ? 'Control+e' : 'Control+End');
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
  await editor.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
  await panel.waitFor(); await card.waitFor();
  assert.equal(await card.count(), 1);
  const agentTitle = card.locator(':scope > header').getByRole('button', { name: '查看 Agent 详情', exact: true });
  assert.equal(await agentTitle.innerText(), 'Agent', 'the card title is Agent and remains accessible as a details action');
  assert.equal(await card.locator(':scope > header .canvas-tactical-module-code').count(), 0);
  assert.equal(await panel.locator('[data-message-role="user"] .local-chat-text').first().textContent(), openingText, 'opening message preserves both newlines');
  const id = await panel.getAttribute('data-local-chat-id');
  await close();
  const question = card.getByRole('group', { name: 'Agent有一个问题', exact: true });
  const turnId = await page.evaluate(async conversationId => {
    const mock = await import('/scripts/fixtures/local-chat/mock.ts');
    const chat = mock.inspect().conversations[conversationId];
    if (chat.provider !== 'codex-local') throw new Error('expected Codex CLI');
    const turnId = chat.messages[0].turnId;
    mock.setQuestions(conversationId, [{
      turnId, callId: 'codex-native-question', questions: [{
        id: 'audience', question: '这张海报面向谁？',
        options: [{ label: '亲子家庭' }, { label: '年轻影迷' }], multiSelect: false,
      }],
    }]);
    return turnId;
  }, id);
  const answer = question.getByRole('textbox', { name: /文字答案/ });
  await answer.fill('待提交的草稿');
  const questionLayout = await question.evaluate(bubble => {
    const card = bubble.closest('.workflow-card');
    const rect = item => item.getBoundingClientRect().toJSON();
    const stage = card.closest('.canvas-stage');
    const frame = bubble.querySelector('.workflow-agent-question-answer');
    const textarea = frame.querySelector('textarea');
    const heading = bubble.querySelector('.workflow-agent-question-heading > span');
    const controls = [...card.querySelectorAll(':scope > header > :is(button,[role=button]), :scope > .workflow-card-body footer button, .workflow-agent-composer :is(button,textarea)')];
    const status = card.querySelector('.workflow-agent-question-status');
    const statusContent = document.createRange();
    statusContent.selectNodeContents(status);
    const swatch = document.createElement('span');
    swatch.style.cssText = 'display:none;background-color:var(--cs-card);color:var(--bb-warning)';
    card.append(swatch);
    const neutralSurface = getComputedStyle(swatch).backgroundColor;
    const warningColor = getComputedStyle(swatch).color;
    swatch.remove();
    const panelStyle = getComputedStyle(bubble);
    const tail = getComputedStyle(bubble.parentElement, '::before').backgroundColor;
    return {
      bubble: rect(bubble), card: rect(card), board: rect(stage),
      dock: rect(stage.parentElement.querySelector('.canvas-composer-host')),
      zoom: card.getBoundingClientRect().width / card.offsetWidth,
      controls: controls.map(rect), options: [...bubble.querySelectorAll('.workflow-agent-question-option')].map(rect),
      frame: rect(frame), frameBorder: parseFloat(getComputedStyle(frame).borderInlineStartWidth),
      send: rect(frame.querySelector('button')), input: rect(textarea),
      placeholder: textarea.placeholder, resize: getComputedStyle(textarea).resize,
      status: rect(status), statusContent: statusContent.getBoundingClientRect().toJSON(),
      surface: panelStyle.backgroundColor, radius: panelStyle.borderRadius, neutralSurface, tail,
      markerColor: getComputedStyle(heading, '::before').backgroundColor, warningColor,
    };
  });
  const { bubble, card: cardBox, board, dock, zoom, controls, options, frame, frameBorder, send, input,
    placeholder, resize, status, statusContent, surface, radius, neutralSurface, tail, markerColor, warningColor } = questionLayout;
  const tolerance = 1.5;
  const right = bubble.left + bubble.width / 2 > cardBox.left + cardBox.width / 2;
  const edgeOverlap = right ? cardBox.right - bubble.left : bubble.right - cardBox.left;
  assert.ok(edgeOverlap <= 32 * zoom + tolerance, 'the question floats beside the Agent card');
  assert.ok(right || board.right - cardBox.right < bubble.width + tolerance, 'left placement requires insufficient space on the right');
  assert.ok(bubble.bottom <= dock.top + tolerance, 'the canvas composer cannot cover the question');
  assert.equal(surface, neutralSurface, 'the question uses the neutral canvas reading surface');
  assert.equal(radius, '0px', 'the question panel has square corners');
  assert.equal(tail, surface, 'the pointer and question use the same surface');
  assert.equal(markerColor, warningColor, 'the pending marker uses the theme warning accent');
  assert.ok(controls.every(control => Math.min(bubble.right, control.right) - Math.max(bubble.left, control.left) <= tolerance
    || Math.min(bubble.bottom, control.bottom) - Math.max(bubble.top, control.top) <= tolerance),
  'the question does not obscure header, run, or composer controls');
  assert.equal(options.length, 2);
  assert.ok(options[0].bottom <= options[1].top + tolerance
    && Math.abs(options[0].left - options[1].left) <= tolerance
    && Math.abs(options[0].right - options[1].right) <= tolerance, 'the choices are arranged in separate aligned rows');
  assert.ok([frame, ...options].every(row => Math.abs(row.height / zoom - 32) <= 1), 'simple choices and answer box are 32 px high');
  assert.equal(resize, 'none');
  assert.equal(placeholder, '编辑你的回答');
  const encloses = (outer, inner) => inner.left >= outer.left - tolerance && inner.right <= outer.right + tolerance
    && inner.top >= outer.top - tolerance && inner.bottom <= outer.bottom + tolerance;
  assert.ok(frameBorder > 0 && encloses(frame, send) && encloses(frame, input), 'the text input and send button share one bordered field');
  assert.ok(encloses(status, statusContent), 'the pending label fits inside its button');
  const closeQuestion = question.getByRole('button', { name: '关闭问题气泡', exact: true });
  assert.equal(await closeQuestion.isEnabled(), true);
  const waitingBadge = card.getByRole('button', { name: '待你回答', exact: true });
  assert.equal(await waitingBadge.getAttribute('data-awaiting-answer'), 'true');

  const inspectWaitingBadge = () => waitingBadge.evaluate(button => {
    const sample = document.createElement('span');
    sample.style.cssText = 'display:none;color:var(--bb-warning);outline-color:var(--cs-selected-ink)';
    button.append(sample);
    const warning = getComputedStyle(sample).color;
    const selectedInk = getComputedStyle(sample).outlineColor;
    sample.remove();
    const badge = getComputedStyle(button);
    const marker = getComputedStyle(button, '::before');
    return {
      warning, color: badge.color, border: badge.borderTopColor, borderWidth: badge.borderTopWidth,
      radii: [badge.borderTopLeftRadius, badge.borderTopRightRadius, badge.borderBottomLeftRadius, badge.borderBottomRightRadius],
      markerColor: marker.backgroundColor, markerPosition: [marker.top, marker.left], markerSize: [marker.width, marker.height],
      animation: marker.animationName, repeats: marker.animationIterationCount, opacity: Number(marker.opacity),
      focusVisible: button.matches(':focus-visible'), outline: [badge.outlineWidth, badge.outlineStyle, badge.outlineColor], selectedInk,
    };
  });
  const waitForBadgeColors = () => waitingBadge.evaluate(button => Promise.all(button.getAnimations()
    .filter(animation => animation instanceof CSSTransition).map(animation => animation.finished)));
  const assertWaitingBadge = badge => {
    assert.equal(badge.color, badge.warning, 'the waiting label uses the shared gold warning color');
    assert.equal(badge.border, badge.warning, 'the waiting outline is gold');
    assert.equal(badge.borderWidth, '1px');
    assert.deepEqual(badge.radii, ['0px', '0px', '0px', '0px']);
    assert.equal(badge.markerColor, badge.warning);
    assert.deepEqual(badge.markerPosition, ['0px', '0px']);
    assert.deepEqual(badge.markerSize, ['3px', '3px'], 'the corner marker is square');
  };
  const animatedWaitingBadge = await inspectWaitingBadge();
  assertWaitingBadge(animatedWaitingBadge);
  assert.equal(animatedWaitingBadge.animation, 'workflow-agent-question-blink');
  assert.equal(animatedWaitingBadge.repeats, 'infinite');
  await page.waitForFunction(() => Number(getComputedStyle(
    document.querySelector('.workflow-agent-question-status[data-awaiting-answer="true"]'), '::before').opacity) < .5);
  await page.waitForFunction(() => Number(getComputedStyle(
    document.querySelector('.workflow-agent-question-status[data-awaiting-answer="true"]'), '::before').opacity) > .9);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reducedWaitingBadge = await inspectWaitingBadge();
  assertWaitingBadge(reducedWaitingBadge);
  assert.equal(reducedWaitingBadge.animation, 'none');
  assert.equal(reducedWaitingBadge.opacity, 1);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const inspectQuestionHeader = () => question.evaluate(bubble => {
    const card = bubble.closest('.workflow-card');
    const heading = bubble.querySelector('.workflow-agent-question-heading');
    const scanlines = getComputedStyle(heading, '::before');
    const warning = getComputedStyle(heading.querySelector('span'), '::before').backgroundColor;
    const closeStyle = button => {
      const style = getComputedStyle(button);
      const glyph = getComputedStyle(button.querySelector('svg'));
      const corner = getComputedStyle(button, '::before');
      return {
        sharedClass: button.classList.contains('canvas-tactical-card-close'),
        outline: style.clipPath, width: style.width, height: style.height,
        glyph: [glyph.width, glyph.height, glyph.strokeWidth],
        corner: [corner.width, corner.height, corner.backgroundColor],
      };
    };
    return {
      stripes: scanlines.backgroundImage, fade: scanlines.maskImage,
      opacity: Number(scanlines.opacity), warning,
      bubbleClose: closeStyle(heading.querySelector('button[aria-label="关闭问题气泡"]')),
      cardClose: closeStyle(card.querySelector(':scope > header button[aria-label="删除卡片"]')),
    };
  });
  const assertQuestionHeader = style => {
    assert.match(style.stripes, /^repeating-linear-gradient\(/);
    assert.ok(style.stripes.includes(style.warning), 'the scanlines use the gold pending marker color');
    assert.match(style.fade, /^linear-gradient\(to right,/);
    assert.match(style.fade, /transparent|rgba\(0, 0, 0, 0\)/, 'the right end fades to transparent');
    assert.ok(style.opacity > 0 && style.opacity < 1, 'the scanline accent leaves the title readable');
    assert.equal(style.bubbleClose.sharedClass, true);
    assert.match(style.bubbleClose.outline, /^polygon\(/);
    assert.deepEqual(style.bubbleClose, style.cardClose, 'the question close and card delete share the cut corner, glyph and corner marker');
  };
  assertQuestionHeader(await inspectQuestionHeader());
  await mkdir('.tmp/local-chat', { recursive: true });
  await page.screenshot({ path: '.tmp/local-chat/desktop-question.png' });
  // The isolated preview skips App.tsx, which loads the industrial palette for both themes.
  await page.evaluate(async () => {
    await import('/src/components/IndustrialTheme.css');
    document.documentElement.dataset.theme = 'light';
  });
  await waitForBadgeColors();
  const lightWaitingBadge = await inspectWaitingBadge();
  assertWaitingBadge(lightWaitingBadge);
  await fixture('深色');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assertQuestionHeader(await inspectQuestionHeader());
  await waitForBadgeColors();
  const darkWaitingBadge = await inspectWaitingBadge();
  assertWaitingBadge(darkWaitingBadge);
  const questionClip = await question.evaluate(bubble => {
    const card = bubble.closest('.workflow-card').getBoundingClientRect();
    const questionRect = bubble.getBoundingClientRect();
    const x = Math.max(0, Math.floor(Math.min(card.left, questionRect.left)) - 8);
    const y = Math.max(0, Math.floor(Math.min(card.top, questionRect.top)) - 8);
    const right = Math.min(innerWidth, Math.ceil(Math.max(card.right, questionRect.right)) + 8);
    const bottom = Math.min(innerHeight, Math.ceil(Math.max(card.bottom, questionRect.bottom)) + 8);
    return { x, y, width: right - x, height: bottom - y };
  });
  await page.screenshot({ path: '.tmp/local-chat/agent-card-question-title.png', clip: questionClip, animations: 'disabled' });
  await closeQuestion.press('Enter');
  await question.waitFor({ state: 'hidden' });
  const focusedWaitingBadge = await inspectWaitingBadge();
  assert.equal(focusedWaitingBadge.focusVisible, true);
  assert.deepEqual(focusedWaitingBadge.outline, ['1px', 'solid', focusedWaitingBadge.selectedInk]);
  console.log('Agent waiting badge', { light: lightWaitingBadge.warning, dark: darkWaitingBadge.warning, keyboardOutline: focusedWaitingBadge.outline });
  await waitingBadge.blur();
  await card.screenshot({ path: '.tmp/local-chat/agent-card-waiting.png', animations: 'disabled' });
  await waitingBadge.click();
  await question.waitFor();
  await fixture('浅色');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.locator('style[data-vite-dev-id$="/IndustrialTheme.css"]').evaluate(style => style.remove());
  await page.setViewportSize({ width: 1000, height: 780 });
  await page.waitForFunction(() => {
    const panel = document.querySelector('.workflow-agent-question-bubble');
    const stage = panel?.closest('.canvas-stage');
    if (!stage) return false;
    const rect = panel.getBoundingClientRect();
    const visible = stage.getBoundingClientRect();
    const dock = stage.parentElement.querySelector('.canvas-composer-host').getBoundingClientRect();
    return rect.left >= visible.left && rect.right <= visible.right && rect.top >= visible.top && rect.bottom <= dock.top;
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await closeQuestion.click();
  await question.waitFor({ state: 'hidden' });
  await card.getByRole('button', { name: '待你回答', exact: true }).click();
  assert.equal(await answer.inputValue(), '待提交的草稿');
  await question.getByRole('button', { name: '亲子家庭', exact: true }).dblclick({ delay: 10 });
  await question.waitFor({ state: 'hidden' });
  const questionResult = await page.evaluate(async () => (await import('/scripts/fixtures/local-chat/mock.ts')).inspect());
  assert.deepEqual(questionResult.calls.filter(call => call.command === 'local_chat_answer_question').map(call => call.args), [{
    conversationId: id, turnId, callId: 'codex-native-question', answers: [{ id: 'audience', selected: ['亲子家庭'] }],
  }]);
  assert.equal(questionResult.conversations[id].status, 'running');
  assert.equal(questionResult.conversations[id].messages.filter(message => message.role === 'user').length, 1);
  await fixture('追加回复片段');
  await card.getByText('花影入月', { exact: true }).waitFor();
  const action = card.locator('.workflow-agent-composer').getByRole('button');
  const stop = card.getByRole('button', { name: '停止回复', exact: true });
  await stop.waitFor();
  assert.equal(await action.count(), 1);
  assert.equal(await card.getByRole('button', { name: /^停止/ }).count(), 1, 'the card has only one stop control');
  assert.equal(await action.getAttribute('aria-label'), '停止回复');
  assert.equal(await card.getByRole('button', { name: '任务要求', exact: true }).count(), 0);
  assert.equal(await card.getByRole('button', { name: '发送续聊消息', exact: true }).count(), 0);
  const actionElement = await action.elementHandle();
  await stop.click();
  const sendAgain = card.getByRole('button', { name: '发送续聊消息', exact: true });
  await sendAgain.waitFor();
  assert.ok(await sendAgain.evaluate((button, activeButton) => button === activeButton, actionElement));
  await actionElement.dispose();
  assert.equal(await card.getByRole('button', { name: '停止回复', exact: true }).count(), 0);
  await card.getByRole('button', { name: '查看 Agent 详情', exact: true }).click();
  await panel.waitFor();
  await panel.getByText('花影入月', { exact: true }).waitFor();
  await panel.getByText('已停止 · 已收到的内容已保留', { exact: true }).waitFor();
  assert.equal(await panel.locator('[data-message-role="user"]').count(), 1);

  const reply = panel.getByRole('textbox', { name: '继续对话', exact: true });
  await reply.fill('把第一个方向整理为一段提示词');
  await reply.press(process.platform === 'darwin' ? 'Control+e' : 'End'); await reply.press('Enter'); await page.keyboard.insertText('使用中文');
  await reply.press('Shift+Enter'); await page.keyboard.insertText('保留参考图配色');
  const replyText = '把第一个方向整理为一段提示词\n使用中文\n保留参考图配色';
  assert.equal(await reply.inputValue(), replyText);
  assert.equal(await panel.locator('[data-message-role="user"]').count(), 1, 'reply newline keys do not send');
  await reply.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, ctrlKey: true, isComposing: true, bubbles: true, cancelable: true });
  assert.equal(await panel.locator('[data-message-role="user"]').count(), 1, 'IME confirmation cannot send a reply');
  await close();
  const inline = card.getByRole('textbox', { name: '续聊消息', exact: true });
  assert.equal(await inline.inputValue(), replyText, 'the inspector and card share the current draft');
  await inline.fill('一行');
  const oneLine = await inline.evaluate(el => el.offsetHeight);
  await inline.fill(Array.from({ length: 12 }, (_, index) => String(index)).join('\n'));
  const tall = await inline.evaluate(el => ({ height: el.offsetHeight, scroll: el.scrollHeight, client: el.clientHeight }));
  assert.ok(tall.height > oneLine && tall.height <= 168 && tall.scroll > tall.client, 'composer grows to eight lines and then scrolls');
  await inline.fill(replyText);
  await inline.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true });
  assert.equal(await card.locator('.workflow-agent-message.is-user').count(), 1);
  await inline.press('Enter');
  await card.locator('.workflow-agent-message.is-user').nth(1).getByText(replyText, { exact: true }).waitFor();
  await fixture('追加回复片段');
  await card.locator('[data-chat-status="running"]').waitFor();
  await fixture('完成回复');
  await card.locator('[data-chat-status="idle"]').waitFor();
  const records = card.locator('.workflow-agent-messages');
  const historyReading = card.locator('.workflow-agent-reading');
  assert.ok(await records.evaluate(el => el.scrollHeight > el.clientHeight), 'the fixture has enough messages to scroll');
  await records.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await card.locator('.workflow-agent-reading[data-scrolled="true"]').waitFor();
  const activeFade = await historyReading.evaluate(el => {
    const fade = getComputedStyle(el, '::after');
    return { height: fade.height, image: fade.backgroundImage, opacity: fade.opacity };
  });
  assert.equal(activeFade.height, '60px');
  assert.match(activeFade.image, /linear-gradient\(/);
  assert.equal(activeFade.opacity, '1');
  const lastAssistant = records.locator('.workflow-agent-message.is-assistant').last();
  assert.deepEqual(await lastAssistant.evaluate(el => {
    const style = getComputedStyle(el);
    return [style.backgroundColor, style.borderTopWidth, style.boxShadow];
  }), ['rgba(0, 0, 0, 0)', '0px', 'none'], 'assistant replies are unframed text');
  const replyActions = lastAssistant.getByRole('group', { name: '回复操作', exact: true });
  const copyReply = replyActions.getByRole('button', { name: '复制 Agent 回答', exact: true });
  const rerunReply = replyActions.getByRole('button', { name: '按当前输入重跑', exact: true });
  assert.equal(await lastAssistant.locator(':scope > .local-chat-text + .workflow-agent-reply-actions').count(), 1);
  assert.deepEqual(await replyActions.getByRole('button').evaluateAll(buttons =>
    buttons.map(button => [button.getAttribute('aria-label'), button.textContent.trim(), button.querySelectorAll('svg').length])),
  [['复制 Agent 回答', '', 1], ['按当前输入重跑', '', 1]], 'the reply toolbar has two icon-only actions');
  assert.equal(await rerunReply.isEnabled(), true);
  assert.equal(await card.locator('footer').getByRole('button', { name: '按当前输入重跑', exact: true }).count(), 0);
  const rawReply = await page.evaluate(id => window.localChatFixture.inspect().conversations[id].messages.at(-1).text, id);
  assert.match(rawReply, /^\*\*花影入月\*\*\n\n/);
  await copyReply.click();
  await page.waitForFunction(async text => (await navigator.clipboard.readText()) === text, rawReply);
  await page.screenshot({ path: '.tmp/local-chat/desktop-agent-conversation.png' });
  await records.evaluate(el => { el.scrollTop = 0; });
  await card.locator('.workflow-agent-reading[data-scrolled="true"]').waitFor({ state: 'detached' });
  assert.ok(await historyReading.evaluate(el => {
    const fade = getComputedStyle(el, '::after');
    return fade.content === 'none' || fade.display === 'none' || fade.backgroundImage === 'none' || fade.opacity === '0';
  }), 'the first message is fully visible when the history is scrolled to the top');
  const modelRow = card.locator('.workflow-agent-provider-row');
  const provider = modelRow.getByRole('button', { name: /选择对话模型$/ });
  const model = modelRow.getByRole('combobox', { name: 'Codex 模型', exact: true });
  const effort = modelRow.getByRole('combobox', { name: 'Codex 推理强度', exact: true });
  const positions = await Promise.all([provider, model, effort].map(control => control.boundingBox()));
  assert.ok(positions.every(rect => rect && rect.height > 0 && rect.width > 0), 'provider, model and effort are visible');
  const [providerRect, modelRect, effortRect] = positions;
  assert.ok(positions.every(rect => Math.abs(rect.y + rect.height / 2 - providerRect.y - providerRect.height / 2) <= 2)
    && providerRect.x + providerRect.width <= modelRect.x + 1
    && modelRect.x + modelRect.width <= effortRect.x + 1, 'provider, model and effort share one row');
  assert.equal(await model.locator('.tactical-select-icon svg').count(), 1);
  assert.equal(await effort.locator('.tactical-select-icon svg').count(), 1);
  assert.equal(await card.locator('.agent-card-icon').getAttribute('viewBox'), '0 0 1024 1024');
  assert.equal(await card.locator('.agent-card-icon path').getAttribute('fill'), '#1296db');
  const oldAnswer = card.getByRole('button', { name: /^展开 Agent 回答/ });
  assert.equal(await oldAnswer.count(), 1, 'older replies render only the excerpt');
  await oldAnswer.click();
  await card.getByRole('button', { name: '收起', exact: true }).click();
  assert.equal(await oldAnswer.count(), 1);
  assert.equal(await card.getByRole('button', { name: '查看运行历史', exact: true }).count(), 0, 'ordinary turns do not create separate runs');
  assert.equal(await card.locator('.workflow-text-result, .workflow-image-result').count(), 0);
  await card.getByRole('button', { name: '查看 Agent 详情', exact: true }).click(); await panel.waitFor();
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

  // Both surfaces edit the same next-turn model draft, including before a send.
  await close();
  await card.getByRole('combobox', { name: 'Codex 模型', exact: true }).click();
  await page.getByRole('option', { name: 'Codex 轻量测试', exact: true }).click();
  await card.getByRole('button', { name: '查看 Agent 详情', exact: true }).click(); await panel.waitFor();
  assert.match(await panel.getByRole('combobox', { name: 'Codex 模型', exact: true }).innerText(), /Codex 轻量测试/);
  await panel.getByRole('combobox', { name: 'Codex 模型', exact: true }).click();
  assert.equal(await page.getByRole('option', { name: '默认模型', exact: true }).count(), 0);
  await page.getByRole('option', { name: 'Codex 测试模型', exact: true }).click();
  assert.match(await card.getByRole('combobox', { name: 'Codex 模型', exact: true }).innerText(), /Codex 测试模型/);
  await panel.getByRole('combobox', { name: 'Codex 推理强度', exact: true }).click();
  assert.equal(await page.getByRole('option', { name: '默认推理', exact: true }).count(), 0);
  await page.keyboard.press('Escape');

  // History is reachable while composing the first message, without discarding that draft.
  await close(); await expandComposer();
  await editor.fill('尚未发送的创作框草稿'); await editor.press(process.platform === 'darwin' ? 'Control+e' : 'End'); await editor.press('Enter'); await page.keyboard.insertText('第二行仍要保留');
  const unsentParagraphs = ['尚未发送的创作框草稿', '第二行仍要保留'];
  await page.locator('.creation-dock').getByRole('button', { name: '打开对话记录', exact: true }).click();
  const composerHistory = page.locator('.canvas-chat-history');
  await composerHistory.getByRole('textbox', { name: '搜索对话历史', exact: true }).fill('给荷月礼盒');
  assert.equal(await composerHistory.locator('.local-chat-history-entry').count(), 1);
  assert.doesNotMatch(await composerHistory.textContent(), /花影入月/);
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
  await card.getByRole('button', { name: '查看 Agent 详情', exact: true }).click(); await panel.waitFor();

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
  await fixture('刷新界面'); await ready(); await card.getByRole('button', { name: '查看 Agent 详情', exact: true }).click(); await panel.waitFor();
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
  await card.getByRole('button', { name: '查看 Agent 详情', exact: true }).click(); await panel.waitFor();
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
  const originalCard = page.locator(`.workflow-card.is-agent:has([data-local-chat-id="${id}"])`);
  const originalNodeId = await originalCard.getAttribute('data-workflow-card');
  await originalCard.getByRole('button', { name: '删除卡片', exact: true }).click();
  await originalCard.waitFor({ state: 'detached' });
  await expandComposer();
  await page.locator('.creation-dock').getByRole('button', { name: '打开对话记录', exact: true }).click();
  const history = page.locator('.canvas-chat-history');
  await history.getByRole('textbox', { name: '搜索对话历史', exact: true }).fill('给荷月礼盒');
  assert.equal(await history.locator('.local-chat-history-entry').count(), 1, 'removing a card keeps its history');
  await history.locator('.local-chat-history-entry').click(); await panel.waitFor();
  assert.equal(await panel.getAttribute('data-local-chat-id'), id);
  await panel.getByRole('textbox', { name: '继续对话', exact: true }).fill('移出画布后从历史继续这段对话');
  await panel.getByRole('button', { name: '发送对话消息', exact: true }).click();
  await originalCard.waitFor();
  assert.equal(await originalCard.getAttribute('data-workflow-card'), originalNodeId, 'continuation restores the original stable canvas node');
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
  await page.locator(`.workflow-card.is-agent:has([data-local-chat-id="${id}"])`).getByRole('button', { name: '查看 Agent 详情', exact: true }).click(); await panel.waitFor();
  await mkdir('.tmp/local-chat', { recursive: true });
  await page.screenshot({ path: '.tmp/local-chat/desktop-light.png' });
  await fixture('深色'); await page.screenshot({ path: '.tmp/local-chat/desktop-dark.png' });
  await page.setViewportSize({ width: 900, height: 700 });
  const bounds = await panel.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 901 && bounds.y + bounds.height <= 701, JSON.stringify(bounds));
  await page.screenshot({ path: '.tmp/local-chat/desktop-narrow.png' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await fixture('创建按次数循环四卡');
  await page.waitForFunction(() => {
    const action = Object.values(window.localChatFixture.inspect().conversations).flatMap(chat => chat.actions ?? []).at(-1);
    return action?.cards.length === 4 && action.cards.every(card =>
      document.querySelector(`[data-workflow-card="${card.id}"], [data-canvas-node-id="${card.id}"]`));
  });
  assert.match((await card.allTextContents()).join(' '), /已创建内容、生成、循环和触发卡片/);
  assert.match((await card.locator('.workflow-agent-tool').allTextContents()).join(' '), /已创建.*文案/);
  await close();
  const currentCard = card.filter({ has: page.locator(`[data-local-chat-id="${id}"]`) });
  const cardId = await currentCard.getAttribute('data-workflow-card');
  const rerunCard = page.locator(`[data-workflow-card="${cardId}"]`);
  const taskPrompt = await page.evaluate(cardId => window.localChatFixture.inspect().projects.p.workflow.document.nodes.find(card => card.id === cardId).prompt, cardId);
  const previousReply = await page.evaluate(id => window.localChatFixture.inspect().conversations[id].messages
    .filter(message => message.role === 'assistant' && message.status === 'done').at(-2), id);
  assert.ok(previousReply?.text);
  const olderMessage = rerunCard.locator(`[data-message-id="${previousReply.id}"]`);
  await olderMessage.getByRole('button', { name: /^展开 Agent 回答/ }).click();
  const previousActions = olderMessage.getByRole('group', { name: '回复操作', exact: true });
  await page.evaluate(() => navigator.clipboard.writeText('before copying the older answer'));
  await previousActions.getByRole('button', { name: '复制 Agent 回答', exact: true }).click();
  await page.waitForFunction(async text => (await navigator.clipboard.readText()) === text, previousReply.text);
  assert.equal(await previousActions.getByRole('button', { name: '按当前输入重跑', exact: true }).count(), 0);
  assert.equal(await rerunCard.getByRole('button', { name: '按当前输入重跑', exact: true }).count(), 1);
  await olderMessage.getByRole('button', { name: '收起', exact: true }).click();
  let previousId = id;
  for (let iteration = 0; iteration < 2; iteration++) {
    await rerunCard.getByRole('group', { name: '回复操作', exact: true })
      .getByRole('button', { name: '按当前输入重跑', exact: true }).click();
    const running = rerunCard.locator('[data-local-chat-id][data-chat-status="running"]');
    await running.waitFor();
    const freshId = await running.getAttribute('data-local-chat-id');
    assert.notEqual(freshId, previousId);
    await fixture('完成回复');
    await rerunCard.locator('[data-chat-status="idle"]').waitFor();
    await rerunCard.getByRole('button', { name: '按当前输入重跑', exact: true }).waitFor();
    const current = await page.evaluate(id => window.localChatFixture.inspect().conversations[id], freshId);
    assert.equal(current.turnCount, 1);
    assert.ok(current.messages[0].text.startsWith(taskPrompt), 'independent rerun uses the task instruction');
    assert.ok(!current.messages[0].text.includes(replyText), 'continuation draft never replaces the task');
    previousId = freshId;
  }
  const runHistory = rerunCard.getByRole('button', { name: '查看运行历史', exact: true });
  await runHistory.click();
  assert.equal(await rerunCard.locator('.workflow-agent-history-list > button').count(), 2);
  await runHistory.click();
  await page.setViewportSize({ width: 1440, height: 1200 });
  await rerunCard.screenshot({ path: '.tmp/local-chat/agent-card-toolbar.png', animations: 'disabled' });
  assert.deepEqual(errors, []);
  console.log('PASS: independent and multiline drafts, Enter/Shift+Enter newlines, Ctrl+Enter sending, IME protection, composer history, stable/removable/restorable chat card, streaming/stop/close, revision ordering, failure recovery, refresh, project isolation and delayed draft cleanup, local access gates and layouts');
} catch (error) {
  await mkdir('.tmp/local-chat', { recursive: true });
  await page.screenshot({path:'.tmp/local-chat/unification-error.png'});
  console.log(await page.evaluate(() => ['.creation-dock','.canvas-workspace','.workflow-card','.composer-host-glass','.workflow-detail'].map(selector=>{const e=document.querySelector(selector),r=e?.getBoundingClientRect();return [selector,r&&{x:r.x,y:r.y,width:r.width,height:r.height},e&&{position:getComputedStyle(e).position,overflow:getComputedStyle(e).overflow}];})));
  throw error;
} finally { await browser.close(); await server.close(); }
