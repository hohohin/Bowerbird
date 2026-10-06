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
