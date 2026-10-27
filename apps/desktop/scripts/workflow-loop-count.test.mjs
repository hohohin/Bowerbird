import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

// Production pure modules only: no browser, native storage or provider calls.
const require = createRequire(import.meta.url), modules = new Map();
function load(path) {
  if (modules.has(path)) return modules.get(path).exports;
  const module = { exports: {} }; modules.set(path, module);
  const compiled = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInThisContext(`(function(require,module,exports){${compiled}\n})`, { filename: path })(specifier => specifier.startsWith('.')
    ? load(resolve(dirname(path), extname(specifier) ? specifier : `${specifier}.ts`)) : require(specifier), module, module.exports);
  return module.exports;
}
const lib = fileURLToPath(new URL('../src/lib/', import.meta.url));
const { newWorkflowNode, workflowInputs, workflowOutputs, workflowOrder, workflowExecutionNodes, workflowInputValues, generationInputNode, compileGenerationPrompt } = load(resolve(lib, 'canvasWorkflow.ts'));
const { workflowLoopItems, workflowLoopScope, workflowLoopOutputs, validateLoopStart } = load(resolve(lib, 'workflowLoop.ts'));
const { captureWorkflowTemplate, instantiateWorkflowTemplate, templateDefinition, parseWorkflowTemplate } = load(resolve(lib, 'workflowTemplates.ts'));
const node = (id, kind) => ({ ...newWorkflowNode(kind, 0, 0, 'codex'), id });
function fixture(mode = 'count') {
  const key = node('key', 'trigger');
  const loop = { ...node('loop', 'loop'), loopMode: mode, ...(mode === 'count' ? { loopCount: 3 } : {}), inputs: { signal: [{ nodeId: key.id, portId: 'signal' }] } };
  const input = { nodeId: loop.id, portId: mode === 'count' ? 'iteration' : 'text' };
  const draw = { ...node('draw', 'generation'), prompt: '绘制 @[current]', inputs: { text: [input] }, promptReferences: [{ id: 'current', type: 'text', input, label: '当前项' }] };
  return { key, loop, draw, nodes: [key, loop, draw] };
}

test('count loops have no content inputs and expose current iteration only', () => {
  const f = fixture();
  assert.deepEqual(workflowInputs(f.loop), []);
  assert.deepEqual(workflowOutputs(f.loop), [{ id: 'iteration', label: '当前轮次', type: 'text' }]);
  assert.deepEqual(workflowLoopItems(f.loop, f.nodes, []), [1, 2, 3].map(index => ({ text: `第 ${index} 轮`, assetIds: [] })));
  for (const loopCount of [undefined, 0, 101, -1, 1.5, '3']) assert.throws(() => workflowLoopItems({ ...f.loop, loopCount }, f.nodes, []), /循环次数须为/);
  assert.equal(workflowLoopItems({ ...f.loop, loopCount: 100 }, f.nodes, []).length, 100);
});

test('trigger reaches the count loop and generation consumes each distinct iteration', () => {
  const f = fixture(), order = workflowOrder(workflowExecutionNodes(f.nodes), f.key.id);
  assert.deepEqual(order, ['key', 'loop', 'draw']);
  assert.deepEqual(workflowLoopScope(workflowExecutionNodes(f.nodes), order), { nodeId: 'loop', bodyIds: ['draw'], startIndex: 0, index: 0, completed: [] });
  const prompts = workflowLoopItems(f.loop, f.nodes, []).map((item, index) => {
    const current = { ...f.loop, outputs: workflowLoopOutputs(item, index) };
    return compileGenerationPrompt(f.draw, workflowInputValues([f.key, current, f.draw], generationInputNode(f.draw))).prompt;
  });
  assert.deepEqual(prompts, ['绘制 1', '绘制 2', '绘制 3']);
  const frozen = workflowLoopItems(f.loop, f.nodes, []);
  f.loop.loopCount = 5;
  assert.equal(frozen.length, 3);
  assert.equal(workflowLoopItems(f.loop, f.nodes, []).length, 5);
  assert.throws(() => validateLoopStart(frozen, 3, f.loop), /不能从第 4 项开始/);
});

test('rows use actual nonempty content rows in each generation prompt', () => {
  const f = fixture('rows');
  f.loop.inputs.text = [{ canvasNodeId: 'content', cellId: '*text' }];
  const card = { id: 'content', kind: 'note', hiddenAt: null, payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', text: '', cells: ['主题甲', '', '主题乙'].map((text, i) => [{ id: `cell${i}`, text, bold: false, italic: false, align: 'left' }]), member_ids: [] }) };
  const items = workflowLoopItems(f.loop, f.nodes, [card]);
  assert.equal(items.length, 2);
  const prompts = items.map((item, index) => compileGenerationPrompt(f.draw, workflowInputValues([f.key, { ...f.loop, outputs: workflowLoopOutputs(item, index) }, f.draw], generationInputNode(f.draw))).prompt);
  assert.match(prompts[0], /主题甲/); assert.match(prompts[1], /主题乙/); assert.doesNotMatch(prompts[1], /主题甲/);
});

test('template capture and reload retain count, references and definition changes', () => {
  const f = fixture();
  const template = captureWorkflowTemplate(f.nodes, new Set(f.nodes.map(node => node.id)), '循环三次');
  assert.equal(template.plan.nodes.find(node => node.kind === 'loop').loopCount, 3);
  const instantiated = instantiateWorkflowTemplate(template, {}, {}, 'codex', [], 0, 0);
  const loop = instantiated.find(node => node.kind === 'loop');
  assert.equal(loop.loopMode, 'count'); assert.equal(loop.loopCount, 3);
  assert.equal(workflowLoopItems(loop, instantiated, []).length, 3);
  assert.notEqual(templateDefinition(loop), templateDefinition({ ...loop, loopCount: 4 }));
  for (const count of [undefined, 0, 101, '3']) {
    const invalid = structuredClone(template); invalid.plan.nodes.find(node => node.kind === 'loop').loopCount = count;
    assert.throws(() => parseWorkflowTemplate(JSON.stringify(invalid)), /循环次数须为/);
  }
});
