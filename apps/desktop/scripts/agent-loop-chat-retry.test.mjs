import assert from 'node:assert/strict';
import { createServer } from 'vite';
const { chromium } = await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE || '../../html-renderer/node_modules/playwright/index.mjs');

const server = await createServer({ cacheDir: '.tmp/agent-loop-chat-retry/vite', server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const scenario of ['failed', 'created-cards', 'unknown', 'different-turn', 'created-cards-ui']) {
    const page = await browser.newPage({viewport: {width: 1500, height: 1050}});
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/local-chat/preview.html`);
    await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
    let result = await page.evaluate(async scenario => {
      const { CanvasWorkflowController, canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
      const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
      const { localChat } = await import('/src/lib/localChat.ts');
      const { setupChatDsh } = await import('/src/lib/chatCapabilities.ts');
      await setupChatDsh({ mode: 'local', url: 'http://127.0.0.1:3080' });
      const { api } = await import('/src/lib/api.ts');
      const { useStore } = await import('/src/store.ts');
      const projectId = 'p', requests = [], turns = new Map();
      const confirmedFailure = '本机 DSH 本轮失败：卡片工具参数不是合法 JSON';
      const conversation = { id: 'same-conversation', nodeId: 'agent', projectId, threadId: 'chat-thread', title: '合成循环', provider: 'dsh-local',
        revision: 1, turnCount: 0, status: 'idle', preview: '', messages: [], actions: [], error: null, createdAt: 1, updatedAt: 1 };
      localChat.list = async () => scenario === 'failed' && !turns.size ? [] : [structuredClone(conversation)];
      localChat.get = async id => id === conversation.id ? structuredClone(conversation) : null;
      localChat.getByRequest = async key => turns.has(key) ? { ...structuredClone(conversation), submittedTurnId: turns.get(key) } : null;
      localChat.send = async input => {
        const snapshot = await api.canvasWorkflowGet(projectId);
        if (snapshot.document.run.steps.agent.chatInput.requestId !== input.requestId) throw Error('request key was not persisted before submission');
        if (turns.has(input.requestId)) throw Error('the same request was submitted twice');
        requests.push(structuredClone(input));
        const turn = `turn-${requests.length}`, failed = requests.length === 2;
        turns.set(input.requestId, turn);
        conversation.status = failed ? (scenario === 'unknown' ? 'interrupted' : 'failed') : 'idle';
        conversation.error = failed ? (scenario === 'unknown' ? '连接中断，请先核对原请求' : confirmedFailure) : null;
        conversation.revision++;
        conversation.turnCount++;
        for (const role of ['user', 'assistant']) conversation.messages.push({ id: turn + role, turnId: turn, role,
          status: role === 'assistant' && failed ? conversation.status : 'done', text: role === 'user' ? input.text : failed ? '' : '完成 ' + snapshot.document.run.loop.index,
          referenceAssetIds: [], createdAt: requests.length, updatedAt: requests.length });
        if (failed && scenario === 'different-turn') {
          // getByRequest returns the requested turn ID along with the latest public conversation.
          conversation.messages.at(-1).status = 'interrupted';
          conversation.messages.push({...conversation.messages.at(-1), turnId: 'other-turn', id: 'other-reply', status: 'failed'});
        }
        if (failed && scenario.startsWith('created-cards')) conversation.actions.push({
          id: 'action-two', turnId: turn, conversationId: conversation.id, callId: 'call-two', status: 'created',
          cards: [{id: 'created-note', alias: 'one', kind: 'content', title: '第二项产生的文案卡'}],
        });
        if (failed && scenario === 'created-cards-ui') {
          const action = conversation.actions.at(-1);
          conversation.actions.push(
            {...action, id: 'action-one', turnId: 'turn-1', cards: [{...action.cards[0], title: '之前轮次卡片'}]},
            {...action, id: 'action-undone', status: 'undone', cards: [{...action.cards[0], title: '本轮已撤销卡片'}]},
          );
        }
        return { ...structuredClone(conversation), submittedTurnId: turn };
      };

      const rows = labels => ({ schema_version: 1, note_type: 'text', member_ids: [], text: '',
        cells: labels.map((text, index) => [{ id: 'row-' + index, text, bold: false, italic: false, align: 'left' }]) });
      await api.projectCanvasNodeCreate({ projectId, threadId: null, id: 'table', kind: 'note', role: null, assetId: null,
        x: 0, y: 0, width: 250, height: 200, zIndex: 1, positionLocked: false,
        payloadJson: JSON.stringify(rows(['第一项产品', '第二项产品', '第三项产品'])) });
      const loop = { ...newWorkflowNode('loop', 0, 0, 'codex'), id: 'loop', loopMode: 'rows', inputs: { text: [{canvasNodeId: 'table', cellId: '*text'}] } };
      const agent = { ...newWorkflowNode('agent', 400, 0, 'codex'), id: 'agent', prompt: '为当前产品写文案', chatProvider: 'dsh-local', chatConversationId: scenario === 'failed' ? undefined : conversation.id,
        inputs: {text: [{nodeId: 'loop', portId: 'text'}, {nodeId: 'loop', portId: 'iteration'}]} };
      const first = new CanvasWorkflowController(projectId);
      await first.load(); await first.edit([loop, agent]); await first.start('loop');
      const paused = structuredClone(first.document.run);
      const uncertain = scenario === 'unknown' || scenario === 'different-turn';
      if (paused.status !== 'waiting' || paused.loop.index !== 1 || paused.loop.completed.length !== 1 || paused.steps.agent.status !== (uncertain ? 'waiting' : 'failed')) {
        throw Error('expected item two to pause with the original request: ' + JSON.stringify(paused.steps));
      }
      const key = paused.steps.agent.chatInput.requestId;
      await api.projectCanvasNoteUpdate('table', JSON.stringify(rows(['已编辑的内容'])));
      useStore.setState({ activeGenProvider: 'cloud' });
      if (uncertain) {
        // Old desktop versions could mark the step failed based on a later conversation error.
        // Exercise recovery of that persisted shape without fabricating turn-specific proof.
        const snapshot = await api.canvasWorkflowGet(projectId);
        for (const run of [snapshot.document.run, ...snapshot.document.runs]) run.steps.agent.status = 'failed';
        await api.canvasWorkflowSave(projectId, snapshot.revision, snapshot.document);
      }
      if (scenario === 'created-cards-ui') {
        const mounted = canvasWorkflowController(projectId);
        await mounted.refreshExternalCards();
        window.loopRetryResult = () => ({ paused, run: mounted.document.run, requests, key });
        return;
      }
      const reopened = new CanvasWorkflowController(projectId);
      await reopened.load();
      const confirmation = await reopened.retryLoop(paused.id);
      const beforeConfirmation = { count: requests.length, key: reopened.document.run.steps.agent.chatInput?.requestId };
      if (scenario === 'created-cards' && confirmation) {
        await Promise.all([reopened.retryLoop(paused.id, confirmation.requestIds), reopened.retryLoop(paused.id, confirmation.requestIds)]);
      }
      return { paused, run: reopened.document.run, requests, confirmation, beforeConfirmation, key };
    }, scenario);
    if (scenario === 'created-cards-ui') {
      const retry = page.locator('[data-workflow-card="loop"]').getByRole('button', {name: '重试失败步骤', exact: true});
      const dialog = page.getByRole('dialog', {name: '重做失败步骤？'});
      await page.evaluate(async () => {
        const { chatDshStatus } = await import('/src/lib/chatCapabilities.ts');
        window.testDshStatus = ready => chatDshStatus.replace("local", { localAvailable: ready, localReason: ready ? null : "请先连接本机 DSH。" });
        window.testDshStatus(false);
      });
      await page.waitForFunction(() => document.querySelector('[data-workflow-card="loop"] .loop-main-action')?.disabled);
      await page.evaluate(() => window.testDshStatus(true));
      await retry.click();
      const text = await dialog.innerText();
      assert.match(text, /第二项产生的文案卡/);
      assert.doesNotMatch(text, /之前轮次卡片|本轮已撤销卡片/);
      await dialog.getByRole('button', {name: '取消', exact: true}).click();
      await dialog.waitFor({state: 'detached'});
      const cancelled = await page.evaluate(() => window.loopRetryResult());
      assert.equal(cancelled.requests.length, 2);
      assert.equal(cancelled.run.steps.agent.chatInput.requestId, cancelled.key);
      await retry.click();
      await dialog.getByRole('button', {name: '保留卡片并重做', exact: true}).click();
      await page.waitForFunction(() => window.loopRetryResult().run.status === 'done');
      result = await page.evaluate(() => window.loopRetryResult());
    }
    const { requests, paused, run, confirmation, beforeConfirmation, key } = result;
    if (scenario === 'unknown' || scenario === 'different-turn') {
      assert.equal(requests.length, 2, scenario);
      assert.equal(run.steps.agent.chatInput.requestId, key, scenario);
      assert.equal(run.loop.index, 1);
    } else {
      if (scenario === 'created-cards') {
        assert.deepEqual(confirmation?.requestIds, [key]);
        assert.deepEqual(confirmation.cardNames, ['第二项产生的文案卡']);
        assert.deepEqual(beforeConfirmation, {count: 2, key});
      }
      assert.equal(run.status, 'done', JSON.stringify(run.steps));
      assert.deepEqual(run.loop.completed[0], paused.loop.completed[0]);
      assert.equal(run.loop.completed.length, 3);
      assert.equal(new Set(requests.map(r => r.requestId)).size, 4);
      assert.deepEqual(requests.map(r => r.text.match(/[一二三]项产品/)?.[0]), ['一项产品','二项产品','二项产品','三项产品']);
      const { requestId: oldKey, ...original } = requests[1], { requestId: newKey, ...retried } = requests[2];
      assert.notEqual(oldKey, newKey);
      assert.deepEqual(retried, original, 'only the request key may differ from the frozen input');
      if (scenario === 'failed') assert.equal(requests[0].conversationId, undefined);
      assert.ok(requests.slice(scenario === 'failed' ? 1 : 0).every(r => r.conversationId === 'same-conversation'));
    }
    console.log('PASS', scenario);
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
