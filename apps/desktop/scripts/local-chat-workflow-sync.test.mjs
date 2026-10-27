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
  const api = {
    canvasWorkflowGet: async () => {
      const snapshot = clone(saved);
      if (readGate) { readGate.entered(); await readGate.promise; }
      if (failRead) throw new Error('synthetic read failed');
      return snapshot;
    }, projectCanvasGet: async () => ({ nodes: [] }), canvasWorkflowAuthorize: async () => {},
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
  const context = vm.createContext({ console, crypto: webcrypto, structuredClone, setTimeout, clearTimeout });
  function load(path) {
    if (modules.has(path)) return modules.get(path).exports;
    const module = { exports: {} }; modules.set(path, module);
    const output = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const require = specifier => {
      if (specifier === './api') return { api };
      if (specifier === '../store') return { useStore: { getState: () => ({ genJobs: {} }) } };
      if (specifier === './workflowPlannerRuntime') return { WorkflowPlannerRuntime: class {} };
      if (specifier === './workflowVideoFrames') return { resolveVideoCardOutputs: async () => {} };
      if (specifier === './workflowAgentOutputs') return { agentWriterValue: () => undefined };
      if (specifier === './canvasSessionOutputs') return { completedCanvasSessions: () => [], reconcileCanvasWorkflowReferences: nodes => nodes };
      if (['./workflowExternalChanges', './canvasWorkflow', './canvasCardNames', './workflowDiagnostics', './contentTable.ts'].includes(specifier)) return load(resolve(dirname(path), specifier.endsWith('.ts') ? specifier : `${specifier}.ts`));
      return {};
    };
    vm.runInContext(`(function(require,module,exports){${output}\n})`, context, { filename: path })(require, module, module.exports);
    return module.exports;
  }
  const { CanvasWorkflowController } = load(resolve(lib, 'canvasWorkflowRuntime.ts'));
  const { mergeWorkflowChanges } = load(resolve(lib, 'workflowExternalChanges.ts'));
  return { controller: new CanvasWorkflowController('p'), mergeWorkflowChanges, saved: () => plain(saved),
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
