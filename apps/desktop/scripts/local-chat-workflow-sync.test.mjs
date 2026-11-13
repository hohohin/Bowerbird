import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

const lib = fileURLToPath(new URL('../src/lib/', import.meta.url));
const clone = value => structuredClone(value);
const plain = value => JSON.parse(JSON.stringify(value));
const node = (id, prompt = '') => ({ id, kind: 'generation', x: 0, y: 0, action: 'describe', skill: 'image-edit', prompt, ratio: null, provider: 'codex', inputs: {}, outputs: {}, outputPorts: [], trigger: false });
const doc = nodes => ({ schema_version: 1, nodes, run: null });
function fixture(initial = doc([node('original')])) {
  let saved = { revision: 1, document: clone(initial) }, fail = false, gate, readGate, assetGate, failRead = false;
  const interleavedChanges = [];
  const modules = new Map();
  const requests = new Map(), sends = [], stops = [];
  const chatApi = { getByRequest: async id => clone(requests.get(id) ?? null) };
  const chatStore = { summaries: {}, loadProject: async () => {}, applyConversation: () => {},
    loadConversation: async id => clone([...requests.values()].find(chat => chat.id === id) ?? null),
    stop: async id => { stops.push(id); },
    send: async input => {
      assert.equal(saved.document.run.steps[input.agentNodeId].chatInput.requestId, input.requestId, 'save the request before submitting');
      sends.push(clone(input));
      const chat = { id: 'chat', projectId: input.projectId, nodeId: input.agentNodeId, provider: input.provider, submittedTurnId: 'turn', status: 'idle', error: null,
        messages: [{ turnId: 'turn', role: 'assistant', status: 'done', text: '原轮次输出', referenceAssetIds: [] }] };
      requests.set(input.requestId, clone(chat)); return chat;
    } };
  const api = {
    canvasWorkflowGet: async () => {
      const snapshot = clone(saved);
      if (readGate) { readGate.entered(); await readGate.promise; }
      if (failRead) throw new Error('synthetic read failed');
      return snapshot;
    }, projectCanvasGet: async () => ({ nodes: [] }), canvasWorkflowAuthorize: async () => {}, projectThreadCreate: async () => {},
    getAssetsByIds: async ids => {
      if (assetGate) { assetGate.entered(); await assetGate.promise; }
      return ids.map(id => ({ id, store_path: `${id}.png` }));
    },
    canvasWorkflowSave: async (_id, revision, document) => {
      if (gate) await gate;
      if (fail) throw new Error('synthetic disk write failed');
      const change = interleavedChanges.shift();
      if (change) saved = { revision: saved.revision + 1, document: change(clone(saved.document)) };
      if (revision !== saved.revision) throw new Error('工作流已被其他窗口修改，请重新打开项目');
      saved = { revision: revision + 1, document: clone(document) }; return saved.revision;
    },
  };
  const context = vm.createContext({ console, crypto: webcrypto, structuredClone, TextEncoder, setTimeout, clearTimeout });
  function load(path) {
    if (modules.has(path)) return modules.get(path).exports;
    const module = { exports: {} }; modules.set(path, module);
    const output = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const require = specifier => {
      if (specifier === './api') return { api };
      if (specifier === './userError') return load(resolve(dirname(path), 'userError.ts'));
      if (specifier === './dshSkill.ts' || specifier === './chatProvider.ts') return load(resolve(dirname(path), specifier));
      if (specifier === './localChat') return { localChat: chatApi, localChatRunning: chat => chat && ['running', 'stopping'].includes(chat.status) };
      if (specifier === './localChatStore') return { useLocalChatStore: { getState: () => chatStore } };
      if (specifier === '../store') return { useStore: { getState: () => ({ genJobs: {} }) } };
      if (specifier === './workflowPlannerRuntime') return { WorkflowPlannerRuntime: class {} };
      if (specifier === './workflowVideoFrames') return { resolveVideoCardOutputs: async () => {} };
      if (specifier === './workflowLoop') return load(resolve(lib, 'workflowLoop.ts'));
      if (specifier === './workflowAgentOutputs') return { agentWriterValue: () => undefined, agentOutputTargets: () => [] };
      if (specifier === './canvasSessionOutputs') return { completedCanvasSessions: () => [], reconcileCanvasWorkflowReferences: nodes => nodes };
      if (['./workflowExternalChanges', './canvasWorkflow', './canvasCardNames', './workflowDiagnostics', './workflowTriggerSchedule', './workflowTriggerSchedule.ts', './workflowAgentChat', './workflowAgentResult', './workflowAgentProfile', './workflowTemplates', './workflowPlanner', './contentTable.ts'].includes(specifier)) return load(resolve(dirname(path), specifier.endsWith('.ts') ? specifier : `${specifier}.ts`));
      return {};
    };
    vm.runInContext(`(function(require,module,exports){${output}\n})`, context, { filename: path })(require, module, module.exports);
    return module.exports;
  }
  const { CanvasWorkflowController } = load(resolve(lib, 'canvasWorkflowRuntime.ts'));
  const { mergeWorkflowChanges } = load(resolve(lib, 'workflowExternalChanges.ts'));
  return { controller: new CanvasWorkflowController('p'), mergeWorkflowChanges, saved: () => plain(saved), requests, sends, stops, chatStore, chatApi, load,
    external: document => { saved = { revision: saved.revision + 1, document: clone(document) }; },
    fail: value => { fail = value; }, failRead: value => { failRead = value; },
    interleave: (...changes) => { interleavedChanges.push(...changes); },
    holdRead: () => {
      let entered, release;
      const started = new Promise(resolve => { entered = resolve; }), promise = new Promise(resolve => { release = resolve; });
      readGate = { entered, promise };
      return { started, release: () => { readGate = undefined; release(); } };
    },
    holdAssets: expected => {
      let entered, release, count = 0;
      const started = new Promise(resolve => { entered = resolve; }), promise = new Promise(resolve => { release = resolve; });
      assetGate = { entered: () => { if (++count === expected) entered(); }, promise };
      return { started, release: () => { assetGate = undefined; release(); } };
    },
    hold: () => { let release; gate = new Promise(resolve => { release = resolve; }); return () => { gate = undefined; release(); }; } };
}

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
  const first = await f.controller.chatResult(run.id, agent, step, () => false);
  assert.equal(first.text.text, '原轮次输出');
  assert.equal(f.sends.length, 1);
  assert.ok(f.sends[0].text.includes(source));
  assert.equal(f.sends[0].provider, 'dsh-cloud');
  assert.equal(f.sends[0].agentNodeId, agent.id);
  assert.equal(f.sends[0].manualCardRun, undefined, 'old and automatic workflow runs retain the original isolated request');
  const frozen = f.saved().document.run.steps[agent.id];
  const accepted = f.requests.get(frozen.chatInput.requestId);
  accepted.status = 'running'; accepted.messages.push({ turnId: 'later', role: 'assistant', status: 'running', text: '后续轮次', referenceAssetIds: [] });
  const recovered = await f.controller.chatResult(run.id, agent, frozen, () => false);
  assert.equal(recovered.text.text, '原轮次输出'); assert.equal(f.sends.length, 1);
  accepted.messages[0].status = 'interrupted';
  assert.equal(await f.controller.chatResult(run.id, agent, frozen, () => false), null);
  assert.equal(f.saved().document.run.steps[agent.id].status, 'waiting');
  assert.equal(f.sends.length, 1);
  accepted.messages.pop(); // The original failed completion is now the latest turn again.
  accepted.status = 'failed';
  accepted.error = 'chat_no_reply: 上游模型服务返回 HTTP 502。本轮云端任务已结束，没有可取回的回复。';
  await assert.rejects(() => f.controller.chatResult(run.id, agent, frozen, () => false), /HTTP 502/);
  assert.equal(f.sends.length, 1);
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
    await f.controller.chatResult(run.id, agent, run.steps[agent.id], () => false);
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
  assert.equal(await f.controller.chatResult(run.id, agent, step, () => false), null);
  const frozen = f.saved().document.run.steps[agent.id];
  assert.equal(frozen.status, 'waiting'); assert.ok(frozen.chatInput.requestId);
  assert.equal((await f.controller.chatResult(run.id, agent, frozen, () => false)).text.text, '原轮次输出');
  assert.equal(f.sends.length, 1);
  const second = fixture({ ...doc([agent]), run }); await second.controller.load();
  let halted = false;
  const accept = second.chatStore.send;
  second.chatStore.send = async input => { const chat = await accept(input); halted = true; return { ...chat, status: 'running' }; };
  assert.equal(await second.controller.chatResult(run.id, agent, step, () => halted), null);
  assert.deepEqual(second.stops, ['chat']);
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

