import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canvasConversationCards } from '../src/lib/canvasConversationCards.ts';

const prompt = (id, job, turn, time = 1, projectId = 'p') => ({ id, projectId, kind: 'prompt', createdAt: time, hiddenAt: null, payloadJson: JSON.stringify({job_id: job, turn_key: turn}) });
const output = (id, job, turn, time = 1) => ({...prompt(id, job, turn, time), kind: 'asset', role: 'output', assetId: id, payloadJson: JSON.stringify({execution: {job_id: job, turn_key: turn}})});

test('continuations and provider handoffs share one stable card, independent conversations stay separate', () => {
  const first = prompt('first','job','one');
  const next = prompt('next','job','two',2);
  const handoff = prompt('handoff','other','three',3);
  const nodes = [first, output('a','job','one'), next, output('b','job','two',2), handoff, output('c','other','three',3), prompt('independent','new','one'), prompt('other-project','job','one',1,'elsewhere')];
  const result = canvasConversationCards(nodes, {job:{conversationId:'conversation'}, other:{conversationId:'conversation'}});
  assert.equal(result.cards.size,3);
  assert.equal(result.cards.get('first').latest.id,'handoff');
  assert.deepEqual(result.cards.get('first').outputs.map(n=>n.id),['a','b','c']);
  assert.deepEqual([...result.hiddenIds].sort(),['a','b','c','handoff','next']);
  assert.equal(result.aliases.get('b'),'first');
  assert.deepEqual(canvasConversationCards(structuredClone(nodes), {job:{conversationId:'conversation'},other:{conversationId:'conversation'}}),result);
});

test('hidden, workflow-owned, contained and reference instances keep their own visibility rules', () => {
  const nodes = [prompt('session','job','one'),prompt('workflow','owned','one'),output('a','job','one'),output('b','job','one'),output('owned-image','owned','one'),{...output('reference','job','one'),role:'reference'}, {...output('removed','job','one'),hiddenAt:2}];
  const result = canvasConversationCards(nodes, {}, new Set(['workflow']), new Set(['b']));
  assert.deepEqual(result.cards.get('session').outputs.map(n=>n.id),['a']);
  assert.deepEqual([...result.hiddenIds],['a']);
  assert.equal(result.cards.has('workflow'),false);
});


test('embedded session hides its whole conversation until the cell or container is removed', () => {
  const first = prompt('first','job','one'), next = prompt('next','job','two',2);
  const table = { id:'table', projectId:'p', kind:'note', hiddenAt:null, payloadJson:JSON.stringify({cells:[[{id:'cell',content_type:'image',text:'',generation_ref:{session_node_id:'first'}}]]}) };
  const nodes = [first, output('a','job','one'), next, output('b','job','two',2), table];
  assert.deepEqual([...canvasConversationCards(nodes, {}).hiddenIds].sort(),['a','b','first','next']);
  assert.equal(canvasConversationCards(nodes.map(node=>node.id==='table'?{...table,hiddenAt:1}:node),{}).hiddenIds.has('first'),false);
  assert.equal(canvasConversationCards(nodes.map(node=>node.id==='table'?{...table,payloadJson:JSON.stringify({cells:[[{id:'cell',content_type:'image',text:'',image_refs:[{asset_id:'a',token:'@图片1'}]}]]})}:node),{}).hiddenIds.has('first'),false);
});

test('content routing hides pending and replaced workflow turns while keeping exact embedded targets', () => {
  const first = prompt('first', 'old-job', 'one'), next = prompt('next', 'new-job', 'two', 2);
  const ordinary = prompt('ordinary', 'ordinary-job', 'one');
  const nodes = [first, output('old-image', 'old-job', 'one'), next, ordinary];
  const routed = new Set(['first', 'next']);
  const pending = canvasConversationCards(nodes, {}, new Set(), new Set(), routed);
  assert.equal(pending.hiddenIds.has('next'), true, 'new native session does not appear before cell delivery');
  assert.equal(pending.hiddenIds.has('first'), true, 'replaced turn stays in history');
  assert.equal(pending.hiddenIds.has('ordinary'), false);
  assert.equal(pending.cards.get('first').outputs[0].id, 'old-image', 'history still has its pixels');
  const table = { id: 'table', kind: 'note', hiddenAt: null, payloadJson: JSON.stringify({ cells: [[{ id: 'cell', content_type: 'image', generation_ref: { session_node_id: 'next' } }]] }) };
  const embedded = canvasConversationCards([...nodes, table], {}, new Set(), new Set(), routed);
  assert.deepEqual(embedded.embedded.get('next'), { nodeId: 'table', cellId: 'cell' });
  assert.equal(embedded.embedded.has('first'), false, 'old turn cannot inherit the new turn cell');
  const disconnected = canvasConversationCards([...nodes, table], {});
  assert.equal(disconnected.hiddenIds.has('first'), false, 'removing routing returns uncontained history');
  assert.equal(disconnected.hiddenIds.has('next'), true, 'stored cell keeps its session after disconnect');
});
