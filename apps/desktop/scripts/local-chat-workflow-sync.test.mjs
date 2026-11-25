import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { createStore } from 'zustand/vanilla';

const lib = fileURLToPath(new URL('../src/lib/', import.meta.url));
const clone = value => structuredClone(value);
const plain = value => JSON.parse(JSON.stringify(value));
const node = (id, prompt = '') => ({ id, kind: 'generation', x: 0, y: 0, action: 'describe', skill: 'image-edit', prompt, ratio: null, provider: 'codex', inputs: {}, outputs: {}, outputPorts: [], trigger: false });
const doc = nodes => ({ schema_version: 1, nodes, run: null });
function fixture(initial = doc([node('original')]), options = {}) {
  let saved = { revision: 1, document: clone(initial) }, fail = false, failNext = false, gate, readGate, failRead = false;
  const interleavedChanges = [];
  const writes = [];
  const modules = new Map();
  const requests = new Map(), sends = [], stops = [];
  const genJobs = {}, generationRequests = [];
  const workflowHost = { getState: () => ({ genJobs,
    startGeneration: async (...args) => { generationRequests.push(args.at(-1)); return { accepted: true }; } }) };
  const chatListeners = new Set(), checkpoints = new Map();
  const reads = { checkpoints: 0, full: 0 };
  const chatApi = { revision: async id => { reads.checkpoints++; return checkpoints.get(id); }, getByRequest: async id => clone(requests.get(id) ?? null) };
  const chatStore = { summaries: {}, conversations: {}, drafts: {}, loadProject: async () => {},
    applyConversation(chat) {
      const previous = { conversations: chatStore.conversations };
      chatStore.conversations = { ...chatStore.conversations, [chat.id]: chat };
      for (const listener of chatListeners) listener(chatStore, previous);
    },
    loadConversation: async id => { reads.full++; return clone([...requests.values()].find(chat => chat.id === id) ?? null); },
    stop: async (id, turnId) => { stops.push([id, turnId]); },
    send: async input => {
      assert.equal(saved.document.run.steps[input.agentNodeId].chatInput.requestId, input.requestId, 'save the request before submitting');
      sends.push(clone(input));
      const chat = { id: input.conversationId ?? 'chat', revision: 1, projectId: input.projectId, nodeId: input.agentNodeId, provider: input.provider, submittedTurnId: 'turn', status: 'idle', error: null,
        messages: [{ turnId: 'turn', role: 'assistant', status: 'done', text: '原轮次输出', referenceAssetIds: [] }] };
      requests.set(input.requestId, clone(chat)); return chat;
    } };
  const api = {
    canvasWorkflowGet: async () => {
      const snapshot = clone(saved);
      if (readGate) { readGate.entered(); await readGate.promise; }
      if (failRead) throw new Error('synthetic read failed');
      return snapshot;
    }, projectCanvasGet: options.projectCanvasGet ?? (async () => ({ nodes: [] })), canvasWorkflowAuthorize: options.authorize ?? (async () => {}), projectThreadCreate: async () => {},
    getAssetsByIds: async ids => ids.map(id => ({ id, store_path: `${id}.png` })),
    canvasWorkflowSave: async (_id, revision, document) => {
      if (options.beforeSave) await options.beforeSave(document);
      if (gate) await gate;
      if (fail || failNext) { failNext = false; throw new Error('synthetic disk write failed'); }
      const change = interleavedChanges.shift();
      if (change) saved = { revision: saved.revision + 1, document: change(clone(saved.document)) };
      if (revision !== saved.revision) throw new Error('工作流已被其他窗口修改，请重新打开项目');
      saved = { revision: revision + 1, document: clone(document) }; writes.push(saved.document); return saved.revision;
    },
  };
  const context = vm.createContext({ console, crypto: webcrypto, structuredClone, TextEncoder, AbortController, Error, setTimeout: options.setTimeout ?? setTimeout,
    clearTimeout: options.clearTimeout ?? clearTimeout });
  function load(path) {
    if (modules.has(path)) return modules.get(path).exports;
    const module = { exports: {} }; modules.set(path, module);
    const output = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const require = specifier => {
      const nestedExecutor = dirname(path) === resolve(lib, 'executors');
      if (nestedExecutor && specifier.startsWith('../')) specifier = './' + specifier.slice(3);
      const base = nestedExecutor ? lib : dirname(path);
      if (specifier.startsWith('./executors/')) return load(resolve(lib, specifier + '.ts'));
      if (['./canvasWorkflowCardExecutors', './canvasWorkflowMediaInputs', './workflowEntitlement'].includes(specifier)) return load(resolve(lib, specifier + '.ts'));
      if (specifier === './api') return { api };
      if (specifier === './userError') return load(resolve(dirname(path), 'userError.ts'));
      if (specifier === './dshSkill.ts' || specifier === './chatProvider.ts') return load(resolve(dirname(path), specifier));
      if (specifier === './localChat') return { localChat: chatApi, localChatRunning: chat => chat && ['running', 'stopping'].includes(chat.status),
        agentChatOptions: (...args) => load(resolve(lib, 'localChat.ts')).agentChatOptions(...args),
        selectChatCodexModel: (...args) => load(resolve(lib, 'localChat.ts')).selectChatCodexModel(...args) };
      if (specifier === './localChatStore') return { ensureLocalChatEvents: async () => {},
        useLocalChatStore: { getState: () => chatStore, subscribe: listener => { chatListeners.add(listener); return () => chatListeners.delete(listener); } } };
      if (specifier === './workflowProviderIssue') return { workflowProviderIssue: options.providerIssue ?? (() => null), workflowGenerationProvider: node => node.provider };
      if (specifier === 'zustand') return { createStore };
      if (specifier === './chatCapabilities') return { chatProviderAccessIssue: () => null,
        selectedChatOptions: (...args) => load(resolve(lib, 'chatCapabilities.ts')).selectedChatOptions(...args) };
      if (specifier === '../store') return { useStore: workflowHost };
      if (specifier === './workflowHost') return { getWorkflowHost: () => workflowHost };
      if (specifier === '@tauri-apps/api/event') return { emit: async () => {} };
      if (specifier === './workflowPlannerRuntime') return { WorkflowPlannerRuntime: class {} };
      if (specifier === './workflowVideoFrames') return { resolveVideoCardOutputs: async () => {} };
      if (specifier === '@tauri-apps/api/core' && options.invoke) return { invoke: options.invoke };
      if (specifier === './workflowLoop') return load(resolve(lib, 'workflowLoop.ts'));
      if (specifier === './workflowAgentOutputs') return load(resolve(lib, 'workflowAgentOutputs.ts'));
      if (specifier === './canvasSessionOutputs') return { completedCanvasSessions: () => [], reconcileCanvasWorkflowReferences: nodes => nodes,
        canvasSessionCompletionLookup: (...args) => load(resolve(lib, 'canvasSessionOutputs.ts')).canvasSessionCompletionLookup(...args),
        canvasSessionCompleted: (...args) => load(resolve(lib, 'canvasSessionOutputs.ts')).canvasSessionCompleted(...args),
        canvasSessionCompletionStatus: (...args) => load(resolve(lib, 'canvasSessionOutputs.ts')).canvasSessionCompletionStatus(...args),
        submittedTurnState: (...args) => load(resolve(lib, 'canvasSessionOutputs.ts')).submittedTurnState(...args),
        workflowGenerationActivity: (...args) => load(resolve(lib, 'canvasSessionOutputs.ts')).workflowGenerationActivity(...args) };
      if (['./comfyVideo', './comfyVideo.ts', './genProviders', './genProviders.ts', './canvasNodePayload', './canvasNodePayload.ts', './projectNodeIds', './canvasConversationCards', './videoGeneration', './audioMedia.ts', './textMedia.ts'].includes(specifier)) {
        return load(resolve(lib, specifier.endsWith('.ts') ? specifier : `${specifier}.ts`));
      }
      if (['./workflowExternalChanges', './canvasWorkflow', './canvasCardNames', './workflowDiagnostics', './workflowTriggerSchedule', './workflowTriggerSchedule.ts', './workflowAgentChat', './workflowAgentResult', './workflowAgentProfile', './workflowTemplates', './workflowPlanner', './contentTable.ts', './workflowMigrations', './workflowTriggerScheduler', './workflowPersistenceQueue'].includes(specifier)) return load(resolve(base, specifier.endsWith('.ts') ? specifier : `${specifier}.ts`));
      return {};
    };
    vm.runInContext(`(function(require,module,exports){${output}\n})`, context, { filename: path })(require, module, module.exports);
    return module.exports;
  }
  const { CanvasWorkflowController } = load(resolve(lib, 'canvasWorkflowRuntime.ts'));
  const { mergeWorkflowChanges } = load(resolve(lib, 'workflowExternalChanges.ts'));
  return { controller: new CanvasWorkflowController('p'), mergeWorkflowChanges, saved: () => plain(saved), writes, requests, sends, stops, chatStore, chatApi, chatListeners, checkpoints, reads, load, genJobs, generationRequests,
    external: document => { saved = { revision: saved.revision + 1, document: clone(document) }; },
    fail: value => { fail = value; }, failNext: () => { failNext = true; }, failRead: value => { failRead = value; },
    interleave: (...changes) => { interleavedChanges.push(...changes); },
    holdRead: () => {
      let entered, release;
      const started = new Promise(resolve => { entered = resolve; }), promise = new Promise(resolve => { release = resolve; });
      readGate = { entered, promise };
      return { started, release: () => { readGate = undefined; release(); } };
    },
    hold: () => { let release; gate = new Promise(resolve => { release = resolve; }); return () => { gate = undefined; release(); }; } };
}

