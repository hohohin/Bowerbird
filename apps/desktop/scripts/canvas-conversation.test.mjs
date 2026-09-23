import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canvasConversationTurn, canvasConversationTurns } from '../src/lib/canvasConversation.ts';
const pack = JSON.parse(readFileSync(new URL('../src-tauri/resources/onboarding-v0917/bowerbird-onboarding.json', import.meta.url)));
const camel = row => Object.fromEntries(Object.entries(row).map(([key,value])=>[key.replace(/_([a-z])/g,(_,c)=>c.toUpperCase()),value]));
const nodes = pack.tables.canvas_nodes.map(camel), edges = pack.tables.canvas_edges.map(camel);
const assets = new Map(pack.tables.assets.map(a=>[a.id,{...a,store_path:'/local/library/'+a.store_path}]));
const selected = nodes.find(n=>n.id==='pack:canvas_nodes:018');
test('imported conversation restores ordered hidden history and graph references without executable ids',()=>{
  const turns = canvasConversationTurns(selected,nodes,edges,assets);
  assert.equal(turns.length,4);
  assert.ok(turns.some(t=>t.node.hiddenAt!==null));
  assert.ok(turns.every(t=>t.references.every(a=>a.store_path)));
  assert.ok(!turns.some(t=>t.node.id==='pack:canvas_nodes:014'));
  const turn=canvasConversationTurn(selected,nodes,edges,assets);
  assert.deepEqual(turn.referenceNodeIds,['pack:canvas_nodes:016','pack:canvas_nodes:004']);
  assert.deepEqual(turn.references.map(a=>a.id),['pack:assets:006','pack:assets:002']);
  assert.ok(turn.references.every(a=>a.store_path.startsWith('/local/library/')));
  assert.equal(turn.outputs.length,1);
  assert.equal(turn.ratio,'9:16');
  assert.equal(canvasConversationTurn({...selected,payloadJson:'{"job_id":"real","text":"prompt"}'},nodes,edges,assets),null);
});
test('snapshot reconstruction stays in the owning project and preserves unavailable references',()=>{
  const foreign={...selected,id:'foreign',projectId:'other'};
  assert.equal(canvasConversationTurns(selected,[...nodes,foreign],edges,assets).length,4);
  const turn=canvasConversationTurn(selected,nodes,edges,new Map());
  assert.equal(turn.references.length,2);
  assert.ok(turn.references.every(a=>a.store_path===null));
  assert.deepEqual(turn.outputs,[]);
});

test('workflow history can view a persisted job without mixing runs in the same thread',()=>{
  const turn=(id,job)=>({...selected,id,payloadJson:JSON.stringify({job_id:job,text:id})});
  const first=turn('first','job-one'),later=turn('later','job-one'),other=turn('other','job-two');
  const turns=canvasConversationTurns(first,[first,later,other,...nodes],edges,assets,'job-one');
  assert.deepEqual(turns.map(t=>t.node.id),['first','later']);
  assert.equal(canvasConversationTurn(first,[first],[],assets),null,'live jobs remain excluded from imported-only callers');
});
