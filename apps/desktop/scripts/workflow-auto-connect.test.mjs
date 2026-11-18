import { restoreImageOptimization } from '../src/lib/h3PromptOptimization.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newWorkflowNode, generationInputNode, compileGenerationPrompt, compileAgentPrompt, workflowOrder, workflowInputValues, selectWorkflowVideoProvider } from '../src/lib/canvasWorkflow.ts';
import { planAutomaticConnection } from '../src/lib/workflowAutoConnect.ts';

const node = (id, kind = 'generation', rest = {}) => ({ ...newWorkflowNode(kind, 0, 0, 'codex'), id, ...rest });
const documentOutputs = [
  { type: 'text', binding: { canvasNodeId: 'document', cellId: '*text' } },
  { type: 'image', media: 'image', binding: { canvasNodeId: 'document', cellId: '*' } },
];
const source = (id, media = 'image') => ({ type: 'image', media, binding: { assetId: id, assetNodeId: `card-${id}` } });
test('a dimension wire resolves its saved text and source image for generation and agent cards', () => {
  const image = { type: 'image', media: 'image', binding: { assetId: 'photo', assetNodeId: 'source' } };
  const outputs = [{ type: 'text', binding: { ...image.binding, dimension: { title: '构图', body: '中心构图' } } }, image];
  for (const kind of ['generation', 'agent']) {
    const target = connect(node('target', kind), outputs);
    const values = workflowInputValues([target], target);
    assert.equal(values.text[0].text, '中心构图');
    assert.deepEqual(values.image[0].assetIds, ['photo']);
  }
});
test('H3 optimizer omissions preserve the dimension and image through generation compilation', () => {
  const image = source('photo');
  const outputs = [{ type: 'text', binding: { ...image.binding, dimension: { title: '构图', body: '中心构图' } } }, image];
  const target = connect(node('generate'), outputs);
  target.promptReferences = [{ id: 'dim', type: 'text', label: '构图', input: target.inputs.text[0] }];
  for (const [prompt, result, expected, kept] of [
    ['@[dim] 秋天', '秋天的树林', '中心构图 秋天的树林', false],
    ['秋天 @[dim]', '树林 {{REF_1}} {{REF_1}}', '树林 中心构图', false],
    ['用 @[dim] 描绘树林', '树林', '用 中心构图 描绘树林', true],
    ['用 @[dim] 描绘树林', '以 {{REF_1}} 描绘森林', '以 中心构图 描绘森林', false],
    ['@[dim] 秋天', '{{REF_2}} 秋天', '中心构图 秋天', true],
  ]) {
    const restored = restoreImageOptimization(prompt, result);
    assert.equal(restored.keptOriginal, kept);
    target.prompt = restored.text;
    assert.deepEqual(compileGenerationPrompt(target, workflowInputValues([target], target)), {prompt: expected, assetIds: ['photo']});
  }
});
test('whole text table reaches the Agent through native canvas input resolution', () => {
  const agent = connect(node('reader', 'agent'), documentOutputs);
  const table = { rows: [['标题', ''], ['第一屏', '内容']] };
  const values = workflowInputValues([agent], agent, (_, port) => port === '*'
    ? { type: 'image', assetIds: [] }
    : { type: 'text', text: JSON.stringify(table), table });
  assert.deepEqual(Object.values(JSON.parse(compileAgentPrompt(agent, values).source))[0].rows, table.rows);
});
test('Agent accepts a text-only loop row on a mixed wire but still requires independent image inputs', () => {
  const binding = { nodeId: 'loop', autoConnect: 'row', slot: 1 };
  const target = node('reader', 'agent', { prompt: '读取当前行', inputs: {
    text: [{ ...binding, portId: 'text' }], image: [{ ...binding, portId: 'image' }],
  } });
  const table = { rows: [['当前行', '']] };
  const values = { text: [{ type: 'text', text: JSON.stringify(table), table }], image: [{ type: 'image', assetIds: [] }] };
  const result = compileAgentPrompt(target, values);
  assert.deepEqual(Object.values(JSON.parse(result.source))[0].rows, table.rows);
  assert.deepEqual(result.assetIds, []);
  target.inputs.image[0].autoConnect = 'separate';
  assert.throws(() => compileAgentPrompt(target, values), /没有可用图片/);
});
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
  assert.throws(() => compileGenerationPrompt(connected, { text: [{ type: 'text', text: '' }], image: [{ type: 'image', assetIds: [] }] }), /没有可用内容/);
  const imageOnly = compileGenerationPrompt({ ...connected, prompt: '使用参考图' }, { text: [{ type: 'text', text: '' }], image: [{ type: 'image', assetIds: ['a'] }] });
  assert.deepEqual(imageOnly.assetIds, ['a']);
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
  assert.throws(() => compileAgentPrompt(legacy, {}), /没有可用文字/);
  assert.deepEqual(JSON.parse(compileAgentPrompt(legacy, values).source), { '引用文本 1': '正文' });
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

test('switching a video card to H3 explains incompatible sources and accepts inputs for its active mode', () => {
  const video = node('target', 'generation', { generation: { media: 'video' } });
  const local = selectWorkflowVideoProvider(video, 'h3');
  const movie = node('movie', 'generation', { generation: { media: 'video' } });
  const videoOutput = { type: 'image', binding: { nodeId: 'movie', portId: 'image' } };
  for (const mode of ['frames', 'reference', 'text']) {
    const target = { ...local, comfyVideo: { ...local.comfyVideo, mode } };
    const plan = (...outputs) => planAutomaticConnection([movie, target], outputs, target.id);
    assert.deepEqual(plan(...documentOutputs).bindings.map(item => item.inputId),
      mode === 'text' ? ['text'] : ['text', 'first-frame']);
    if (mode === 'text') {
      assert.match(plan(source('photo')).error, /文生视频.*单图.*首尾帧/);
    } else {
      assert.match(plan(videoOutput).error, /从视频中截取/);
      assert.match(plan(source('music', 'audio')).error, /音频/);
    }
    const audioWithText = plan(source('music', 'audio'), documentOutputs[0]);
    assert.equal(audioWithText.error, null);
    assert.deepEqual(audioWithText.bindings.map(item => item.inputId), ['text']);
  }
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

test('a selection preserves each material wire and rejects incompatible media atomically', () => {
  const target = node('image-target');
  const images = Array.from({ length: 8 }, (_, index) => ({ ...source(String(index)), selectionWireId: 'wire-' + index }));
  const plan = planAutomaticConnection([target], images, target.id);
  assert.equal(plan.error, null);
  assert.deepEqual(plan.bindings.map(({ binding }) => binding.autoConnect), images.map(output => output.selectionWireId));
  const mixed = [...images, { ...source('audio', 'audio'), selectionWireId: 'wire-audio' }];
  const rejected = planAutomaticConnection([target], mixed, target.id);
  assert.ok(rejected.error);
  assert.deepEqual(rejected.bindings, []);
});