const deniedCanvasPro = async () => { throw new Error('运行工作流卡片需要 Pro。已有结果仍可查看和导出'); };

test('Canvas Pro denial of the first native checkpoint never publishes a new run', async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const agent = { ...node('agent', '原始指令'), kind: 'agent' };
  const f = fixture(doc([agent]), { beforeSave: async document => {
    if (!document.run) return;
    entered.resolve(); await release.promise; await deniedCanvasPro();
  } });
  const c = f.controller;
  await c.load();
  const started = c.start(agent.id, true);
  await entered.promise;
  assert.equal(c.document.run, null, 'initial checkpoint is not visible until the native save succeeds');
  release.resolve();
  await assert.rejects(started, /需要 Pro/);
  assert.equal(c.document.run, null);
  assert.equal(c.error, '');
  assert.equal(f.sends.length, 0);
});

test('Canvas Pro permits generation creation and edits on a mixed board', async () => {
  const agent = { ...node('agent', '旧指令'), kind: 'agent' };
  const f = fixture(doc([agent]), { authorize: deniedCanvasPro });
  await f.controller.load();
  const draw = node('draw', '一只红色小鸟');
  await f.controller.edit([...f.controller.document.nodes, draw]);
  await f.controller.edit(f.controller.document.nodes.map(card => card.id === draw.id ? { ...card, prompt: '一只蓝色小鸟' } : card));
  assert.equal(f.saved().document.nodes.find(card => card.id === draw.id).prompt, '一只蓝色小鸟');
  await f.controller.edit(f.controller.document.nodes.map(card => card.id === agent.id ? { ...card, prompt: '修改 Agent 指令' } : card));
  assert.equal(f.saved().document.nodes.find(card => card.id === agent.id).prompt, '修改 Agent 指令');
});

test('Canvas Pro allows an ordinary generation run that only reads a paid card’s cached output', async () => {
  const source = { ...node('cached', '旧指令'), kind: 'agent', outputs: { image: { type: 'image', assetIds: ['reference'] } } };
  const draw = { ...node('draw', '一只小鸟'), inputs: { image: [{ nodeId: source.id, portId: 'image' }] } };
  const f = fixture(doc([source, draw]), { authorize: deniedCanvasPro });
  await f.controller.load();
  await f.controller.start(draw.id);
  assert.deepEqual(f.saved().document.run.order, [draw.id]);
  assert.ok(f.saved().document.run.lockedNodeIds.includes(source.id));
  assert.equal(f.saved().document.run.status, 'done', f.saved().document.run.steps[draw.id].error);
  assert.equal(f.generationRequests.length, 1);
});

test('Canvas Pro leaves the generation provider rejection in control', async () => {
  const draw = node('draw', '一只小鸟');
  const f = fixture(doc([draw]), { authorize: deniedCanvasPro, providerIssue: () => ({ message: 'Bcoin 余额不足' }) });
  await f.controller.load();
  await assert.rejects(() => f.controller.start(draw.id, true), /Bcoin 余额不足/);
  assert.equal(f.saved().document.run, null);
  assert.equal(f.generationRequests.length, 0);
});

test('Canvas Pro keeps consecutive free generation drafts coalesced', async () => {
  const draw = node('draw', '原始指令');
  const f = fixture(doc([draw]), { authorize: deniedCanvasPro });
  await f.controller.load();
  const draft = prompt => f.controller.edit([{ ...draw, prompt }], undefined, draw.id);
  const edits = [draft('一'), draft('一只'), draft('一只小鸟')];
  assert.equal(f.controller.document.nodes[0].prompt, '一只小鸟');
  await Promise.all(edits);
  assert.equal(f.writes.length, 1);
  assert.equal(f.saved().document.nodes[0].prompt, '一只小鸟');
});

test('Canvas Pro protects a paid card in the planned write scope', async () => {
  const draw = { ...node('draw', '生成'), resultNodeIds: ['shared-note'] };
  const agent = { ...node('agent', '已有指令'), kind: 'agent', resultNodeIds: ['shared-note'] };
  const f = fixture(doc([draw, agent]), { authorize: deniedCanvasPro });
  await f.controller.load();
  await assert.rejects(() => f.controller.start(draw.id, true), /需要 Pro/);
  assert.equal(f.saved().document.run, null);
  assert.equal(f.generationRequests.length, 0);
});

test('Canvas Pro protects a reachable paid execution but leaves an accepted phase resumable', async () => {
  const draw = node('draw', '一只小鸟');
  const agent = { ...node('agent', '读取图片'), kind: 'agent', inputs: { image: [{ nodeId: draw.id, portId: 'image' }] } };
  const f = fixture(doc([draw, agent]), { authorize: deniedCanvasPro });
  await f.controller.load();
  await assert.rejects(() => f.controller.start(draw.id), /需要 Pro/);
  assert.equal(f.generationRequests.length, 0);

  const run = { id: 'paused', startId: agent.id, order: [agent.id], status: 'waiting', steps: { [agent.id]: { status: 'pending' } } };
  const paused = fixture({ ...doc([{ ...agent, inputs: {} }]), run }, { authorize: deniedCanvasPro });
  await paused.controller.load();
  await paused.controller.continue(run.id);
  assert.equal(paused.saved().document.run.status, 'done', paused.saved().document.run.steps[agent.id].error);
  assert.equal(paused.sends.length, 1);
});

