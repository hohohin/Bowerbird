import assert from 'node:assert/strict';
import { createServer } from 'vite';

// Exercise real projection, portable copying and native-input materialization without a user library.
const server = await createServer({ configFile: false, cacheDir: '.tmp/latest-output-vite', server: { middlewareMode: true, hmr: false, watch: null } });
try {
  const { canvasInputValue, canvasWorkflowInputState } = await server.ssrLoadModule('/src/lib/canvasSessionOutputs.ts');
  const { newWorkflowNode } = await server.ssrLoadModule('/src/lib/canvasWorkflow.ts');
  const { workflowLoopItems } = await server.ssrLoadModule('/src/lib/workflowLoop.ts');
  const { captureCanvasClipboard, cloneCanvasClipboard } = await server.ssrLoadModule('/src/lib/canvasClipboard.ts');
  const { captureWorkflowTemplate, parseWorkflowTemplate, instantiateWorkflowTemplate } = await server.ssrLoadModule('/src/lib/workflowTemplates.ts');
  const { includeTemplateContent, materializeTemplateContent } = await server.ssrLoadModule('/src/lib/workflowTemplateContent.ts');
  const { api } = await server.ssrLoadModule('/src/lib/api.ts');
  const cell = (id, text = '') => ({ id, text, content_type: 'text', bold: false, italic: false, align: 'left' });
  const node = (id, kind, data) => ({ id, projectId: 'p', kind, x: 0, y: 0, width: 300, height: 200, hiddenAt: null, payloadJson: JSON.stringify(data) });
  const pending = { ...cell('pending'), content_type: 'image', generation_ref: { session_node_id: 'session-new' } };
  const note = { schema_version: 1, note_type: 'text', text: '', member_ids: [], cells: [[{ ...cell('old'), content_type: 'image', generation_ref: { session_node_id: 'session-old' } }], [cell('words', '最新说明'), pending]] };
  const table = node('table', 'note', note);
  const session = node('session-new', 'prompt', { job_id: 'job', turn_key: 'new', status: 'running' });
  const canvas = [table, session];
  const loop = { ...newWorkflowNode('loop', 0, 0, 'codex'), loopMode: 'rows', inputs: { text: [{ canvasNodeId: 'table', cellId: '*latest' }] } };
  assert.throws(() => workflowLoopItems(loop, [loop], canvas), /尚未生成完成/);
  for (const selector of ['*latest', '*latest-image']) {
    const projected = canvasInputValue(table, selector, canvas);
    assert.deepEqual(projected.nodeIds, ['session-new'], 'only last-row in-flight session is awaited');
    assert.deepEqual(projected.assetIds, []);
    assert.equal(canvasWorkflowInputState({ canvasNodeId: 'table', cellId: selector }, canvas, []), 'ready');
  }
  const output = { ...node('result-new', 'asset', { execution: { job_id: 'job', turn_key: 'new' } }), assetId: 'fresh-image', role: 'output' };
  session.payloadJson = JSON.stringify({ job_id: 'job', turn_key: 'new', status: 'done' });
  canvas.push(output);
  const text = canvasInputValue(table, '*latest', canvas);
  assert.deepEqual(text.table.rows, [['最新说明', '@图片1']]);
  assert.deepEqual(text.assetIds, ['fresh-image']);
  assert.equal(text.nodeIds, undefined);
  assert.deepEqual(canvasInputValue(table, '*latest-image', canvas).assetIds, ['fresh-image']);
  assert.deepEqual(workflowLoopItems(loop, [loop], canvas).map(item => item.assetIds), [['fresh-image']]);
  note.cells.push([cell('empty-a'), cell('empty-b')]); table.payloadJson = JSON.stringify(note);
  assert.equal(canvasInputValue(table, '*latest', canvas).text, '');
  assert.deepEqual(canvasInputValue(table, '*latest-image', canvas).assetIds, []);
  assert.equal(canvasWorkflowInputState({ canvasNodeId: 'table', cellId: '*latest' }, canvas, []), 'ready', 'empty is not a missing source');
  assert.throws(() => workflowLoopItems(loop, [loop], canvas), /循环输入为空/);
  note.cells.pop(); table.payloadJson = JSON.stringify(note);

  const textInput = { canvasNodeId: 'table', cellId: '*latest' }, imageInput = { canvasNodeId: 'table', cellId: '*latest-image' };
  const consumer = { ...newWorkflowNode('agent', 400, 0, 'codex'), id: 'consumer', inputs: { text: [textInput], image: [imageInput] } };
  const clipboard = captureCanvasClipboard('p', new Set(['table', 'consumer']), [table], [], [], [consumer]);
  const copy = cloneCanvasClipboard(clipboard, 'new-project', 0, 0);
  assert.equal(copy.workflow[0].inputs.text[0].canvasNodeId, copy.nodes[0].id);
  assert.equal(copy.workflow[0].inputs.text[0].cellId, '*latest');
  assert.equal(copy.workflow[0].inputs.image[0].cellId, '*latest-image');
  const exported = captureWorkflowTemplate([consumer], new Set(['consumer']), '输出最新');
  assert.deepEqual(exported.inputs.map(input => input.latest), [true, true]);
  assert.ok(exported.inputs.every(input => !input.whole));
  const imported = parseWorkflowTemplate(JSON.stringify(exported));
  const bindings = Object.fromEntries(imported.inputs.map(input => [input.id, { canvasNodeId: 'replacement', cellId: '*text' }]));
  const instance = instantiateWorkflowTemplate(imported, bindings, {}, 'codex', [], 0, 0);
  const agent = instance.find(node => node.kind === 'agent');
  assert.equal(agent.inputs.text[0].cellId, '*latest');
  assert.equal(agent.inputs.image[0].cellId, '*latest-image');
  assert.equal(instance[0].templateInstance.bindings[imported.inputs[0].id].cellId, '*latest');
  const bad = structuredClone(imported); bad.inputs[0].whole = true;
  assert.throws(() => parseWorkflowTemplate(JSON.stringify(bad)), /无效/);

  const blank = {}, created = [];
  api.projectCanvasNodeCreate = async card => { created.push(card); return card; };
  const materialized = await materializeTemplateContent(imported, blank, 'p', 0, 0);
  assert.equal(created.length, 2);
  assert.equal(materialized.bindings[imported.inputs[0].id].cellId, '*latest');
  assert.equal(materialized.bindings[imported.inputs[1].id].cellId, '*latest-image');
  // A carried latest row preserves its table shape instead of placing JSON into one fixed cell.
  const textOnly = captureWorkflowTemplate([{ ...consumer, inputs: { text: [textInput] } }], new Set(['consumer']), '最新图文');
  const carried = await includeTemplateContent(textOnly, { [textOnly.inputs[0].id]: text }, false, true);
  assert.deepEqual(JSON.parse(carried.inputs[0].content.text).rows, [['最新说明', '@图片1']]);
  const carriedResult = await materializeTemplateContent(carried, {}, 'p', 0, 0);
  assert.equal(JSON.parse(created.at(-1).payloadJson).cells[0].length, 2);
  assert.equal(carriedResult.bindings[carried.inputs[0].id].cellId, '*latest');
  console.log('latest output: pending/complete session projection, empty last row, clipboard identity and template capture/import/materialization passed');
} finally { await server.close(); }
