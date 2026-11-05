import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newWorkflowNode, generationInputNode, compileGenerationPrompt, compileAgentPrompt, workflowOrder, workflowInputValues } from '../src/lib/canvasWorkflow.ts';
import { planAutomaticConnection } from '../src/lib/workflowAutoConnect.ts';

const node = (id, kind = 'generation', rest = {}) => ({ ...newWorkflowNode(kind, 0, 0, 'codex'), id, ...rest });
const documentOutputs = [
  { type: 'text', binding: { canvasNodeId: 'document', cellId: '*text' } },
  { type: 'image', media: 'image', binding: { canvasNodeId: 'document', cellId: '*' } },
];
const source = (id, media = 'image') => ({ type: 'image', media, binding: { assetId: id, assetNodeId: `card-${id}` } });
const connect = (target, outputs) => {
  const plan = planAutomaticConnection([target], outputs, target.id);
  assert.equal(plan.error, null);
  const inputs = { ...target.inputs };
  for (const { inputId, binding } of plan.bindings) inputs[inputId] = [...(inputs[inputId] ?? []), { ...binding, autoConnect: 'one-wire' }];
  return { ...target, inputs };
};

test('completion accepts separate native conversations, deduplicates each and rejects content cards', () => {
  const first = { type: 'image', binding: { canvasNodeId: 'conversation-1', cellId: 'image' } };
  const second = { type: 'image', binding: { canvasNodeId: 'conversation-2', cellId: 'image' } };
  const target = connect(node('trigger', 'trigger'), [first]);
  assert.equal(target.inputs.completion[0].canvasNodeId, 'conversation-1');
  assert.deepEqual(planAutomaticConnection([target], [first], target.id), { bindings: [], error: null });
  assert.equal(planAutomaticConnection([target], [second], target.id).bindings[0].binding.canvasNodeId, 'conversation-2');
  assert.match(planAutomaticConnection([target], documentOutputs, target.id).error, /不能接收/);
});

test('whole card graph plans only the intersection and never mutates the document', () => {
  const target = node('target', 'instruction');
  const before = JSON.stringify(target);
  const plan = planAutomaticConnection([target], documentOutputs, 'target');
  assert.equal(plan.error, null);
  assert.deepEqual(plan.bindings.map(item => [item.inputId, item.binding.cellId]), [['image', '*']]);
  assert.equal(JSON.stringify(target), before);
  const both = planAutomaticConnection([node('both')], documentOutputs, 'both');
  assert.deepEqual(both.bindings.map(item => item.inputId), ['text', 'image']);
});

test('prewiring a producer without results succeeds, empty result fails at compilation', () => {
  const producer = node('source', 'instruction', { action: 'reuse' });
  const target = node('target');
  const plan = planAutomaticConnection([producer, target], [
    { type: 'text', binding: { nodeId: 'source', portId: 'text' } },
    { type: 'image', binding: { nodeId: 'source', portId: 'image' } },
  ], 'target');
  assert.equal(plan.error, null);
  assert.equal(plan.bindings.length, 2);
  const connected = connect(target, documentOutputs);
  assert.throws(() => compileGenerationPrompt(connected, { text: [{ type: 'text', text: '' }], image: [{ type: 'image', assetIds: ['a'] }] }), /没有可用内容/);
});

test('text only receivers ignore image output without asking', () => {
  const target = node('loop', 'loop', { loopMode: 'rows' });
  const plan = planAutomaticConnection([target], documentOutputs, 'loop');
  assert.deepEqual(plan.bindings.map(item => item.inputId), ['text']);
});