test('Canvas Pro preserves queued completion from an accepted paid phase and gates entry from a free phase', async () => {
  const source = node('source', '已经完成');
  const trigger = { ...node('receiver'), kind: 'trigger', triggerMode: 'completion', triggerCount: 2,
    inputs: { completion: [{ nodeId: source.id, portId: 'signal' }] } };
  const draw = { ...node('draw', '生成'), inputs: { signal: [{ nodeId: trigger.id, portId: 'signal' }] } };
  for (const kind of ['generation', 'agent']) {
    const run = { id: 'queued', startId: source.id, order: [source.id], status: 'waiting',
      steps: { [source.id]: { status: 'done' } }, triggerQueue: [trigger.id] };
    let attempts = 0;
    const f = fixture({ ...doc([{ ...source, kind }, trigger, draw]), run }, { authorize: async () => { attempts++; await deniedCanvasPro(); } });
    await f.controller.load();
    await f.controller.continue(run.id);
    assert.equal(f.saved().document.run.status, kind === 'generation' ? 'waiting' : 'done', JSON.stringify(f.saved().document.run.steps));
    assert.deepEqual(f.saved().document.run.triggerQueue, kind === 'generation' ? [trigger.id] : []);
    assert.equal(f.saved().document.nodes.find(card => card.id === trigger.id).triggerCount, kind === 'generation' ? 2 : 1);
    assert.equal(f.generationRequests.length, kind === 'generation' ? 0 : 1);
    assert.equal(attempts, kind === 'generation' ? 1 : 0);
  }
});

test('Canvas Pro gates explicit retries only when the reset loop step is paid', async () => {
  const owner = { ...node('loop'), kind: 'loop', loopMode: 'count' };
  for (const kind of ['generation', 'agent']) {
    const card = { ...node('body', '再次提交'), kind };
    const run = { id: 'loop-run', startId: owner.id, order: [owner.id, card.id], status: 'waiting',
      steps: { [owner.id]: { status: 'done' }, [card.id]: { status: 'failed', retrySafe: true } },
      loop: { nodeId: owner.id, bodyIds: [card.id], index: 0, items: [{ text: '', assetIds: [] }], completed: [] } };
    const f = fixture({ ...doc([owner, card]), run }, { authorize: deniedCanvasPro });
    await f.controller.load();
    if (kind === 'agent') {
      await assert.rejects(() => f.controller.retryLoop(run.id), /需要 Pro/);
      assert.equal(f.saved().document.run.steps[card.id].status, 'failed');
      assert.equal(f.sends.length, 0);
    } else {
      await f.controller.retryLoop(run.id);
      assert.equal(f.saved().document.run.status, 'done', f.saved().document.run.steps[card.id].error);
      assert.equal(f.generationRequests.length, 1);
    }
  }
});

test('portable Agent templates retain provider/model settings and discard conversation identity', () => {
  const f = fixture();
  const { captureWorkflowTemplate, instantiateWorkflowTemplate, parseWorkflowTemplate } = f.load(resolve(lib, 'workflowTemplates.ts'));
  const trigger = { ...node('start'), kind: 'trigger' };
  const agent = { ...node('agent', '写作'), kind: 'agent', inputs: { signal: [{ nodeId: 'start', portId: 'signal' }] }, chatProvider: 'codex-local', chatCodexOptions: { model: 'fixture', reasoningEffort: 'high' }, chatConversationId: 'must-not-copy' };
  const template = captureWorkflowTemplate([trigger, agent], new Set(['start', 'agent']), '对话流程');
  assert.equal(template.schemaVersion, 6); assert.ok(!JSON.stringify(template).includes('must-not-copy'));
  const result = instantiateWorkflowTemplate(template, {}, {}, 'codex', [], 0, 0);
  assert.equal(result[1].chatProvider, 'codex-local'); assert.deepEqual(plain(result[1].chatCodexOptions), agent.chatCodexOptions);
  assert.equal(result[1].chatConversationId, undefined);
  const legacy = structuredClone(template);
  legacy.plan.nodes[1].chatProvider = 'deepseek-cloud';
  delete legacy.plan.nodes[1].chatCodexOptions;
  assert.equal(parseWorkflowTemplate(JSON.stringify(legacy)).plan.nodes[1].chatProvider, 'dsh-cloud');
  assert.equal(instantiateWorkflowTemplate(legacy, {}, {}, 'codex', [], 0, 0)[1].chatProvider, 'dsh-cloud');
  const cloudAgent = { ...agent, chatProvider: 'dsh-cloud', chatCodexOptions: undefined, chatDshSkill: { id: 'text-editor' } };
  const remote = captureWorkflowTemplate([trigger, cloudAgent], new Set(['start','agent']), '云端文本编辑');
  assert.equal(remote.schemaVersion, 7);
  assert.deepEqual(plain(instantiateWorkflowTemplate(remote, {}, {}, 'codex', [], 0, 0)[1].chatDshSkill), { id: 'text-editor' });
  remote.plan.nodes[1].chatDshSkill.instructions = 'injected template instructions';
  assert.throws(() => parseWorkflowTemplate(JSON.stringify(remote)), /云端技能/);
  template.plan.nodes[1].chatConversationId = 'forged';
  assert.throws(() => parseWorkflowTemplate(JSON.stringify(template)));
});

test('Agent execution submits through chat once and resumes the exact original turn', async () => {
  const agent = { ...node('agent', '写出说明'), kind: 'agent', chatProvider: 'deepseek-cloud' };
  const source = '参考文字'.repeat(50000);
  const step = { status: 'pending', agentInput: { prompt: agent.prompt, source: JSON.stringify({ source }), assetIds: [] } };
  const run = { id: 'run', startId: agent.id, threadId: 'thread', order: [agent.id], status: 'running', steps: { [agent.id]: step } };
  const f = fixture({ ...doc([agent]), run }); await f.controller.load();
  const first = await f.controller.chatResult(run.id, agent, step, [], () => false);
  assert.equal(first.text.text, '原轮次输出');
  assert.equal(f.sends.length, 1);
  assert.ok(f.sends[0].text.includes(source));
  assert.equal(f.sends[0].provider, 'dsh-cloud');
  assert.equal(f.sends[0].agentNodeId, agent.id);
  assert.equal(f.sends[0].manualCardRun, undefined, 'old and automatic workflow runs retain the original isolated request');
  const frozen = f.saved().document.run.steps[agent.id];
  const accepted = f.requests.get(frozen.chatInput.requestId);
  accepted.status = 'running'; accepted.messages.push({ turnId: 'later', role: 'assistant', status: 'running', text: '后续轮次', referenceAssetIds: [] });
  const recovered = await f.controller.chatResult(run.id, agent, frozen, [], () => false);
  assert.equal(recovered.text.text, '原轮次输出'); assert.equal(f.sends.length, 1);
  accepted.messages[0].status = 'interrupted';
  assert.equal(await f.controller.chatResult(run.id, agent, frozen, [], () => false), null);
  assert.equal(f.saved().document.run.steps[agent.id].status, 'waiting');
  assert.equal(f.sends.length, 1);
  accepted.messages.pop(); // The original failed completion is now the latest turn again.
  accepted.status = 'failed';
  accepted.error = 'chat_no_reply: 上游模型服务返回 HTTP 502。本轮云端任务已结束，没有可取回的回复。';
  await assert.rejects(() => f.controller.chatResult(run.id, agent, frozen, [], () => false), /HTTP 502/);
  f.requests.delete(frozen.chatInput.requestId);
  assert.equal(await f.controller.chatResult(run.id, agent, frozen, [], () => false), null);
  assert.equal(f.sends.length, 1, 'an acknowledged turn that disappeared must never be resubmitted');
});

