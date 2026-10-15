import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentOutputTargets, routeAgentOutputs, agentWriterValue } from '../src/lib/workflowAgentOutputs.ts';

const agent = { id: 'agent', kind: 'agent', prompt: '@[copy] @[product] @[copy]', outputs: {}, promptReferences: [
  { id: 'copy', direction: 'output', type: 'image', input: { nodeId: 'w1' }, label: '文案行' },
  { id: 'product', direction: 'output', type: 'image', input: { nodeId: 'w2' }, label: '产品行' },
] };
const writers = ['w1','w2','w3'].map((id, i) => ({ id, kind: 'text', textTarget: { nodeId: 'note', cellId: `cell${i}`, image: true }, inputs: { image: [{ nodeId: 'agent', portId: 'image' }] } }));
const targets = agentOutputTargets(agent, [agent, ...writers]);
const result = deliveries => ({ text: { type: 'text', text: JSON.stringify({ format: 'bowerbird-deliveries', deliveries }) } });
const assignments = [{ target: 'output1', inputImages: [2] }, { target: 'output2', inputImages: [1] }];

test('stable writers are referenced without treating destinations as upstream inputs', () => {
  assert.equal(targets.length, 2);
  assert.equal(targets[0].cellId, 'cell0');
  assert.throws(() => agentOutputTargets(agent, [agent, writers[1]]), /已断开/);
  assert.throws(() => agentOutputTargets({ ...agent, agentTransport: 'cloud' }, [agent, ...writers]), /本机/);
});
test('classification routes actual input images independently and leaves unmentioned destinations alone', () => {
  const outputs = routeAgentOutputs(result(assignments), targets, ['product-image','copy-image']);
  const nodes = [{ ...agent, outputs }, ...writers];
  assert.deepEqual(agentWriterValue(writers[0], nodes).assetIds, ['copy-image']);
  assert.deepEqual(agentWriterValue(writers[1], nodes).assetIds, ['product-image']);
  assert.equal(agentWriterValue(writers[2], nodes), null);
  assert.throws(() => agentWriterValue({ ...writers[0], textTarget: { ...writers[0].textTarget, cellId: 'other' } }, nodes), /已改变/);
  assert.equal(agentWriterValue(writers[0], [agent, ...writers]), undefined);
});
test('invalid or partial assignments are rejected as a whole', () => {
  for (const items of [assignments.slice(0,1), [assignments[0],assignments[0]], [assignments[0],{ target:'unknown',inputImages:[1] }],
    [assignments[0],{ target:'output2',inputImages:[3] }], [assignments[0],{ target:'output2',inputImages:[0] }],
    [assignments[0],{ target:'output2',inputImages:['1'] }], [assignments[0],{ target:'output2',text:'silently lost',inputImages:[1] }]]) {
    assert.throws(() => routeAgentOutputs(result(items), targets, ['a','b']), /分配无效/);
  }
  assert.throws(() => routeAgentOutputs({text:{type:'text',text:'普通回答'}}, targets, ['a']), /未按指定/);
});
test('empty categories and mixed text/generated images have explicit values; ordinary results stay unchanged', () => {
  const outputs = routeAgentOutputs(result([{target:'output1',inputImages:[]},assignments[1]]), targets, ['a']);
  assert.deepEqual(outputs.text.deliveries.w1.value.assetIds, []);
  const textTargets = [{...targets[0],type:'text'}];
  const mixed = routeAgentOutputs({ ...result([{target:'output1',text:'文案',inputImages:[1],generatedImages:[1]}]), image:{type:'image',assetIds:['new']} }, textTargets, ['existing']);
  assert.equal(mixed.text.deliveries.w1.value.text, '文案\n@图片1 @图片2');
  assert.deepEqual(mixed.text.deliveries.w1.value.imageRefs.map(ref => ref.asset_id), ['existing','new']);
  const normal = {text:{type:'text',text:'hello'}};
  assert.equal(routeAgentOutputs(normal, [], []), normal);
});

test('directed image classification preserves independently submitted generation sessions', () => {
  const session = { type: 'session', nodeIds: ['gen-prompt:job:turn:0'] };
  const outputs = routeAgentOutputs({ ...result(assignments), session }, targets, ['product-image', 'copy-image']);
  assert.deepEqual(outputs.session, session);
  const unified = routeAgentOutputs({ ...result(assignments), image: { type: "image", nodeIds: session.nodeIds } }, targets, ["product-image", "copy-image"]);
  assert.deepEqual(unified.image.nodeIds, session.nodeIds);
  assert.deepEqual(unified.image.assetIds, ["copy-image", "product-image"]);
  assert.deepEqual(agentWriterValue(writers[0], [{ ...agent, outputs }, ...writers]).assetIds, ['copy-image']);
});