test('new connections compile current text and deduplicate the same image from both projections', () => {
  const target = connect(node('target', 'generation', { prompt: '照此构图，使用暖色' }), documentOutputs);
  const values = { text: [{ type: 'text', text: '主体参考 @图片1', assetIds: ['a'], imageRefs: [{ token: '@图片1', asset_id: 'a' }] }], image: [{ type: 'image', assetIds: ['a', 'b'] }] };
  assert.equal(generationInputNode(target).inputs.text.length, 1);
  assert.equal(generationInputNode(target).inputs.image.length, 1);
  const compiled = compileGenerationPrompt(target, values);
  assert.equal(compiled.prompt, '照此构图，使用暖色\n\n【参考文本】\n主体参考 @图片1');
  assert.deepEqual(compiled.assetIds, ['a', 'b']);
  assert.equal(target.prompt, '照此构图，使用暖色');
});

test('upstream text can be the complete prompt without a manual token', () => {
  const target = connect(node('target'), [documentOutputs[0]]);
  assert.deepEqual(compileGenerationPrompt(target, { text: [{ type: 'text', text: '生成一片森林' }] }), { prompt: '生成一片森林', assetIds: [] });
});

test('explicit mention of an automatic source places it once and preserves numbering', () => {
  let target = connect(node('target', 'generation', { prompt: '@[photo] 然后 @[body]' }), documentOutputs);
  target.promptReferences = [
    { id: 'photo', type: 'image', label: '图片来源 1', input: target.inputs.image[0] },
    { id: 'body', type: 'text', label: '文本 1', input: target.inputs.text[0] },
  ];
  const values = { text: [{ type: 'text', text: '参考 @图片1', assetIds: ['a'], imageRefs: [{ token: '@图片1', asset_id: 'a' }] }], image: [{ type: 'image', assetIds: ['b', 'a'] }] };
  const compiled = compileGenerationPrompt(target, values);
  assert.equal(compiled.prompt, '@图片1 @图片2 然后 参考 @图片2');
  assert.deepEqual(compiled.assetIds, ['b', 'a']);
});

test('legacy unmentioned connections stay inactive while automatic dependencies enter the run', () => {
  const producer = node('source', 'instruction', { action: 'reuse' });
  const target = node('target', 'generation', { prompt: '原指令', inputs: { text: [{ nodeId: 'source', portId: 'text' }] } });
  assert.deepEqual(generationInputNode(target).inputs.text, []);
  assert.deepEqual(workflowOrder([producer, target], 'target'), ['target']);
  const automatic = { ...target, inputs: { text: [{ ...target.inputs.text[0], autoConnect: 'wire' }] } };
  assert.deepEqual(workflowOrder([producer, automatic], 'target'), ['source', 'target']);
  assert.equal(generationInputNode(automatic).inputs.text.length, 1);
});

test('automatic cloud Agent inputs are included once, legacy cloud references remain explicit', () => {
  const target = connect(node('target', 'agent', { agentTransport: 'cloud', prompt: '分析参考' }), documentOutputs);
  const values = { text: [{ type: 'text', text: '正文' }], image: [{ type: 'image', assetIds: ['a'] }] };
  assert.deepEqual(JSON.parse(compileAgentPrompt(target, values).source), { '引用文本 1': '正文' });
  assert.deepEqual(compileAgentPrompt(target, values).assetIds, ['a']);
  const mentioned = { ...target, prompt: '@[body]', promptReferences: [{ id: 'body', type: 'text', label: '文本 1', input: target.inputs.text[0] }] };
  assert.deepEqual(JSON.parse(compileAgentPrompt(mentioned, values).source), { '引用文本 1': '正文' });
  const legacy = { ...target, inputs: { text: [{ ...documentOutputs[0].binding }] } };
  assert.deepEqual(JSON.parse(compileAgentPrompt(legacy, {}).source), {});
});