test('only clicking run on the Agent itself opts its saved request into bound conversation history', async () => {
  const trigger = { ...node('signal'), kind: 'trigger' };
  const loop = { ...node('loop'), kind: 'loop', loopMode: 'count', loopCount: 2, inputs: { signal: [{ nodeId: trigger.id, portId: 'signal' }] } };
  const agent = { ...node('agent', '继续修改'), kind: 'agent', chatProvider: 'dsh-cloud', chatConversationId: 'bound-chat',
    inputs: { text: [{ nodeId: loop.id, portId: 'text' }] } };
  for (const [startId, single, expected] of [[agent.id, true, true], [trigger.id, false, undefined], [loop.id, false, undefined]]) {
    const f = fixture(doc([trigger, loop, agent]));
    await f.controller.load();
    f.controller.continue = async () => {}; // Capture the real accepted run before any step is dispatched.
    await f.controller.start(startId, single);
    const run = f.controller.run(f.saved().document.run.id);
    assert.equal(run.manualCardRun, expected);
    await f.controller.step(run.id, agent.id, { agentInput: { prompt: agent.prompt, source: '{}', assetIds: [] } });
    await f.controller.chatResult(run.id, agent, run.steps[agent.id], [], () => false);
    const request = f.sends[0];
    assert.equal(request.agentNodeId, agent.id);
    assert.equal(request.conversationId, agent.chatConversationId);
    assert.equal(request.manualCardRun, expected);
    assert.deepEqual(f.saved().document.run.steps[agent.id].chatInput, plain(request));
  }
});

test('lost chat admission response keeps the request and stops the accepted original conversation', async () => {
  const agent = { ...node('agent', '任务'), kind: 'agent' };
  const step = { status: 'pending', agentInput: { prompt: agent.prompt, source: '{}', assetIds: [] } };
  const run = { id: 'run', startId: agent.id, threadId: 'thread', order: [agent.id], status: 'running', steps: { [agent.id]: step } };
  const f = fixture({ ...doc([agent]), run }); await f.controller.load();
  const send = f.chatStore.send;
  f.chatStore.send = async input => { await send(input); throw new Error('IPC acknowledgement lost'); };
  assert.equal(await f.controller.chatResult(run.id, agent, step, [], () => false), null);
  const frozen = f.saved().document.run.steps[agent.id];
  assert.equal(frozen.status, 'waiting'); assert.ok(frozen.chatInput.requestId);
  assert.equal((await f.controller.chatResult(run.id, agent, frozen, [], () => false)).text.text, '原轮次输出');
  assert.equal(f.sends.length, 1);
  const second = fixture({ ...doc([agent]), run }); await second.controller.load();
  let halted = false;
  const accept = second.chatStore.send;
  second.chatStore.send = async input => { const chat = await accept(input); halted = true; return { ...chat, status: 'running' }; };
  assert.equal(await second.controller.chatResult(run.id, agent, step, [], () => halted), null);
  assert.deepEqual(second.stops, [['chat', 'turn']]);
});

test('chat card additions survive queued edits and stale workflow revision', async () => {
  const f = fixture(), c = f.controller; await c.load(); assert.equal(c.error, '');
  const release = f.hold();
  const first = c.save(doc([node('original', 'first edit')]));
  const second = c.save(doc([node('original', 'second edit')]));
  f.external(doc([node('original'), node('chat-card')]));
  release(); await Promise.all([first, second]);
  assert.deepEqual(f.saved().document.nodes.map(n => [n.id, n.prompt]), [['original', 'second edit'], ['chat-card', '']]);
  assert.deepEqual(plain(c.document), f.saved().document);
});

test('external undo removes only unchanged batch cards while keeping unrelated edits', async () => {
  const f = fixture(doc([node('original'), node('chat-card')])), c = f.controller; await c.load();
  f.external(doc([node('original')]));
  await c.save(doc([node('original', 'new edit'), node('chat-card')]));
  assert.deepEqual(f.saved().document.nodes.map(n => [n.id, n.prompt]), [['original', 'new edit']]);
});

test('same-card conflicts and deletion of an edited card preserve local edits and block save', async () => {
  const f = fixture(), c = f.controller; await c.load(); f.external(doc([]));
  await assert.rejects(c.save(doc([node('original', 'keep me')])), /同一卡片已有其他修改/);
  assert.equal(c.document.nodes[0].prompt, 'keep me'); assert.equal(f.saved().document.nodes.length, 0);
});

test('moving an active card retains concurrent execution checkpoints and rejects competing positions', () => {
  const f = fixture(), original = node('source'), base = doc([original]);
  const moved = doc([{ ...original, x: 34, y: 86 }]);
  const updated = doc([{ ...original, activeSessionNodeId: 'session', outputs: { image: { type: 'image', assetIds: ['result'] } } }]);
  const merged = f.mergeWorkflowChanges(base, moved, updated);
  assert.deepEqual(plain(merged.nodes[0]), { ...updated.nodes[0], x: 34, y: 86 });
  assert.throws(() => f.mergeWorkflowChanges(base, moved, doc([{ ...original, y: 77 }])), /同一卡片已有其他修改/);
});

test('retry after a failed write retains the unsaved edit', async () => {
  const f = fixture(), c = f.controller; await c.load(); f.fail(true);
  await assert.rejects(c.save(doc([node('original', 'unsaved')])), /synthetic disk/);
  f.fail(false); await c.retrySave();
  assert.equal(f.saved().document.nodes[0].prompt, 'unsaved'); assert.equal(c.error, '');
});

test('the next checkpoint commits a failed edit and preserves newer remote changes', async () => {
  const f = await activeFixture(), c = f.controller;
  const hold = f.hold();
  f.failNext();
  const failed = c.save({ ...c.document, nodes: c.document.nodes.map(n => n.id === 'a' ? { ...n, x: 12 } : n) }, true);
  const result = assert.rejects(failed, /synthetic disk/);
  const checkpoint = c.step('run-b', 'b', { detail: 'queued behind a failed edit' });
  hold(); await result; await checkpoint;
  assert.equal(f.saved().document.nodes[0].x, 12);
  assert.equal(f.saved().document.runs[1].steps.b.detail, 'queued behind a failed edit');
  assert.equal(c.error, '');

  f.fail(true);
  await assert.rejects(c.save({ ...c.document, nodes: c.document.nodes.map(n => n.id === 'a' ? { ...n, x: 20 } : n) }), /synthetic disk/);
  f.fail(false);
  const disk = f.saved().document;
  f.external({ ...disk, nodes: disk.nodes.map(n => n.id === 'b' ? { ...n, y: 40 } : n) });
  await c.refreshExternalCards();
  assert.equal(c.document.nodes[0].x, 20);
  assert.equal(c.document.nodes[1].y, 40);
  assert.match(c.error, /synthetic disk/);
  await c.save({ ...c.document, nodes: c.document.nodes.map(n => n.id === 'b' ? { ...n, y: 60 } : n) });
  assert.deepEqual(f.saved().document.nodes.map(n => [n.x, n.y]), [[20, 0], [0, 60]]);
  assert.equal(c.error, '');
});

