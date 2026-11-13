import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canvasConversationCards, canvasConversationGroupTarget } from '../src/lib/canvasConversationCards.ts';

const prompt = (id, job, turn, time = 1, projectId = 'p') => ({ id, projectId, kind: 'prompt', createdAt: time, hiddenAt: null, payloadJson: JSON.stringify({job_id: job, turn_key: turn}) });
const output = (id, job, turn, time = 1) => ({...prompt(id, job, turn, time), kind: 'asset', role: 'output', assetId: id, payloadJson: JSON.stringify({execution: {job_id: job, turn_key: turn}})});

test('manual galleries merge independent conversations without losing execution or absorbing copied references', () => {
  const nodes=[prompt('one','one','turn',1),output('gen-output:one','one','turn',2),prompt('two','two','turn',3),output('gen-output:two','two','turn',4)];
  const manual=node=>({...node,payloadJson:JSON.stringify({...JSON.parse(node.payloadJson),workflow_generation_group:'manual:group',generation_gallery_key:'manual:group'})});
  const selected={...output('selected','','',5),role:'reference'};
  selected.payloadJson=JSON.stringify({workflow_generation_group:'manual:group',generation_gallery_key:'manual:group',manual_gallery_node:true});
  const copy=manual({...output('copy','','',6),role:'reference'});
  const result=canvasConversationCards([...nodes.map(manual),selected,copy],{});
  assert.equal(result.cards.size,1);
  const card=result.cards.get('one');
  assert.equal(card.latest.id,'two','a merged reference must not replace the latest execution session');
  assert.deepEqual(card.outputs.map(n=>n.id),['gen-output:one','gen-output:two','selected']);
  assert.equal(result.hiddenIds.has('copy'),false);
  assert.deepEqual(canvasConversationGroupTarget(card),{groupKey:'manual:group'});
});

test('Agent tool images stay separate even in the same provider conversation, with exact prompt aliases', () => {
  const session = prompt('gen-prompt:agent','agent-job','turn');
  const pictures = ['one','two'].map(id => output(`gen-output:${id}`,'agent-job','turn'));
  const final = {...output('agent-artifact:final','',''),role:'final'};
  for (const node of [session,...pictures,final]) node.payloadJson = JSON.stringify({...JSON.parse(node.payloadJson),workflow_generation_group:`asset:${node.id}`});
  const result = canvasConversationCards([session,...pictures,final],{});
  assert.equal(result.cards.size,3);
  assert.deepEqual([...result.hiddenIds], [session.id]);
  assert.equal(result.aliases.get(session.id),pictures[0].id);
  for (const node of [...pictures,final]) assert.deepEqual(result.cards.get(node.id).outputs.map(item=>item.id),[node.id]);
  const pending = canvasConversationCards([session],{});
  assert.equal(pending.cards.has(session.id),true);
  const routed = canvasConversationCards([session,...pictures],{},new Set(),new Set(),new Set([session.id]));
  assert.deepEqual(routed.cards.get(session.id).allOutputs.map(node=>node.id),pictures.map(node=>node.id));
  assert.deepEqual(canvasConversationGroupTarget(routed.cards.get(session.id)), {groupKey:'generation:agent-job'}, 'embedded galleries use conversation identity even when Agent pictures are separate');
  assert.equal(routed.hiddenIds.size,3,'explicit content destinations retain their own presentation');
});

test('H3 outputs use their exact producer with a stable anchor, latest first and hidden/contained instances excluded', () => {
  const video = (id, group, time) => ({...output(`workflow-comfy:${id}`, '', '', time), assetId: id, payloadJson: JSON.stringify({workflow_generation_group: group})});
  const nodes = [video('old', 'h3', 1), video('new', 'h3', 2), video('other', 'second', 3),
    {...video('removed','h3',4), hiddenAt:1}, video('contained','h3',5), {...video('copy','h3',6),id:'copy'}];
  const result = canvasConversationCards(nodes, {}, new Set(), new Set(['workflow-comfy:contained']));
  assert.equal(result.cards.size, 2);
  assert.equal(result.cards.get('workflow-comfy:old').latest.assetId, 'new');
  assert.deepEqual(result.cards.get('workflow-comfy:old').outputs.map(n => n.assetId), ['old','new']);
  assert.deepEqual([...result.hiddenIds], ['workflow-comfy:new']);
});

test('workflow repeats group across independent jobs while routed content keeps its exact target', () => {
  const first = prompt('first','job-1','turn'), next = prompt('next','job-2','turn',2);
  for (const node of [first,next]) node.payloadJson = JSON.stringify({...JSON.parse(node.payloadJson),conversation_id:node.id,workflow_generation_group:'workflow:producer'});
  const nodes = [first,next,output('a','job-1','turn'),output('b','job-2','turn',2)];
  const result = canvasConversationCards(nodes,{});
  assert.equal(result.cards.size,1);
  assert.deepEqual(result.cards.get('first').outputs.map(n=>n.assetId),['a','b']);
  assert.equal(result.cards.get('first').latest.id,'next');
  const routed = canvasConversationCards(nodes,{},new Set(),new Set(),new Set(['first','next']));
  assert.deepEqual([...routed.hiddenIds].sort(),['a','b','first','next']);
  assert.equal(routed.cards.size,2,'explicit destinations keep separate sessions across runs');
  assert.deepEqual(routed.cards.get('first').allOutputs.map(n=>n.assetId),['a']);
  assert.deepEqual(routed.cards.get('next').allOutputs.map(n=>n.assetId),['b']);
});