test('two live executor loops finish after chat creates and undoes unrelated cards', async () => {
  const f = await activeFixture('trigger'), c = f.controller, assets = f.holdAssets(2);
  const first = c.continue('run-a'), second = c.continue('run-b');
  await assets.started;
  assert.equal(c.isLocked('a'), true); assert.equal(c.isLocked('b'), true);
  f.external({ ...f.saved().document, nodes: [...f.saved().document.nodes, node('chat-card')] });
  await c.refreshExternalCards();
  assert.equal(c.isLocked('chat-card'), false);
  f.external({ ...f.saved().document, nodes: f.saved().document.nodes.filter(n => n.id !== 'chat-card') });
  await c.refreshExternalCards();
  assert.equal(c.isLocked('a'), true); assert.equal(c.isLocked('b'), true);
  assets.release(); await Promise.all([first, second]);
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
  let callback;
  const visit = node => {
    if (ts.isCallExpression(node) && node.arguments[0]?.getText(ast) === 'LOCAL_CHAT_CARDS_CHANGED_EVENT') callback = node.arguments[1];
    ts.forEachChild(node, visit);
  };
  visit(ast); assert.ok(callback, 'production card listener is present');
  const refreshes = [], controllerCalls = [], errors = [], failure = new Error('workflow merge conflict');
  const context = vm.createContext({ module: { exports: {} }, alive: true, projectId: 'p',
    scheduleRefresh: (...args) => refreshes.push(args), reportError: error => errors.push(error),
    canvasWorkflowController: id => ({ refreshExternalCards: () => { controllerCalls.push(id); return Promise.reject(failure); } }) });
  const output = ts.transpileModule(`module.exports = (${callback.getText(ast)});`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInContext(output, context); const listener = context.module.exports;
  listener({ payload: { projectId: 'p' } });
  assert.deepEqual(refreshes, [['p', 40]], 'native graph refresh is scheduled independently');
  await Promise.resolve(); assert.deepEqual(errors, [failure]);
  listener({ payload: { projectId: 'other-project' } });
  context.alive = false; listener({ payload: { projectId: 'p' } });
  assert.deepEqual(refreshes, [['p', 40]]); assert.deepEqual(controllerCalls, ['p']);
});