test('an old video executor cannot release the new execution lock after stop times out', { timeout: 5000 }, async () => {
  const h3 = { ...node('h3'), kind: 'comfy-video' };
  const run = { ...running(h3.id), status: 'waiting', accountId: null, steps: { [h3.id]: { status: 'waiting', jobId: 'original-video' } } };
  const deadline = Promise.withResolvers(), cancel = Promise.withResolvers();
  const old = Promise.withResolvers(), resumed = Promise.withResolvers();
  const calls = [];
  const f = fixture({ ...doc([h3]), run, runs: [run] }, {
    authorize: deniedCanvasPro,
    setTimeout(callback, delay) {
      if (delay !== 20_000) return setTimeout(callback, delay);
      deadline.resolve(callback);
      return setTimeout(() => {}, delay);
    },
    invoke(command, args) {
      assert.equal(command, 'comfy_video');
      assert.equal(args.requestId, 'original-video');
      assert.notEqual(args.action, 'start');
      calls.push(args.action);
      if (args.action === 'cancel') return cancel.promise;
      return calls.length === 1 ? old.promise : resumed.promise;
    },
  });
  const waitForCall = async count => {
    while (calls.length < count) await new Promise(setImmediate);
  };
  const c = f.controller;
  await c.load();
  const oldExecution = c.continue();
  await waitForCall(1);
  const before = c.document;
  const stopping = assert.rejects(c.stop(), /超时/);
  await waitForCall(2);
  assert.equal(before.run.steps[h3.id].comfyStopping, undefined);
  assert.equal(c.document.run.steps[h3.id].comfyStopping, true);
  (await deadline.promise)();
  await stopping;
  const newExecution = c.continue();
  await waitForCall(3);
  const activeStep = c.document.run.steps[h3.id];
  old.resolve({ status: 'done', message: '迟到的原结果', asset: { id: 'stale' } });
  await oldExecution;
  assert.equal(c.document.run.steps[h3.id], activeStep);
  assert.ok(c.executing.has(run.id), 'the resumed execution still owns the lock');
  await c.continue();
  assert.deepEqual(calls, ['status', 'cancel', 'status']);
  resumed.resolve({ status: 'unknown', message: '查询原任务' });
  cancel.resolve({ status: 'cancelled', message: '迟到的停止回执' });
  await newExecution;
  assert.equal(c.document.run.steps[h3.id].jobId, 'original-video');
});

test('editor drafts stay responsive and flush together before a durable boundary', async () => {
  const h3 = { ...node('h3'), kind: 'comfy-video' };
  const f = fixture(doc([h3])), c = f.controller;
  await c.load();
  const draft = prompt => c.edit([{ ...h3, prompt }], undefined, h3.id, true);
  const first = draft('首'), second = draft('首次'), third = draft('首次编辑');
  await new Promise(setImmediate);
  assert.equal(c.document.nodes[0].prompt, '首次编辑');
  assert.equal(f.writes.length, 0);
  await c.flush();
  await Promise.all([first, second, third]);
  assert.equal(f.writes.length, 1);
  assert.equal(f.saved().document.nodes[0].prompt, '首次编辑');
});

test('completion scheduling reads no idle snapshots and falls back only while an original turn is pending', async () => {
  const nativePrompt = (id, status, jobId = 'ordinary-job') => ({ id, projectId: 'p', kind: 'prompt', createdAt: 1, hiddenAt: null,
    payloadJson: JSON.stringify({ job_id: jobId, turn_key: id, status }) });
  const result = (turn, jobId = 'ordinary-job') => ({ id: `output-${turn}`, projectId: 'p', kind: 'asset', createdAt: 2, hiddenAt: null, role: 'output', assetId: `asset-${turn}`,
    payloadJson: JSON.stringify({ execution: { job_id: jobId, turn_key: turn } }) });
  const old = nativePrompt('previous', 'done');
  const receiver = { ...node('recipient'), kind: 'trigger', triggerMode: 'completion', triggerCount: 2,
    inputs: { completion: [{ canvasNodeId: old.id, cellId: 'image' }] } };
  let nodes = [old, result(old.id)], reads = 0, currentTime = 0, id = 0;
  const timers = new Map();
  const f = fixture(doc([receiver]), {
    projectCanvasGet: async () => { reads++; return { nodes }; },
    setTimeout(callback, delay) { timers.set(++id, { callback, at: currentTime + delay }); return id; },
    clearTimeout(timer) { timers.delete(timer); },
  });
  const advance = async duration => {
    const end = currentTime + duration;
    while (true) {
      const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [timer, { at, callback }] = next;
      currentTime = at; timers.delete(timer); callback();
      await new Promise(setImmediate);
    }
    currentTime = end;
  };
  const c = f.controller;
  const claimed = [];
  c.startRun = async (triggerId, _single, sessionId) => {
    claimed.push(sessionId);
    await c.save({ ...c.document, nodes: c.document.nodes.map(n => n.id === triggerId ? { ...n, triggerCount: n.triggerCount - 1,
      completionSeen: [...(n.completionSeen ?? []), sessionId] } : n) });
  };
  await c.load();
  assert.equal(c.ready, true, c.error);
  await advance(0);
  c.setCanvasActive(false);
  const afterLoad = reads;
  await advance(30_000);
  assert.equal(reads, afterLoad, 'idle project schedules no canvas IPC');
  assert.deepEqual(claimed, [], 'loading never replays the historical turn');

  nodes = [...nodes, nativePrompt('continued', 'done')];
  c.notifySessionCompletionChange();
  await advance(0);
  assert.deepEqual(claimed, [], 'terminal event before result projection waits');
  assert.equal(timers.size, 1, 'the unresolved projected turn schedules one fallback');
  nodes = [...nodes, result('continued')];
  await advance(1500);
  assert.deepEqual(claimed, ['continued'], 'fallback still observes a pending continuation after leaving the project');
  const afterDelivery = reads;
  await advance(30_000);
  assert.equal(reads, afterDelivery, 'finished follow-up leaves no recurring read');

  nodes = [...nodes, nativePrompt('workflow-turn', 'running', 'workflow-job')];
  await c.save({ ...c.document, nodes: c.document.nodes.map(n => ({ ...n, inputs: { completion: [
    { nodeId: 'workflow', portId: 'image', pendingCompletionSession: 'workflow-turn' },
  ] } })) });
  await advance(0);
  nodes = [...nodes.filter(n => n.id !== 'workflow-turn'), nativePrompt('workflow-turn', 'done', 'workflow-job'), result('workflow-turn', 'workflow-job')];
  c.notifySessionCompletionChange();
  await advance(0);
  assert.deepEqual(claimed, ['continued', 'workflow-turn'], 'a fresh terminal event dispatches the original submitted workflow turn without waiting for the timer');
});

test('refresh and subsequent save retain remote card names without starting a run', async () => {
  const f = fixture(), c = f.controller; await c.load();
  f.external({ ...doc([node('original'), node('chat-card')]), cardNames: { 'chat-card': '对话生成' } });
  await c.refreshExternalCards();
  await c.save({ ...c.document, nodes: c.document.nodes.map(n => n.id === 'original' ? { ...n, prompt: 'edited' } : n) });
  assert.equal(f.saved().document.cardNames['chat-card'], '对话生成');
  assert.equal(f.saved().document.run, null);
});

test('independent local run state is kept alongside newly created cards', () => {
  const f = fixture(), base = doc([node('original')]);
  const run = { id: 'run', status: 'waiting', order: ['original'], steps: {} };
  const merged = f.mergeWorkflowChanges(base, { ...base, run, runs: [run] }, doc([node('original'), node('chat-card')]));
  assert.equal(merged.run.id, 'run'); assert.equal(merged.nodes.length, 2);
});

