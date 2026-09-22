import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newWorkflowNode, workflowConnectionError, workflowOrder, workflowInputValues, workflowOutputs, invalidateWorkflow } from '../src/lib/canvasWorkflow.ts';
const node = (id, kind = 'skill') => ({ ...newWorkflowNode(kind, 0, 0, 'codex'), id });

test('text relay pulls in missing visual-profile prerequisites but not their other consumers',()=>{
  const split=node('split','instruction'),describe=node('describe','instruction'),gen=node('gen','generation');
  const profile=node('profile','visual-profile'),other=node('other','generation'),source=node('source','instruction');
  describe.inputs.image=[{nodeId:'split',portId:'image'}];describe.resultNodeIds=['table'];
  gen.inputs={text:[{canvasNodeId:'table',cellId:'prompt'}],'visual-profile':[{nodeId:'profile',portId:'visual-profile'}]};
  other.inputs={'visual-profile':[{nodeId:'profile',portId:'visual-profile'}]};
  profile.inputs={image:[{nodeId:'source',portId:'image'}]};
  const nodes=[split,describe,gen,profile,other,source];
  const order=workflowOrder(nodes,'split');
  assert.equal(order.includes('other'),false);
  assert.ok(order.indexOf('source')<order.indexOf('profile'));
  assert.ok(order.indexOf('profile')<order.indexOf('gen'));
  assert.ok(order.indexOf('describe')<order.indexOf('gen'));
  profile.outputs={'visual-profile':{type:'visual-profile',profileId:'saved',version:1}};
  assert.deepEqual(workflowOrder(nodes,'split'),['split','describe','gen']);
});

test('generated text tables relay dependencies and cycle detection',()=>{
  const a=node('split','instruction'),b=node('describe','instruction'),c=node('generate','generation');
  b.inputs.image=[{nodeId:a.id,portId:'image'}];b.resultNodeIds=['table'];
  c.inputs.text=[{canvasNodeId:'table',cellId:'prompt'}];
  assert.deepEqual(workflowOrder([a,b,c],a.id),['split','describe','generate']);
  c.outputs.session={type:'session',nodeIds:['old']};
  assert.deepEqual(invalidateWorkflow([a,b,c],b.id)[2].outputs,{});
  b.inputs.text=[{canvasNodeId:'table',cellId:'prompt'}];
  assert.throws(()=>workflowOrder([a,b,c],a.id),/循环/);
});

test('generation has a session output and cannot masquerade as an image source', () => {
  const a=node('a','generation'), b=node('b');
  assert.deepEqual(workflowOutputs(a),[{id:'session',label:'会话',type:'session'}]);
  assert.match(workflowConnectionError([a,b],'a','session','b','image'),/相同类型/);
  a.outputs.image={type:'image',assetIds:['legacy']};b.inputs.image=[{nodeId:'a',portId:'image'}];
  assert.throws(()=>workflowInputValues([a,b],b),/会话输出/);
});

test('aggregate instruction ports exist before execution', () => {
  const a=node('a','instruction');
  assert.equal(workflowOutputs(a)[0].label,'提示词');
  a.action='layers';assert.equal(workflowOutputs(a)[0].label,'产物');
});
test('cell bindings resolve current text by identity and reject removed cells', () => {
  const a=node('a');a.inputs.text=[{canvasNodeId:'note',cellId:'cell-1'}];
  assert.equal(workflowInputValues([a],a,(id,cell)=>id==='note'&&cell==='cell-1'?'updated':undefined).text[0].text,'updated');
  assert.throws(()=>workflowInputValues([a],a,()=>undefined),/单元格已删除/);
});
test('typed ports reject incompatible wires, self links and transitive cycles', () => {
  const a = node('a','skill'), b = node('b','skill'), c = node('c','skill');
  b.inputs.image = [{ nodeId: 'a', portId: 'image' }]; c.inputs.image = [{ nodeId: 'b', portId: 'image' }];
  assert.match(workflowConnectionError([a,b,c], 'a', 'image', 'b', 'text'), /相同类型/);
  assert.match(workflowConnectionError([a,b,c], 'c', 'image', 'a', 'image'), /循环/);
  assert.match(workflowConnectionError([a,b,c], 'a', 'image', 'a', 'image'), /自身/);
  assert.equal(workflowConnectionError([a,b,c], 'a', 'image', 'c', 'image'), null);
});
test('key runs descendants in dependency order, not unrelated branches or coordinates', () => {
  const a = node('a'), b = node('b'), c = node('c'), d = node('d');
  b.inputs.image = [{ nodeId: 'a', portId: 'image' }]; c.inputs.image = [{ nodeId: 'a', portId: 'image' }, { nodeId: 'b', portId: 'image' }];
  assert.deepEqual(workflowOrder([c,d,b,a], 'a'), ['a','b','c']);
  assert.deepEqual(workflowOrder([a,b,c,d], 'b'), ['a','b','c']);
  a.outputs.image = { type: 'image', assetIds: ['asset-a'] };
  assert.deepEqual(workflowOrder([a,b,c,d], 'b'), ['b','c']);
});
test('changed parameters invalidate all descendants without discarding wiring', () => {
  const a = node('a'), b = node('b'), c = node('c');
  b.inputs.image = [{ nodeId:'a', portId:'image' }];
  for (const n of [a,b,c]) n.outputs.image = { type:'image',assetIds:[n.id] };
  const result = invalidateWorkflow([a,b,c], 'a');
  assert.deepEqual(result[0].outputs, {}); assert.deepEqual(result[1].outputs, {});
  assert.equal(result[2].outputs.image.assetIds[0], 'c');
  assert.deepEqual(result[1].inputs, b.inputs);
  assert.throws(() => workflowInputValues(result, result[1]), /有效结果/);
});
test('instruction requires exactly one image; generation supports multiple sources on one socket', () => {
  const a = node('a'), b = node('b', 'instruction');
  b.action = 'layers';
  a.outputs.image = { type:'image', assetIds:['a','b'] };
  b.inputs.image = [{ nodeId:'a', portId:'image' }];
  assert.throws(() => workflowInputValues([a,b], b), /恰好一张/);
  b.kind = 'generation'; assert.equal(workflowInputValues([a,b], b).image[0].assetIds.length, 2);
});
test('a deleted dynamic dimension never resolves to another output', () => {
  const a = node('a','instruction'), b = node('b');
  a.outputs['dimension-colour'] = { type:'text', text:'blue' };
  b.inputs.text = [{ nodeId:'a', portId:'dimension-layout' }];
  assert.throws(() => workflowInputValues([a,b],b), /有效结果/);
});
