import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

// Export this input with local_chat_cards_export_review_fixtures. The card graph
// comes from the Rust compiler; native storage and ComfyUI are closed fakes.
const lib = fileURLToPath(new URL('../src/lib/', import.meta.url));
const fixturePath = process.env.BOWERBIRD_CARD_FIXTURES
  ?? fileURLToPath(new URL('../.tmp/local-chat/h3-card-fixtures.json', import.meta.url));
const example = JSON.parse(readFileSync(fixturePath, 'utf8')).h3;
assert.ok(example?.workflow?.document, 'export the Rust H3 fixture first');
const plain = value => JSON.parse(JSON.stringify(value));
const clone = value => structuredClone(value);

function fixture(initial = example.workflow) {
  let saved = clone(initial);
  const calls = [], modules = new Map();
  const account = { cloudAuth: { logged_in: true, user_id: 'fixture-user' },
    cloudEntitlement: { user_id: 'fixture-user', tier: 'pro', offline_state: 'fresh' }, genJobs: {} };
  const canvas = { nodes: clone(example.notes), groups: [], groupItems: [] };
  const api = {
    canvasWorkflowGet: async () => clone(saved),
    projectCanvasGet: async () => clone(canvas),
    canvasWorkflowAuthorize: async () => { calls.push({ command: 'authorize' }); },
    projectThreadCreate: async () => {},
    getAssetsByIds: async ids => ids.map(id => ({ id, store_path: `${id}.png`, width: 640, height: 960 })),
    canvasWorkflowSave: async (_id, revision, document) => {
      assert.equal(revision, saved.revision);
      saved = { revision: revision + 1, document: clone(document) };
      return saved.revision;
    },
  };
  const invoke = async (command, args) => {
    calls.push({ command, args: clone(args) });
    if (command === 'comfy_video_environment' && args.action === 'prepare') {
      return { phase: 'ready', endpoint: 'http://127.0.0.1:18189', message: 'synthetic ready' };
    }
    if (command === 'comfy_video' && ['start', 'status'].includes(args.action)) {
      return { status: 'unknown', message: 'synthetic pending task' };
    }
    throw new Error(`unexpected native call: ${command}`);
  };
  const real = new Set(['canvasWorkflow', 'workflowExternalChanges', 'canvasCardNames', 'workflowDiagnostics',
    'contentTable', 'workflowLoop', 'canvasNotes', 'canvasSessionOutputs', 'canvasConversationCards',
    'comfyVideo', 'videoGeneration']);
  const context = vm.createContext({ console, crypto: webcrypto, structuredClone, setTimeout, clearTimeout });
  function load(path) {
    if (modules.has(path)) return modules.get(path).exports;
    const module = { exports: {} }; modules.set(path, module);
    const code = ts.transpileModule(readFileSync(path, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const require = specifier => {
      if (specifier === './api') return { api };
      if (specifier === '../store') return { useStore: { getState: () => account } };
      if (specifier === '@tauri-apps/api/core') return { invoke };
      if (specifier === '@tauri-apps/api/event') return { emit: async () => {} };
      if (specifier === './workflowPlannerRuntime') return { WorkflowPlannerRuntime: class {} };
      if (specifier === './workflowVideoFrames') return { resolveVideoCardOutputs: async () => {} };
      if (specifier === './workflowAgentOutputs') return { agentWriterValue: () => undefined };
      if (real.has(specifier.replace(/^\.\//, '').replace(/\.ts$/, ''))) {
        return load(resolve(dirname(path), specifier.endsWith('.ts') ? specifier : `${specifier}.ts`));
      }
      return {};
    };
    vm.runInContext(`(function(require,module,exports){${code}\n})`, context, { filename: path })(require, module, module.exports);
    return module.exports;
  }
  const { CanvasWorkflowController } = load(resolve(lib, 'canvasWorkflowRuntime.ts'));
  const helpers = load(resolve(lib, 'canvasWorkflow.ts'));
  const loops = load(resolve(lib, 'workflowLoop.ts'));
  return { controller: new CanvasWorkflowController('p'), newController: () => new CanvasWorkflowController('p'),
    helpers, loops, account, calls, saved: () => clone(saved) };
}

function readyInputs(f) {
  const nodes = f.controller.document.nodes;
  const loop = nodes.find(node => node.kind === 'loop');
  loop.outputs = f.loops.workflowLoopOutputs(f.loops.workflowLoopItems(loop, nodes, [])[0], 0);
  for (const node of nodes.filter(node => node.kind === 'generation')) {
    node.outputs = { image: { type: 'image', assetIds: [`generated-${node.id}`] } };
  }
}
const h3Cards = nodes => nodes.filter(node => node.kind === 'comfy-video');
const nativeCalls = f => f.calls.filter(call => call.command.startsWith('comfy_'));

test('Rust-created H3 graph loads, saves, reloads and remains unstarted', async () => {
  const f = fixture(), c = f.controller;
  await c.load(); assert.equal(c.error, '');
  const cards = h3Cards(c.document.nodes);
  assert.equal(cards.length, 2);
  for (const card of cards) {
    assert.deepEqual(plain(f.helpers.workflowInputs(card)).map(port => port.id), ['first-frame', 'last-frame', 'text']);
    assert.deepEqual(plain(f.helpers.workflowOutputs(card)), [{ id: 'image', label: '视频', type: 'image' }]);
    assert.equal(f.helpers.workflowTitle(card), '本地 H3 视频');
    assert.equal(f.helpers.workflowCardWidth(card), 416);
    for (const [port, bindings] of Object.entries(card.inputs)) for (const input of bindings) {
      if (input.nodeId) assert.equal(f.helpers.workflowConnectionError(c.document.nodes, input.nodeId, input.portId, card.id, port), null);
    }
  }
  const trigger = c.document.nodes.find(node => node.kind === 'trigger' && c.document.nodes.some(target => target.inputs.signal?.some(input => input.nodeId === node.id)));
  assert.ok(trigger, 'fixture includes a trigger with an outgoing signal');
  const order = f.helpers.workflowOrder(c.document.nodes, trigger.id);
  const loop = f.loops.workflowLoopScope(f.helpers.workflowExecutionNodes(c.document.nodes, trigger.id), order);
  for (const card of cards) assert.ok(loop.bodyIds.includes(card.id));
  await c.save();
  const reloaded = f.newController(); await reloaded.load();
  assert.equal(reloaded.error, '');
  assert.deepEqual(plain(h3Cards(reloaded.document.nodes)), plain(cards));
  assert.equal(reloaded.document.run, null);
  assert.equal(nativeCalls(f).length, 0);
  assert.equal(f.calls.filter(call => call.command === 'authorize').length, 0);
});

test('explicit H3 run resolves attached frames and content; recovery only queries the original task', async () => {
  const f = fixture(), c = f.controller; await c.load(); readyInputs(f);
  const card = h3Cards(c.document.nodes).find(node => node.inputs['first-frame']?.[0]?.assetId);
  assert.ok(card?.inputs['last-frame']?.[0]?.assetId);
  const expectedText = card.inputs.text.flatMap(input => input.canvasNodeId
    ? JSON.parse(example.notes.find(note => note.id === input.canvasNodeId).payloadJson).cells.flat().map(cell => cell.text)
    : [c.document.nodes.find(node => node.id === input.nodeId).outputs[input.portId].text]).filter(Boolean);
  await c.start(card.id, true);
  const start = nativeCalls(f).find(call => call.command === 'comfy_video' && call.args.action === 'start');
  assert.ok(start, c.issue?.message ?? 'explicit run must reach the H3 transport');
  assert.equal(start.args.input.firstFrame, card.inputs['first-frame'][0].assetId);
  assert.equal(start.args.input.lastFrame, card.inputs['last-frame'][0].assetId);
  assert.equal(start.args.input.seconds, card.comfyVideo.seconds);
  assert.equal(start.args.input.ratio, card.comfyVideo.ratio);
  assert.equal(start.args.input.resolution, card.comfyVideo.resolution);
  assert.equal(start.args.input.endpoint, 'http://127.0.0.1:18189');
  assert.ok(start.args.input.prompt.includes(card.prompt));
  for (const text of expectedText) assert.ok(start.args.input.prompt.includes(text));
  assert.equal(f.saved().document.run.status, 'waiting');
  const count = nativeCalls(f).length, restored = f.newController(); await restored.load();
  assert.equal(nativeCalls(f).length, count, 'reload cannot submit or prepare H3');
  await restored.continue();
  const resumed = nativeCalls(f).slice(count);
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].command, 'comfy_video');
  assert.equal(resumed[0].args.action, 'status');
  assert.equal(resumed[0].args.requestId, start.args.requestId);
});

test('H3 resolves a generation output as its first frame without submitting that generator', async () => {
  const f = fixture(), c = f.controller; await c.load(); readyInputs(f);
  const card = h3Cards(c.document.nodes).find(node => node.inputs['first-frame']?.[0]?.nodeId);
  assert.ok(card);
  const source = c.document.nodes.find(node => node.id === card.inputs['first-frame'][0].nodeId);
  await c.start(card.id, true);
  const starts = nativeCalls(f).filter(call => call.command === 'comfy_video' && call.args.action === 'start');
  assert.equal(starts.length, 1, c.issue?.message);
  assert.equal(starts[0].args.input.firstFrame, source.outputs.image.assetIds[0]);
  assert.deepEqual(plain(f.saved().document.run.order), [card.id]);
});

test('an unfilled H3 draft loads but explicit execution requires a first frame and current H3 entitlement', async () => {
  for (const missing of ['frame', 'entitlement']) {
    const f = fixture(), c = f.controller; await c.load(); readyInputs(f);
    const card = h3Cards(c.document.nodes).find(node => node.inputs['first-frame']?.[0]?.assetId);
    if (missing === 'frame') card.inputs['first-frame'] = [];
    else f.account.cloudEntitlement.offline_state = 'expired';
    await c.save();
    assert.equal(nativeCalls(f).length, 0);
    await c.start(card.id, true);
    assert.match(c.issue?.message ?? '', missing === 'frame' ? /首帧/ : /Pro／Studio/);
    assert.equal(nativeCalls(f).length, 0, 'invalid drafts cannot prepare or submit local video');
  }
});