test('an external card add from an old snapshot preserves the active generation checkpoint through the next save', async () => {
  const original = { ...node('original'), activeSessionNodeId: 'old-session', sessionNodeIds: ['old-session'],
    outputs: { image: { type: 'image', nodeIds: ['old-session'] } } };
  const agent = { ...node('agent'), kind: 'agent' };
  const oldRun = { id: 'run', status: 'running', startId: original.id, order: [original.id, agent.id],
    steps: { [original.id]: { status: 'pending' }, [agent.id]: { status: 'pending' } } };
  const old = { ...doc([original, agent]), run: oldRun, runs: [oldRun] };
  const f = fixture(old), c = f.controller;
  await c.load();
  const step = { status: 'running', jobId: 'job', turnKey: 'turn', generationSubmission: 'pending', detail: 'checking local progress' };
  const liveRun = { ...oldRun, threadId: 'live-thread', steps: { ...oldRun.steps, [original.id]: step } };
  const live = { ...original, activeSessionNodeId: 'gen-prompt:job:turn:0', sessionNodeIds: [...original.sessionNodeIds, 'gen-prompt:job:turn:0'],
    outputs: { image: { type: 'image', nodeIds: ['gen-prompt:job:turn:0'] } }, resultNodeIds: ['current-output'] };
  await c.saveRun(liveRun, [live, agent]);
  const updatedAgent = { status: 'done', detail: 'agent completed separately' };
  const external = { ...oldRun, steps: { ...oldRun.steps, [agent.id]: updatedAgent } };
  const progressed = { ...liveRun, steps: { ...liveRun.steps, [agent.id]: updatedAgent } };
  f.external({ ...old, nodes: [original, agent, node('chat-card')], run: external, runs: [external] });
  await c.refreshExternalCards();
  assert.deepEqual(plain(c.document.run), progressed);
  assert.deepEqual(plain(c.document.nodes), [live, agent, node('chat-card')]);
  await c.save();
  assert.deepEqual(f.saved().document.run, progressed);
  assert.deepEqual(f.saved().document.nodes, [live, agent, node('chat-card')]);

  const terminal = { ...progressed, status: 'done', steps: { ...progressed.steps, [original.id]: { ...step, status: 'done', generationSubmission: 'submitted' } } };
  f.external({ ...doc([live, agent, node('chat-card')]), run: terminal, runs: [terminal] });
  await c.refreshExternalCards();
  assert.deepEqual(plain(c.document.run), terminal);
  f.external(doc([agent, node('chat-card')]));
  await c.refreshExternalCards();
  assert.deepEqual(plain(c.document.nodes), [agent, node('chat-card')]);
  assert.equal(c.document.run, null, 'a historical submitted marker does not resurrect cards removed externally');
});

test('a locally submitted handoff stays owned until its exact new media reaches the board', async () => {
  const original = node('original');
  const oldRun = { id: 'run', status: 'waiting', startId: original.id, order: [original.id],
    steps: { [original.id]: { status: 'pending' } } };
  const old = { ...doc([original]), run: oldRun, runs: [oldRun] };
  const f = fixture(old), c = f.controller;
  await c.load();
  await c.runWorkflowImageSession(oldRun.id, original, () => false, { prompt: 'new', rawPrompt: 'new', references: [], ratio: null });
  await c.saveRun({ ...c.document.run, status: 'done' });
  const submitted = plain(c.document), [request] = f.generationRequests;
  assert.equal(submitted.run.steps[original.id].generationSubmission, 'submitted');
  assert.equal(submitted.run.steps[original.id].jobId, request.jobId);
  const card = node('chat-card');
  f.external({ ...old, nodes: [original, card] });
  await c.refreshExternalCards();
  assert.deepEqual(plain(c.document.run), submitted.run);
  assert.deepEqual(plain(c.document.nodes), [...submitted.nodes, card]);
  const partiallyCheckpointed = { ...submitted.run, status: 'running' };
  f.external({ ...old, nodes: [original, card], run: partiallyCheckpointed, runs: [partiallyCheckpointed] });
  await c.refreshExternalCards();
  assert.deepEqual(plain(c.document.run), submitted.run, 'an older overall checkpoint cannot roll back the completed handoff');
  assert.deepEqual(plain(c.document.nodes), [...submitted.nodes, card]);

  const turn = { id: `gen-prompt:${request.jobId}:${request.turnKey}:0`, kind: 'prompt', projectId: 'p',
    payloadJson: JSON.stringify({ job_id: request.jobId, turn_key: request.turnKey, status: 'done' }) };
  const remoteWithoutHandoff = doc([card]);
  await c.syncCanvasReferences([turn]);
  f.external(remoteWithoutHandoff);
  await c.refreshExternalCards();
  assert.deepEqual(plain(c.document.run), submitted.run, 'a done turn without its media is still waiting for delivery');
  assert.deepEqual(plain(c.document.nodes), [...submitted.nodes, card]);
  await c.save();

  const output = { id: 'new-output', assetId: 'new', kind: 'asset', role: 'output', projectId: 'p',
    payloadJson: JSON.stringify({ execution: { job_id: request.jobId, turn_key: request.turnKey } }) };
  await c.syncCanvasReferences([turn, output]);
  f.external(remoteWithoutHandoff);
  await c.refreshExternalCards();
  assert.equal(c.document.run, null);
  assert.deepEqual(plain(c.document.nodes), [card]);
});

test('reopened submissions use the exact live job turn to protect an otherwise completed run', async () => {
  const original = node('original');
  const submitted = { id: 'run', status: 'done', startId: original.id, order: [original.id],
    steps: { [original.id]: { status: 'done', generationSubmission: 'submitted', jobId: 'job', turnKey: 'active' } } };
  const f = fixture({ ...doc([original]), run: submitted, runs: [submitted] });
  const c = f.controller;
  await c.load();
  f.genJobs.job = { running: true, turns: [{ turnKey: 'active' }] };
  const card = node('chat-card');
  f.external(doc([card]));
  await c.refreshExternalCards();
  assert.deepEqual(plain(c.document.run), submitted);
  assert.deepEqual(plain(c.document.nodes), [original, card]);
  await c.save();

  f.genJobs.job.turns.push({ turnKey: 'different' });
  f.external(doc([card]));
  await c.refreshExternalCards();
  assert.equal(c.document.run, null, 'a different turn cannot keep the old submission alive');
  assert.deepEqual(plain(c.document.nodes), [card]);
});

test('external snapshots cannot drop a running loop or roll it back to an earlier iteration', async () => {
  const owner = { ...node('loop'), kind: 'loop', loopMode: 'count', loopCount: 3 };
  const image = node('image');
  const f = fixture(doc([owner, image])), c = f.controller;
  await c.load();
  const loop = { nodeId: owner.id, bodyIds: [image.id], index: 1, completed: [{ outputs: {}, steps: {} }] };
  const step = { status: 'running', jobId: 'second', turnKey: 'turn-two' };
  const live = { id: 'loop-run', status: 'running', startId: owner.id, order: [owner.id, image.id], loop,
    steps: { [owner.id]: { status: 'done' }, [image.id]: step } };
  await c.saveRun(live, [owner, image]);
  const card = node('chat-card');
  f.external(doc([owner, image, card]));
  await c.refreshExternalCards();
  assert.deepEqual(plain(c.document.run), live);
  await c.save();

  const older = { ...live, loop: { ...loop, index: 0, completed: [] },
    steps: { ...live.steps, [image.id]: { status: 'done', jobId: 'first', turnKey: 'turn-one' } } };
  f.external({ ...doc([owner, image, card]), run: older, runs: [older] });
  await c.refreshExternalCards();
  assert.deepEqual(plain(c.document.run), live);
  await c.save();

  const newer = { ...live, loop: { ...loop, index: 2, completed: [...loop.completed, { outputs: {}, steps: {} }] },
    steps: { ...live.steps, [image.id]: { status: 'pending' } } };
  f.external({ ...doc([owner, image, card]), run: newer, runs: [newer] });
  await c.refreshExternalCards();
  assert.deepEqual(plain(c.document.run), newer, 'an advancing cursor is a distinct attempt');
});