test('workflow video, HyperFrames and Cloud Agent final galleries exclude copies, intermediates and hidden results', () => {
  for (const prefix of ['gen-output','workflow-video','agent-artifact']) {
    const role = prefix === 'agent-artifact' ? 'final' : 'output';
    const media = (id,time) => ({...output(`${prefix}:${id}`,'job','turn',time),assetId:id,role,payloadJson:JSON.stringify({workflow_generation_group:`${prefix}-producer`})});
    const nodes = [media('one',1),media('two',2),{...media('ref',3),role:'reference'}, {...media('intermediate',4),role:'intermediate'},
      {...media('copy',5),id:'copied-node'}, {...media('hidden',6),hiddenAt:1},media('contained',7)];
    const result = canvasConversationCards(nodes,{},new Set(),new Set([`${prefix}:contained`]));
    assert.equal(result.cards.size,1,prefix);
    assert.equal(result.cards.get(`${prefix}:one`).latest.assetId,'two');
    assert.deepEqual([...result.hiddenIds],[`${prefix}:two`]);
  }
});

test('same-second retries follow durable turn order instead of random node ids', () => {
  const nodes = [prompt('z-original','job','failed'), prompt('a-retry','job','retry')];
  const jobs = {job: {conversationId:'conversation',turns:[{turnKey:'failed'},{turnKey:'retry'}]}};
  for (const input of [nodes, [...nodes].reverse()]) {
    const result = canvasConversationCards(input,jobs);
    assert.equal(result.cards.size,1);
    assert.equal(result.cards.get('z-original').latest.id,'a-retry');
    assert.deepEqual(result.cards.get('z-original').sessions.map(n=>n.id),['z-original','a-retry']);
  }
});

test('persisted conversation identity groups unloaded jobs and orders tied outputs by turn then asset', () => {
  const first = prompt('first', 'job', 'one');
  const next = prompt('next', 'handoff', 'two', 2);
  for (const node of [first, next]) node.payloadJson = JSON.stringify({ ...JSON.parse(node.payloadJson), conversation_id: 'saved' });
  const nodes = [next, {...output('z-node', 'job', 'one', 3), assetId: 'asset-01'},
    {...output('a-node', 'job', 'one', 3), assetId: 'asset-02'}, first, output('newest', 'handoff', 'two', 3)];
  const result = canvasConversationCards(nodes, {}, new Set(), new Set(['a-node']));
  assert.equal(result.cards.size, 1);
  assert.deepEqual(result.cards.get('first').allOutputs.map(node => node.assetId), ['asset-01', 'asset-02', 'newest']);
  assert.deepEqual(result.cards.get('first').outputs.map(node => node.assetId), ['asset-01', 'newest']);
  assert.equal(result.cards.get('first').latest.id, 'next');
});

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

test('matching an output inspects only its turn and keeps the existing alias when groups share a turn', () => {
  const nodes = [];
  let reads = 0;
  for (let i = 0; i < 100; i++) {
    const job = 'job' + i;
    const image = output('result' + i, job, 'one');
    const data = image.payloadJson;
    Object.defineProperty(image, 'payloadJson', { get() { reads++; return data; } });
    nodes.push(prompt('session' + i, job, 'one'), image);
  }
  const duplicate = (id, group) => ({ ...prompt(id, 'job0', 'one', 2), payloadJson: JSON.stringify({
    job_id: 'job0', turn_key: 'one', workflow_generation_group: group,
  }) });
  nodes.push(duplicate('copy1', 'job0'), duplicate('copy2', 'other-card'));
  const result = canvasConversationCards(nodes, {});
  assert.ok(reads < nodes.length * 3, 'reading output payloads stays proportional to the graph size');
  assert.deepEqual(result.cards.get('session0').outputs.map(node => node.id), ['result0']);
  assert.deepEqual(result.cards.get('copy2').outputs.map(node => node.id), ['result0']);
  assert.equal(result.aliases.get('result0'), 'copy2');
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

test('dissolved conversations expose every original session and picture without changing execution identities', () => {
  const nodes = [prompt('first', 'job', 'one'), prompt('next', 'job', 'two', 2), output('a', 'job', 'one'), output('b', 'job', 'two', 2)];
  for (const node of nodes) node.payloadJson = JSON.stringify({ ...JSON.parse(node.payloadJson), generation_group_dissolved: true });
  const before = structuredClone(nodes);
  const result = canvasConversationCards(nodes, { job: { conversationId: 'conversation' } });
  assert.equal(result.cards.size, 0);
  assert.equal(result.hiddenIds.size, 0);
  assert.equal(result.aliases.size, 0);
  assert.deepEqual(nodes, before);
  for (const prefix of ['workflow-comfy', 'workflow-video', 'agent-artifact']) {
    const media = ['one','two'].map(id => ({ ...output(`${prefix}:${id}`, '', ''), payloadJson: JSON.stringify({ workflow_generation_group: 'workflow:producer', generation_group_dissolved: true }) }));
    assert.equal(canvasConversationCards(media, {}).hiddenIds.size, 0);
  }
});