test('video and audio match capability, never the legacy image pipe name', () => {
  const image = node('image');
  assert.match(planAutomaticConnection([image], [source('video', 'video')], 'image').error, /不能接收/);
  const video = node('video', 'generation', { generation: { media: 'video' } });
  assert.equal(planAutomaticConnection([video], [source('movie', 'video'), source('audio', 'audio')], 'video').bindings.length, 2);
  const frames = { ...video, generation: { media: 'video', videoOptions: { kind: 'frames2video' } } };
  assert.match(planAutomaticConnection([frames], [source('movie', 'video')], 'video').error, /不能接收/);
  const producer = node('movie', 'generation', { generation: { media: 'video' } });
  assert.match(planAutomaticConnection([producer, image], [{ type: 'image', binding: { nodeId: 'movie', portId: 'image' } }], 'image').error, /不能接收/);
});

test('mixed and unknown containers bind a media projection for execution-time filtering', () => {
  const target = node('target');
  for (const media of [undefined, ['image', 'video', 'audio']]) {
    const plan = planAutomaticConnection([target], [{ type: 'image', media, binding: { canvasNodeId: 'table', cellId: '*' } }], 'target');
    assert.equal(plan.error, null);
    assert.deepEqual(plan.bindings[0].binding.mediaFilter, ['image']);
  }
});

test('H3 fills the first free frame, repeated source is a no-op, full frames reject atomically', () => {
  const empty = node('h3', 'comfy-video');
  const first = connect(empty, [source('a')]);
  assert.equal(first.inputs['first-frame'][0].assetId, 'a');
  assert.deepEqual(planAutomaticConnection([first], [source('a')], 'h3'), { bindings: [], error: null });
  const full = connect(first, [source('b')]);
  assert.equal(full.inputs['last-frame'][0].assetId, 'b');
  const rejected = planAutomaticConnection([full], [documentOutputs[0], source('c')], 'h3');
  assert.deepEqual(rejected.bindings, []);
  assert.match(rejected.error, /首尾帧已连接/);
});

test('cycles and self-connections reject the entire planned relation', () => {
  const a = node('a', 'skill', { inputs: { image: [{ nodeId: 'b', portId: 'image' }] } });
  const b = node('b', 'skill');
  const output = { type: 'image', binding: { nodeId: 'a', portId: 'image' } };
  assert.match(planAutomaticConnection([a, b], [output], 'a').error, /自身/);
  assert.match(planAutomaticConnection([a, b], [output], 'b').error, /循环/);
  const writer = node('writer', 'text', { textTarget: { nodeId: 'table', cellId: 'cell', image: true }, inputs: { image: [{ nodeId: 'b', portId: 'image' }] } });
  assert.match(planAutomaticConnection([b, writer], [{ type: 'image', binding: { canvasNodeId: 'table', cellId: '*' } }], 'b').error, /循环/);
});

test('media-filtered instruction values defer count validation until asset filtering', () => {
  const target = connect(node('target', 'instruction', { action: 'reuse' }), [{ type: 'image', media: ['image', 'video'], binding: { canvasNodeId: 'table', cellId: '*' } }]);
  assert.equal(workflowInputValues([target], target, () => ({ type: 'image', assetIds: ['photo', 'video'] })).image[0].assetIds.length, 2);
});

test('completion observes video output without media filtering and deduplicates each producer', () => {
  const movie = node('movie', 'generation', { generation: { media: 'video' } });
  const trigger = node('trigger', 'trigger');
  const output = { type: 'image', media: 'video', binding: { nodeId: 'movie', portId: 'image' } };
  const plan = planAutomaticConnection([movie, trigger], [output], 'trigger');
  assert.equal(plan.error, null);
  assert.equal(plan.bindings[0].inputId, 'completion');
  assert.equal(plan.bindings[0].binding.mediaFilter, undefined);
  const multi = node('multi', 'instruction', { action: 'reuse' });
  const connected = { ...trigger, inputs: { completion: [{ nodeId: 'multi', portId: 'text' }] } };
  assert.deepEqual(planAutomaticConnection([multi, connected], [
    { type: 'text', binding: { nodeId: 'multi', portId: 'text' } },
    { type: 'image', binding: { nodeId: 'multi', portId: 'image' } },
  ], 'trigger'), { bindings: [], error: null });
});