test('native object key ordering does not turn an unchanged card into a conflict', () => {
  const f = fixture();
  const original = { ...node('original'), inputs: { image: [{ assetId: 'asset', portId: 'image' }] }, generation: { media: 'image', ratio: null }, optional: undefined };
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
  const base = doc([original]), local = doc([{ ...original, prompt: 'queued edit' }]);
  const remote = canonical(doc([original, node('chat-card')]));
  const merged = f.mergeWorkflowChanges(base, local, remote);
  assert.deepEqual(plain(merged.nodes).map(n => [n.id, n.prompt]), [['original', 'queued edit'], ['chat-card', '']]);

  const reorderedBindings = clone(remote);
  base.nodes[0].inputs.image.push({ assetId: 'second', portId: 'image' });
  reorderedBindings.nodes[0].inputs.image = [...base.nodes[0].inputs.image].reverse();
  assert.throws(() => f.mergeWorkflowChanges(base, local, reorderedBindings), /同一卡片已有其他修改/, 'array order remains meaningful');
});

const running = id => ({ id: `run-${id}`, startId: id, threadId: `thread-${id}`, status: 'running', order: [id],
  lockedNodeIds: [id], writeNodeIds: [id], steps: { [id]: { status: 'running', jobId: `job-${id}`, detail: 'submitted' } } });
async function activeFixture(kind = 'generation') {
  const f = fixture(doc([{ ...node('a'), kind }, { ...node('b'), kind }]));
  await f.controller.load();
  await f.controller.saveRun(running('a'));
  await f.controller.saveRun(running('b'));
  return f;
}

test('only adjacent draft edits coalesce across CAS and every run checkpoint reaches disk in order', async () => {
  const f = await activeFixture(), c = f.controller;
  await c.edit([...c.document.nodes, node('draft')]);
  const edit = text => c.edit(c.document.nodes.map(n => n.id === 'draft' ? { ...n, prompt: text } : n), undefined, 'draft');
  const release = f.hold(), first = f.writes.length;
  const jobs = [c.step('run-a', 'a', { detail: 'before edits' }), edit('a'), edit('ab'),
    c.step('run-a', 'a', { detail: 'between drafts' }), edit('abc'), edit('abcd')];
  f.external({ ...f.saved().document, nodes: [...f.saved().document.nodes, node('from-other-editor')] });
  release(); await Promise.all(jobs);
  assert.deepEqual(f.writes.slice(first).map(d => [d.nodes.find(n => n.id === 'draft').prompt, d.runs[0].steps.a.detail]),
    [['', 'before edits'], ['ab', 'before edits'], ['ab', 'between drafts'], ['abcd', 'between drafts']]);
  assert.ok(f.saved().document.nodes.some(n => n.id === 'from-other-editor'));

  const finish = f.hold();
  const checkpoint = c.step('run-b', 'b', { detail: 'concurrent save' });
  const edits = [edit('local first'), edit('local latest')];
  f.external({ ...f.saved().document, nodes: f.saved().document.nodes.map(n => n.id === 'draft' ? { ...n, prompt: 'remote' } : n) });
  finish(); await Promise.allSettled([checkpoint, ...edits]);
  assert.match(c.error, /同一卡片已有其他修改/);
  assert.equal(c.document.nodes.find(n => n.id === 'draft').prompt, 'local latest');
  assert.equal(f.saved().document.nodes.find(n => n.id === 'draft').prompt, 'remote');
});

test('refresh joins the write queue while two active runs checkpoint and chat adds cards', async () => {
  const f = await activeFixture(), c = f.controller;
  const release = f.hold();
  const checkpointA = c.step('run-a', 'a', { detail: 'first checkpoint' });
  f.external({ ...f.saved().document, nodes: [...f.saved().document.nodes, node('chat-card')], cardNames: { ...f.saved().document.cardNames, 'chat-card': '新卡片' } });
  const refresh = c.refreshExternalCards();
  const checkpointB = c.step('run-b', 'b', { detail: 'second checkpoint' });
  release();
  await Promise.all([checkpointA, refresh, checkpointB]);
  assert.deepEqual(f.saved().document.nodes.map(n => n.id), ['a', 'b', 'chat-card']);
  assert.deepEqual(f.saved().document.runs.map(r => [r.id, r.status, r.steps[r.startId].detail]),
    [['run-a', 'running', 'first checkpoint'], ['run-b', 'running', 'second checkpoint']]);
  assert.equal(c.error, '');
});

test('checkpoint queued during an external refresh never drops the new card on CAS retry', async () => {
  const f = await activeFixture(), c = f.controller;
  f.external({ ...f.saved().document, nodes: [...f.saved().document.nodes, node('chat-card')] });
  const read = f.holdRead(), refresh = c.refreshExternalCards();
  await read.started;
  const release = f.hold(), checkpoint = c.step('run-a', 'a', { detail: 'new progress' });
  read.release(); await refresh;
  release(); await checkpoint;
  assert.deepEqual(f.saved().document.nodes.map(n => n.id), ['a', 'b', 'chat-card']);
  assert.equal(f.saved().document.runs[0].steps.a.detail, 'new progress');
  assert.equal(f.saved().document.runs[1].status, 'running');
  assert.equal(c.error, '');
});

test('external undo during active runs preserves their identities and later completion', async () => {
  const f = await activeFixture(), c = f.controller;
  f.external({ ...f.saved().document, nodes: [...f.saved().document.nodes, node('chat-card')] });
  await c.refreshExternalCards();
  const runA = c.document.runs[0], runB = c.document.runs[1];
  f.external({ ...f.saved().document, nodes: f.saved().document.nodes.filter(n => n.id !== 'chat-card') });
  await c.refreshExternalCards();
  assert.equal(c.document.runs[0], runA); assert.equal(c.document.runs[1], runB);
  await c.step('run-a', 'a', { status: 'done' });
  await c.step('run-b', 'b', { detail: 'still working' });
  assert.deepEqual(f.saved().document.nodes.map(n => n.id), ['a', 'b']);
  assert.equal(f.saved().document.runs[0].steps.a.status, 'done');
  assert.equal(f.saved().document.runs[1].steps.b.detail, 'still working');
  assert.equal(c.error, '');
});

test('a failed refresh read does not poison ongoing run checkpoints', async () => {
  const f = await activeFixture(), c = f.controller;
  f.failRead(true);
  await assert.rejects(c.refreshExternalCards(), /synthetic read failed/);
  f.failRead(false);
  await c.step('run-a', 'a', { detail: 'saved after transient read error' });
  assert.equal(f.saved().document.runs[0].steps.a.detail, 'saved after transient read error');
  assert.equal(c.error, '');
});

test('independent run progress merges by run identity while conflicting progress is rejected', () => {
  const f = fixture(), a = running('a'), b = running('b'), base = { ...doc([node('a'), node('b')]), runs: [a, b], run: b };
  const local = clone(base), remote = clone(base);
  local.runs[0].steps.a.detail = 'local progress'; remote.runs[1].steps.b.detail = 'remote progress';
  const merged = f.mergeWorkflowChanges(base, local, remote);
  assert.deepEqual(plain(merged.runs).map(r => r.steps[r.startId].detail), ['local progress', 'remote progress']);
  assert.equal(merged.run, merged.runs[1]);
  remote.runs[0].steps.a.detail = 'conflicting progress';
  assert.throws(() => f.mergeWorkflowChanges(base, local, remote), /同一卡片已有其他修改/);
});

test('consecutive native batches during a checkpoint are merged without resurrecting an undone card', async () => {
  const f = await activeFixture(), c = f.controller;
  f.interleave(
    document => ({ ...document, nodes: [...document.nodes, node('batch-1')] }),
    document => ({ ...document, nodes: [...document.nodes.filter(n => n.id !== 'batch-1'), node('batch-2')] }),
    document => ({ ...document, nodes: [...document.nodes, node('batch-3')] }),
    document => ({ ...document, nodes: [...document.nodes, node('batch-4')] }),
  );
  await c.step('run-a', 'a', { detail: 'checkpoint across card batches' });
  assert.deepEqual(f.saved().document.nodes.map(n => n.id), ['a', 'b', 'batch-2', 'batch-3', 'batch-4']);
  assert.equal(f.saved().document.runs[0].steps.a.detail, 'checkpoint across card batches');
  assert.equal(f.saved().document.runs[1].status, 'running');
  assert.equal(c.error, '');
});

