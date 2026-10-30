import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

// The fixtures are exported by the actual Rust compiler and transaction. Native
// storage is isolated here; the UI fixture separately checks rendered bounds.
const lib = fileURLToPath(new URL('../src/lib/', import.meta.url));
const fixturePath = process.env.BOWERBIRD_CARD_FIXTURES
  ?? fileURLToPath(new URL('../.tmp/local-chat/section-card-fixtures.json', import.meta.url));
const examples = JSON.parse(readFileSync(fixturePath, 'utf8'));
assert.ok(examples.sections?.workflow?.document, 'export the Rust sections fixture first');
assert.ok(examples.sections_large?.workflow?.document, 'export the Rust large sections fixture first');
const plain = value => JSON.parse(JSON.stringify(value));
const clone = value => structuredClone(value);
const nativeNote = note => ({ ...note, payloadJson: note.payloadJson ?? note.payload_json });
const intersects = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x
  && a.y < b.y + b.height && a.y + a.height > b.y;

// Use the production renderer's minimum height expression rather than a second
// set of card sizes in this test. Long-content DOM height is checked in the UI.
const layerPath = resolve(lib, '../components/CanvasWorkflowLayer.tsx');
const layer = ts.createSourceFile(layerPath, readFileSync(layerPath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let heightExpression;
function findHeight(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(layer) === 'height'
    && node.initializer?.getText(layer).includes('inputPorts.length')) heightExpression = node.initializer.getText(layer);
  ts.forEachChild(node, findHeight);
}
findHeight(layer);
assert.ok(heightExpression, 'production workflow card minimum height is present');

function fixture(example, initial = example.workflow) {
  let saved = clone(initial), notes = example.notes.map(nativeNote);
  const calls = [], modules = new Map();
  const api = {
    canvasWorkflowGet: async () => clone(saved),
    projectCanvasGet: async () => ({ nodes: clone(notes), groups: [], groupItems: [] }),
    canvasWorkflowSave: async (_id, revision, document) => {
      assert.equal(revision, saved.revision);
      saved = { revision: revision + 1, document: clone(document) };
      return saved.revision;
    },
    canvasWorkflowAuthorize: async () => { calls.push('authorize'); },
    getAssetsByIds: async ids => ids.map(id => ({ id, store_path: `${id}.png` })),
  };
  const real = new Set(['canvasWorkflow', 'workflowExternalChanges', 'canvasCardNames', 'workflowDiagnostics',
    'contentTable', 'canvasNotes', 'canvasLogic', 'canvasSessionOutputs', 'canvasConversationCards', 'comfyVideo', 'videoGeneration']);
  const context = vm.createContext({ console, crypto: webcrypto, structuredClone, setTimeout, clearTimeout });
  function load(path) {
    if (modules.has(path)) return modules.get(path).exports;
    const module = { exports: {} }; modules.set(path, module);
    const output = ts.transpileModule(readFileSync(path, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const require = specifier => {
      if (specifier === './api') return { api };
      if (specifier === '../store') return { useStore: { getState: () => ({ genJobs: {} }) } };
      if (specifier === '@tauri-apps/api/core') return { invoke: async command => {
        calls.push(command); throw new Error(`unexpected native execution: ${command}`);
      } };
      if (specifier === '@tauri-apps/api/event') return { emit: async () => {} };
      if (specifier === './workflowPlannerRuntime') return { WorkflowPlannerRuntime: class {} };
      if (specifier === './workflowVideoFrames') return { resolveVideoCardOutputs: async () => {} };
      if (specifier === './workflowAgentOutputs') return { agentWriterValue: () => undefined };
      if (real.has(specifier.replace(/^\.\//, '').replace(/\.ts$/, ''))) {
        return load(resolve(dirname(path), specifier.endsWith('.ts') ? specifier : `${specifier}.ts`));
      }
      return {};
    };
    vm.runInContext(`(function(require,module,exports){${output}\n})`, context, { filename: path })(require, module, module.exports);
    return module.exports;
  }
  const { CanvasWorkflowController } = load(resolve(lib, 'canvasWorkflowRuntime.ts'));
  const helpers = load(resolve(lib, 'canvasWorkflow.ts'));
  const notesApi = load(resolve(lib, 'canvasNotes.ts'));
  const geometry = load(resolve(lib, 'canvasLogic.ts'));
  function rect(node) {
    if (node.kind === 'note') {
      const note = notesApi.readCanvasNote(node);
      const minimum = note.note_type === 'section' ? node : notesApi.canvasTextMinSize(note.cells);
      return { id: node.id, x: node.x, y: node.y, width: Math.max(node.width, minimum.width), height: Math.max(node.height, minimum.height) };
    }
    const height = vm.runInNewContext(heightExpression, { node, inputPorts: helpers.workflowInputs(node), outputPorts: helpers.workflowOutputs(node) });
    return { id: node.id, x: node.x, y: node.y, width: helpers.workflowCardWidth(node), height };
  }
  return { controller: new CanvasWorkflowController('p'), newController: () => new CanvasWorkflowController('p'),
    notesApi, geometry, rect, calls, notes: () => clone(notes), saved: () => clone(saved),
    external: (workflow, updatedNotes) => { saved = clone(workflow); notes = updatedNotes.map(nativeNote); } };
}

for (const key of ['sections', 'sections_large']) {
  const example = examples[key];
  test(`${key}: native sections preserve explicit members and contain card bodies and names`, () => {
    const f = fixture(example), notes = f.notes();
    const sections = notes.filter(note => f.notesApi.readCanvasNote(note).note_type === 'section');
    assert.equal(sections.length, example.args.sections.length);
    assert.equal(example.action.cards.length, example.args.cards.length + sections.length);
    const aliases = new Map(example.action.cards.map(card => [card.alias, card.id]));
    const cards = [...notes.filter(note => !sections.some(section => section.id === note.id)), ...example.workflow.document.nodes];
    const anchors = cards.map(card => ({ id: card.id, rect: f.rect(card) }));
    const membership = new Set();
    for (const spec of example.args.sections) {
      const section = sections.find(note => note.id === aliases.get(spec.id));
      assert.ok(section, spec.id);
      const value = f.notesApi.readCanvasNote(section), expected = spec.members.map(alias => aliases.get(alias));
      assert.deepEqual(plain(value.member_ids), expected);
      assert.deepEqual(plain(value.cells), []);
      assert.equal(value.workflow_container, undefined);
      assert.equal(value.artboard, undefined);
      assert.equal(value.text, example.workflow.document.cardNames[section.id]);
      assert.deepEqual(new Set(f.notesApi.canvasSectionMembers(section, anchors)), new Set(expected), 'geometry encloses only its explicit members');
      for (const id of expected) {
        assert.ok(!membership.has(id), 'each card has one moving parent'); membership.add(id);
        const body = anchors.find(anchor => anchor.id === id).rect;
        const withName = { ...body, y: body.y - 28, height: body.height + 28 };
        assert.deepEqual(plain(f.notesApi.canvasSectionMembers(section, [{ id, rect: withName }])), [id], 'card title stays inside frame');
      }
    }
    const outside = anchors.filter(anchor => !membership.has(anchor.id));
    assert.ok(outside.length, 'fixture contains an unassigned card');
    for (const [index, section] of sections.entries()) {
      for (const other of sections.slice(index + 1)) assert.equal(intersects(section, other), false, 'section frames cannot overlap');
      for (const card of outside) assert.equal(intersects(section, card.rect), false, 'unassigned cards remain outside frames');
    }
    for (const [index, card] of anchors.entries()) for (const other of anchors.slice(index + 1)) {
      assert.equal(intersects(card.rect, other.rect), false, `${card.id} and ${other.id} must not overlap`);
    }
    if (key === 'sections_large') {
      const large = cards.find(card => card.kind === 'note' && f.notesApi.readCanvasNote(card).cells.length === 100);
      assert.ok(large, 'fixture has a 100-row table');
      assert.equal(f.notesApi.readCanvasNote(large).cells[0].length, 12);
      assert.ok(large.height >= f.notesApi.canvasTextMinSize(f.notesApi.readCanvasNote(large).cells).height, 'stored bounds include the native table minimum');
    }
  });

  test(`${key}: dragging a section expands its membership without moving unrelated cards`, () => {
    const f = fixture(example), notes = f.notes();
    const section = notes.find(note => f.notesApi.readCanvasNote(note).note_type === 'section');
    const members = f.notesApi.readCanvasNote(section).member_ids;
    const expanded = f.notesApi.expandCanvasSections(new Set([section.id]), notes);
    assert.deepEqual(new Set(expanded), new Set([section.id, ...members]));
    const all = [...notes, ...example.workflow.document.nodes];
    const moved = f.geometry.translateCanvasSelection(all, expanded, 143, -87);
    for (const original of all) {
      const next = moved.find(card => card.id === original.id), selected = expanded.has(original.id);
      assert.equal(next.x, original.x + (selected ? 143 : 0));
      assert.equal(next.y, original.y - (selected ? 87 : 0));
      if (!selected) assert.equal(next, original, 'unrelated cards retain their identities');
    }
    const member = members[0];
    assert.deepEqual([...f.notesApi.expandCanvasSections(new Set([member]), notes)], [member], 'selecting one member does not select its frame or siblings');
    const removed = notes.filter(note => note.id !== section.id);
    assert.deepEqual([...f.notesApi.expandCanvasSections(new Set([section.id]), removed)], [section.id], 'removing a frame leaves its cards independent');
    assert.equal(removed.length, notes.length - 1);
  });

  test(`${key}: load, save and reload retain sections and names without starting any work`, async () => {
    const f = fixture(example), c = f.controller, beforeNotes = plain(f.notes());
    await c.load(); assert.equal(c.error, '');
    assert.deepEqual(plain(c.document.cardNames), example.workflow.document.cardNames);
    await c.save();
    const reloaded = f.newController(); await reloaded.load(); assert.equal(reloaded.error, '');
    assert.deepEqual(plain(reloaded.document.nodes), plain(c.document.nodes));
    assert.deepEqual(plain(reloaded.document.cardNames), example.workflow.document.cardNames);
    assert.deepEqual(plain(f.notes()), beforeNotes);
    assert.equal(reloaded.document.run, null);
    assert.deepEqual(plain(reloaded.document.runs), []);
    assert.deepEqual(f.calls, [], 'loading or arranging cannot authorize, install, generate, or invoke a native execution command');
  });
}

test('external section creation and undo refresh workflow names without resurrecting notes', async () => {
  const example = examples.sections;
  const empty = { revision: example.workflow.revision - 1, document: { schema_version: 1, nodes: [], run: null } };
  const f = fixture(example, empty); f.external(empty, []);
  const c = f.controller; await c.load(); assert.equal(c.error, '');
  f.external(example.workflow, example.notes);
  await c.refreshExternalCards(); await c.save();
  assert.deepEqual(plain(c.document.cardNames), example.workflow.document.cardNames);
  assert.equal(f.notes().filter(note => f.notesApi.readCanvasNote(note).note_type === 'section').length, example.args.sections.length);
  const undone = { revision: f.saved().revision + 1, document: { schema_version: 1, nodes: [], cardNames: {}, run: null, runs: [] } };
  f.external(undone, []);
  await c.refreshExternalCards(); await c.save();
  assert.deepEqual(plain(f.saved().document.nodes), []);
  assert.deepEqual(plain(f.saved().document.cardNames), {});
  assert.deepEqual(f.notes(), []);
  assert.deepEqual(f.calls, []);
});