test('a refresh merge conflict keeps local progress and blocks subsequent overwrite', async () => {
  const f = await activeFixture(), c = f.controller;
  c.progress('run-a', 'a', 'local live progress');
  const remote = f.saved().document; remote.runs[0].steps.a.detail = 'other window progress';
  f.external(remote);
  await assert.rejects(c.refreshExternalCards(), /同一卡片已有其他修改/);
  await assert.rejects(c.step('run-b', 'b', { detail: 'not persisted over conflict' }), /同一卡片已有其他修改/);
  assert.equal(c.document.runs[0].steps.a.detail, 'local live progress');
  assert.equal(f.saved().document.runs[0].steps.a.detail, 'other window progress');
  assert.equal(f.saved().document.runs[1].steps.b.detail, 'submitted');
});

test('two live executor loops finish after chat creates and undoes unrelated cards', { timeout: 5000 }, async () => {
  const f = await activeFixture('trigger'), c = f.controller;
  const { workflowLockedNodes } = f.load(resolve(lib, 'canvasWorkflow.ts'));
  const reached = Promise.withResolvers(), gate = Promise.withResolvers(), finishing = new Set();
  const finish = c.finish.bind(c);
  c.finish = async (id, ...args) => {
    finishing.add(id); if (finishing.size === 2) reached.resolve();
    await gate.promise; return finish(id, ...args);
  };
  const first = c.continue('run-a'), second = c.continue('run-b');
  await reached.promise;
  assert.deepEqual([...finishing].sort(), ['run-a', 'run-b']);
  assert.deepEqual([...workflowLockedNodes(c.document)].sort(), ['a', 'b']);
  f.external({ ...f.saved().document, nodes: [...f.saved().document.nodes, node('chat-card')] });
  await c.refreshExternalCards();
  assert.equal(c.isLocked('chat-card'), false);
  f.external({ ...f.saved().document, nodes: f.saved().document.nodes.filter(n => n.id !== 'chat-card') });
  await c.refreshExternalCards();
  assert.deepEqual([...workflowLockedNodes(c.document)].sort(), ['a', 'b']);
  gate.resolve(); await Promise.all([first, second]);
  assert.equal(c.error, ''); assert.equal(c.issue, null);
  assert.deepEqual(f.saved().document.runs.map(r => [r.id, r.status, r.steps[r.startId].status]),
    [['run-a', 'done', 'done'], ['run-b', 'done', 'done']]);
  assert.deepEqual(f.saved().document.nodes.map(n => n.id), ['a', 'b']);
});

test('live progress received during a checkpoint remains an unsaved delta for the next checkpoint', async () => {
  const f = await activeFixture(), c = f.controller, release = f.hold();
  const checkpoint = c.step('run-a', 'a', { detail: 'durable checkpoint' });
  c.progress('run-b', 'b', 'live update during disk write');
  release(); await checkpoint;
  assert.equal(f.saved().document.runs[1].steps.b.detail, 'submitted');
  await c.step('run-b', 'b', { status: 'done' });
  assert.equal(f.saved().document.runs[1].steps.b.detail, 'live update during disk write');
  assert.equal(f.saved().document.runs[1].steps.b.status, 'done');
  assert.equal(c.error, '');
});

test('chat card events refresh native content even when workflow refresh fails, scoped to the mounted project', async () => {
  const path = resolve(lib, '../components/CanvasWorkspace.tsx'), source = readFileSync(path, 'utf8');
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback, refreshMountedWorkflow;
  const visit = node => {
    if (ts.isCallExpression(node) && node.arguments[0]?.getText(ast) === 'LOCAL_CHAT_CARDS_CHANGED_EVENT') callback = node.arguments[1];
    if (ts.isBinaryExpression(node) && node.left.getText(ast) === 'workflowCardsChanged.current' && ts.isArrowFunction(node.right)) refreshMountedWorkflow = node.right;
    ts.forEachChild(node, visit);
  };
  visit(ast); assert.ok(callback, 'production card listener is present'); assert.ok(refreshMountedWorkflow, 'production mounted-workflow refresh is present');
  const refreshes = [], controllerCalls = [], errors = [], failure = new Error('workflow merge conflict');
  let retries = 0;
  const context = vm.createContext({ module: { exports: {} }, alive: true, projectId: 'p', loadingRef: { current: false }, workflowCardsChanged: {},
    scheduleRefresh: (...args) => refreshes.push(args), reportError: error => errors.push(error),
    controller: { projectId: 'p', refreshExternalCards() { controllerCalls.push(this.projectId); return Promise.reject(failure); } }, retry: () => retries++ });
  const output = ts.transpileModule(`workflowCardsChanged.current = (${refreshMountedWorkflow.getText(ast)}); module.exports = (${callback.getText(ast)});`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInContext(output, context); const listener = context.module.exports;
  listener({ payload: { projectId: 'p' } });
  assert.deepEqual(refreshes, [['p', 40]], 'native graph refresh is scheduled independently');
  await Promise.resolve(); assert.deepEqual(errors, [failure]);
  listener({ payload: { projectId: 'other-project' } });
  context.loadingRef.current = true;
  listener({ payload: { projectId: 'p' } });
  context.alive = false; listener({ payload: { projectId: 'p' } });
  assert.deepEqual(refreshes, [['p', 40], ['p', 40]]); assert.deepEqual(controllerCalls, ['p']);
  assert.equal(retries, 1, 'a matching event while the native view is loading rechecks the current project once');
});


test('parallel workflow waits consume only their target revisions and detach on completion or discard', async () => {
  const f = fixture();
  const make = id => ({ id, revision: 1, status: 'running', messages: [{turnId: id, role: 'assistant', status: 'running'}] });
  const a = make('a'), b = make('b');
  let halted = false;
  const wa = f.controller.waitForChatTurn(a, 'a', () => halted);
  const wb = f.controller.waitForChatTurn(b, 'b', () => halted);
  await new Promise(setImmediate);
  for (let revision = 2; revision <= 51; revision++) {
    f.chatStore.applyConversation({ ...a, revision });
    f.chatStore.applyConversation({ ...b, revision });
  }
  assert.equal(f.chatListeners.size, 2);
  f.chatStore.applyConversation({ ...a, revision: 52, status: 'idle' });
  assert.equal((await wa).revision, 52);
  assert.equal(f.chatListeners.size, 1);
  halted = true;
  f.controller.discard();
  assert.equal(await wb, null);
  assert.equal(f.chatListeners.size, 0);
  assert.deepEqual(f.reads, { checkpoints: 0, full: 0 });
});

test('a quiet workflow checks the revision only and recovers a missed terminal snapshot once', async () => {
  const f = fixture();
  const running = { id: 'chat', revision: 1, status: 'running', messages: [{ turnId: 'original', role: 'assistant', status: 'running' }] };
  f.checkpoints.set('chat', 1);
  const final = { ...running, revision: 2, status: 'idle', messages: [{turnId: 'original', role: 'assistant', status: 'done'}] };
  f.requests.set('key', final);
  const result = f.controller.waitForChatTurn(running, 'original', () => false);
  await new Promise(resolve => setTimeout(resolve, 5200));
  assert.deepEqual(f.reads, {checkpoints: 1, full: 0});
  f.checkpoints.set('chat', 2);
  assert.equal((await result).revision, 2);
  assert.deepEqual(f.reads, {checkpoints: 2, full: 1});
  assert.equal(f.chatListeners.size, 0);
});
