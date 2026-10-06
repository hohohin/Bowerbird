import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newWorkflowNode, workflowConnectionError, workflowOrder, workflowInputValues, workflowOutputs, invalidateWorkflow, generationInputNode, compileGenerationPrompt, compileAgentPrompt, normalizeWorkflowInputSlots } from '../src/lib/canvasWorkflow.ts';
const node = (id, kind = 'skill') => ({ ...newWorkflowNode(kind, 0, 0, 'codex'), id });
const mentionText = node => { node.prompt = '@[text]'; node.promptReferences = [{ id: 'text', type: 'text', input: node.inputs.text[0], label: '文本' }]; };

test('single-card execution includes receivers and content relays but no other executable cards', () => {
  const source = { ...node('source', 'generation'), inputs: { signal: [{ nodeId: 'key', portId: 'signal' }] } };
  const writer = { ...node('writer', 'text'), textTarget: { nodeId: 'table', cellId: 'cell', image: true }, inputs: { image: [{ nodeId: 'source', portId: 'image' }] } };
  const relay = { ...node('relay', 'text'), textTarget: { nodeId: 'copy', cellId: 'cell', image: true }, inputs: { image: [{ canvasNodeId: 'table', cellId: '*' }] } };
  const consumer = { ...node('consumer'), inputs: { image: [{ canvasNodeId: 'copy', cellId: '*' }] } };
  const unrelated = { ...node('unrelated', 'text'), textTarget: { nodeId: 'table', cellId: 'other' }, inputs: { text: [{ nodeId: 'agent', portId: 'text' }] } };
  const nodes = [consumer, relay, writer, source, node('key', 'trigger'), unrelated, node('agent', 'agent')];
  assert.deepEqual(workflowOrder(nodes, 'source', true), ['source', 'writer', 'relay']);
  assert.deepEqual(workflowOrder(nodes, 'writer', true), ['writer', 'relay']);
});

test('required upstream cards also deliver outputs without starting unrelated paid branches', () => {
  const source = node('source', 'agent');
  const consumer = { ...node('consumer', 'agent'), inputs: { text: [{ nodeId: 'source', portId: 'text' }] } };
  const writer = { ...node('writer', 'text'), textTarget: { nodeId: 'table', cellId: 'cell' }, inputs: { text: [{ nodeId: 'source', portId: 'text' }] } };
  const other = { ...node('other', 'agent'), inputs: { text: [{ nodeId: 'source', portId: 'text' }] } };
  const nodes = [consumer, writer, source, other];
  assert.deepEqual(new Set(workflowOrder(nodes, 'consumer')), new Set(['source', 'consumer', 'writer']));
  assert.deepEqual(workflowOrder(nodes, 'consumer', true), ['consumer']);
});

test('Agent references select inputs, preserve positions and follow current source without injecting unused text',()=>{
  const a={...node('a','instruction'),outputs:{text:{type:'text',text:'原文A'}}};
  const b={...node('b','instruction'),outputs:{text:{type:'text',text:'原文B'}}};
  const agent={...node('agent','agent'),agentTransport:'cloud',inputs:{text:[{nodeId:'a',portId:'text'},{nodeId:'b',portId:'text'}]}};
  agent.prompt='将 @[selected] 简写，再润色 @[selected]';
  agent.promptReferences=[{id:'selected',type:'text',input:agent.inputs.text[1],label:'文本 2'}];
  const compile=()=>compileAgentPrompt(agent,workflowInputValues([a,b,agent],generationInputNode(agent)));
  assert.deepEqual(generationInputNode(agent).inputs.text,[{...agent.inputs.text[1],slot:2}]);
  assert.deepEqual(compile(),{prompt:'将 【引用文本 1】 简写，再润色 【引用文本 1】',source:JSON.stringify({'引用文本 1':'原文B'}),assetIds:[]});
  b.outputs.text.text='更新B';assert.equal(JSON.parse(compile().source)['引用文本 1'],'更新B');
  agent.inputs.text=[{nodeId:'a',portId:'text',slot:2}];assert.equal(JSON.parse(compile().source)['引用文本 1'],'原文A');
  agent.inputs.text=[];assert.throws(compile,/已断开/);
  agent.prompt='自由写一首诗';assert.deepEqual(compile(),{prompt:agent.prompt,source:'{}',assetIds:[]});
});

test('Agent accepts image-only and mixed references in prompt order, rejecting missing images', () => {
  const input={canvasNodeId:'photos',cellId:'*'};
  const textInput={nodeId:'copy',portId:'text'};
  const agent={...node('agent','agent'),prompt:'比较 @[photo]，结合 @[copy]，再看 @[photo]',inputs:{image:[input],text:[textInput]},promptReferences:[
    {id:'photo',type:'image',input,label:'图片组'}, {id:'copy',type:'text',input:textInput,label:'文案'}]};
  const values={image:[{type:'image',assetIds:['b','a','b']}],text:[{type:'text',text:'完整原文'}]};
  assert.deepEqual(compileAgentPrompt(agent,values),{prompt:'比较 【图片 1、图片 2】，结合 【引用文本 1】，再看 【图片 1、图片 2】',source:'{"引用文本 1":"完整原文"}',assetIds:['b','a']});
  agent.prompt='描述 @[photo]';
  assert.equal(compileAgentPrompt(agent,values).source,'{"引用文本 1":"完整原文"}');
  assert.throws(()=>compileAgentPrompt(agent,{image:[{type:'image',assetIds:[]}]}),/没有可用图片/);
  agent.prompt='处理 @[missing]';assert.throws(()=>compileAgentPrompt(agent,values),/无效引用/);
});

test('local Agent includes connected inputs without mentions, schedules producers and rejects empty inputs', () => {
  const producer={...node('source','instruction'),outputs:{}};
  const image={nodeId:'source',portId:'image'};
  const text={canvasNodeId:'copy',cellId:'a'};
  const agent={...node('agent','agent'),prompt:'将图中文字转成表格',inputs:{image:[image],text:[text]},promptReferences:[]};
  assert.deepEqual(generationInputNode(agent).inputs,{image:[{...image,slot:1}],text:[{...text,slot:1}]});
  assert.deepEqual(workflowOrder([producer,agent],'agent'),['source','agent']);
  const values={image:[{type:'image',assetIds:['photo']}],text:[{type:'text',text:'补充要求'}]};
  assert.deepEqual(compileAgentPrompt(agent,values),{prompt:agent.prompt,source:'{"引用文本 1":"补充要求"}',assetIds:['photo']});
  assert.throws(()=>compileAgentPrompt(agent,{...values,image:[]}),/没有可用图片/);
  assert.throws(()=>compileAgentPrompt(agent,{...values,text:[{type:'text',text:''}]}),/没有可用文字/);
  agent.prompt='按照 @[copy] 分析图片';agent.promptReferences=[{id:'copy',type:'text',input:text,label:'补充'}];
  assert.deepEqual(compileAgentPrompt(agent,values).assetIds,['photo']);
  assert.equal(Object.keys(JSON.parse(compileAgentPrompt(agent,values).source)).length,1);
});

test('split exposes one product port and automatic image container preserves dependency and cycle checks', () => {
  const split={...node('split','instruction'),action:'layers',resultNodeIds:['container'],outputPorts:[{id:'layer-old',type:'image',label:'old'}]};
  const next={...node('next','instruction'),action:'describe',inputs:{image:[{canvasNodeId:'container',cellId:'*'}]}};
  assert.deepEqual(workflowOutputs(split),[{id:'image',label:'产物',type:'image'}]);
  assert.deepEqual(workflowOrder([next,split],'split'),['split','next']);
  split.inputs.image=[{nodeId:'next',portId:'image'}];
  assert.throws(()=>workflowOrder([split,next],'split'),/循环/);
});

test('image-container reads stored cells, waits for active writers and rejects aggregate self loops', () => {
  const first = {...node('first','text'),textTarget:{nodeId:'images',cellId:'a',image:true},inputs:{image:[{assetId:'a'}]}};
  const second = {...node('second','text'),textTarget:{nodeId:'images',cellId:'b',image:true},inputs:{image:[{assetId:'b'}]}};
  const consumer = {...node('consumer','instruction'),action:'describe',inputs:{image:[{canvasNodeId:'images',cellId:'*'}]}};
  assert.deepEqual(workflowOrder([first,consumer,second],'consumer'),['consumer']);
  assert.deepEqual(workflowOrder([first,consumer,second],'first'),['first','consumer']);
  const trigger=node('key','trigger');
  first.inputs.signal=[{nodeId:'key',portId:'signal'}];
  second.inputs.signal=[{nodeId:'key',portId:'signal'}];
  assert.deepEqual(workflowOrder([trigger,first,consumer,second],'key'),['key','first','second','consumer']);
  second.inputs.image=[{canvasNodeId:'images',cellId:'*'}];
  assert.throws(()=>workflowOrder([first,consumer,second],'first'),/循环/);
});

test('generation references retain binding identity through reordering and reject removed selections', () => {
  const gen = node('gen', 'generation');
  const first = { assetId: 'a',slot:1 }, second = { assetId: 'b',slot:2 };
  gen.inputs = { image: [first, second] }; gen.prompt = '只参考 @[chosen]';
  gen.promptReferences = [{ id: 'chosen', type: 'image', input: second, assetId: 'b', slot:2, label: '图片来源 2' }];
  const compile = () => compileGenerationPrompt(gen, workflowInputValues([gen], generationInputNode(gen)));
  assert.deepEqual(compile(), { prompt: '只参考 @图片1', assetIds: ['b'] });
  gen.inputs.image.reverse();
  assert.deepEqual(compile(), { prompt: '只参考 @图片1', assetIds: ['b'] });
  gen.inputs.image = [first];
  assert.throws(compile, /已断开/);
  gen.inputs.image = [{ groupId: 'folder', assetIds: ['a'],slot:2 }];
  gen.promptReferences[0].input = { groupId: 'folder', assetIds: ['a', 'b'] };
  assert.deepEqual(compile(), { prompt: '只参考 @图片1', assetIds: ['a'] });
  gen.inputs.image[0].assetIds = ['c', 'd'];
  assert.deepEqual(compile(), { prompt: '只参考 @图片1 @图片2', assetIds: ['c', 'd'] });
  gen.inputs.image[0].assetIds = [];
  assert.throws(compile, /没有可用图片/);
});

test('rewired text reference waits for the currently connected describe and writer even while old source still exists', () => {
  const describe={...node('describe','instruction'),inputs:{image:[{assetId:'image'}]}};
  const writer={...node('writer','text'),textTarget:{nodeId:'new-table',cellId:'new-cell',append:true},inputs:{text:[{nodeId:'describe',portId:'text'}]}};
  const gen={...node('gen','generation'),prompt:'沿用 @[text]',inputs:{text:[{canvasNodeId:'new-table',cellId:'*text'}]},promptReferences:[{id:'text',type:'text',label:'文本 1',input:{canvasNodeId:'old-table',cellId:'old-cell'}}]};
  const nodes=[gen,writer,describe];
  assert.deepEqual(workflowOrder(nodes,'gen'),['describe','writer','gen']);
  const values=workflowInputValues(nodes,generationInputNode(gen),(id)=>id==='new-table'?'本轮反推':'不应读取旧内容');
  assert.equal(compileGenerationPrompt(gen,values).prompt,'沿用 本轮反推');
  assert.equal(gen.prompt,'沿用 @[text]');
  gen.inputs.text.push({canvasNodeId:'another-table',cellId:'*text'});
  assert.deepEqual(workflowOrder(nodes,'gen'),['describe','writer','gen']);
  assert.equal(compileGenerationPrompt(gen,workflowInputValues(nodes,generationInputNode(gen),()=> '管道一的当前内容')).prompt,'沿用 管道一的当前内容');
});

test('rewiring one cell among multiple text references retains other identities and waits for its current writer', () => {
  const first={canvasNodeId:'first-table',cellId:'*text'};
  const stale={canvasNodeId:'second-table',cellId:'old-cell'};
  const current={canvasNodeId:'second-table',cellId:'new-cell'};
  const upstream={...node('upstream','instruction'),inputs:{image:[{assetId:'image'}]}};
  const writer={...node('writer','text'),textTarget:{nodeId:'second-table',cellId:'new-cell'},inputs:{text:[{nodeId:'upstream',portId:'text'}]}};
  for(const kind of ['agent','generation']) {
    const consumer={...node('consumer',kind),prompt:'根据 @[one] 改写 @[two]',inputs:{text:[first,current]},promptReferences:[
      {id:'one',type:'text',input:first,label:'文本 1'},{id:'two',type:'text',input:stale,label:'文本 2'},
    ]};
    assert.deepEqual(workflowOrder([upstream,consumer,writer],'upstream'),['upstream','writer','consumer']);
    const effective=generationInputNode(consumer);
    assert.deepEqual(effective.promptReferences.map(ref=>ref.input),[{...first,slot:1},{...current,slot:2}]);
    const values=workflowInputValues([consumer],effective,(_,cell)=>cell==='*text'?'规则':'新单元格内容');
    if(kind==='agent') assert.deepEqual(JSON.parse(compileAgentPrompt(consumer,values).source),{'引用文本 1':'规则','引用文本 2':'新单元格内容'});
    else assert.equal(compileGenerationPrompt(consumer,values).prompt,'根据 规则 改写 新单元格内容');
    consumer.inputs.text=[first];
    assert.deepEqual(generationInputNode(consumer).promptReferences[1].input,stale,'never steal the first reference');
    assert.throws(()=>compileAgentPrompt(consumer,{text:[{type:'text',text:'规则'}]}),error=>error.referenceLabel==='文本 2'&&/已断开/.test(error.message));
    consumer.inputs.text=[first,current,{canvasNodeId:'second-table',cellId:'another-cell'}];
    assert.deepEqual(generationInputNode(consumer).promptReferences[1].input,{...current,slot:2},'pipe 2 is independent of other candidates');
  }
});

test('container and cell references resolve current images without changing stored prompt', () => {
  for (const cellId of ['*', 'stable-cell']) {
    const gen = node('gen', 'generation'), input = { canvasNodeId: 'container', cellId };
    gen.inputs = { image: [input] }; gen.prompt = '参考 @[image]';
    gen.promptReferences = [{ id: 'image', type: 'image', input, assetId: 'old', label: '图片' }];
    let ids = ['a'];
    const compile = () => compileGenerationPrompt(gen, workflowInputValues([gen], generationInputNode(gen), (id, cell) => {
      assert.equal(id, gen.inputs.image[0].canvasNodeId); assert.equal(cell, cellId); return { type: 'image', assetIds: ids };
    }));
    assert.deepEqual(compile().assetIds, ['a']);
    ids = ['b']; assert.deepEqual(compile().assetIds, ['b']);
    assert.equal(gen.prompt, '参考 @[image]');
    gen.inputs.image = [{ canvasNodeId: 'other', cellId }];
    ids = ['c']; assert.deepEqual(compile().assetIds, ['c']);
  }
});

test('unmentioned generation inputs neither execute upstream nor enter the prompt', () => {
  const upstream = node('upstream'), gen = node('gen', 'generation');
  gen.prompt = '原样发送\n第二行';
  gen.inputs = { text: [{ nodeId: upstream.id, portId: 'text' }, { canvasNodeId: 'deleted', cellId: 'missing' }], image: [{ groupId: 'deleted-folder' }] };
  assert.deepEqual(workflowOrder([upstream, gen], 'gen'), ['gen']);
  assert.deepEqual(compileGenerationPrompt(gen, workflowInputValues([upstream, gen], generationInputNode(gen))), { prompt: gen.prompt, assetIds: [] });
});

test('text-card key starts its consumers using current cells without changing normal producer dependencies', () => {
  const upstream = { ...node('describe', 'instruction'), resultNodeIds: ['table'] };
  const source = { ...node('source', 'text'), textSource: 'table', trigger: true };
  const generate = { ...node('generate', 'generation'), inputs: { text: [{ canvasNodeId: 'table', cellId: 'a' }] } };
  mentionText(generate);
  assert.deepEqual(workflowOrder([upstream, source, generate], 'source'), ['source', 'generate']);
  assert.deepEqual(workflowOrder([upstream, source, generate], 'describe'), ['describe', 'generate']);
});

test('cell writers participate in ordering, refresh cached cell inputs and reject cell cycles', () => {
  const writer = { ...node('write', 'text'), textTarget: { nodeId: 'table', cellId: 'b' }, inputs: { text: [{ canvasNodeId: 'table', cellId: 'a' }] }, outputs: { text: { type: 'text', text: 'old' } } };
  const generate = { ...node('gen', 'generation'), inputs: { text: [{ canvasNodeId: 'table', cellId: 'b' }] } };
  mentionText(generate);
  assert.deepEqual(workflowOrder([writer, generate], 'gen'), ['write', 'gen']);
  writer.inputs.text = [{ canvasNodeId: 'table', cellId: 'b' }];
  assert.throws(() => workflowOrder([writer, generate], 'write'), /循环/);
});

test('text relay pulls in missing visual-profile prerequisites but not their other consumers',()=>{
  const split=node('split','instruction'),describe=node('describe','instruction'),gen=node('gen','generation');
  const profile=node('profile','visual-profile'),other=node('other','generation'),source=node('source','instruction');
  describe.inputs.image=[{nodeId:'split',portId:'image'}];describe.resultNodeIds=['table'];
  gen.inputs={text:[{canvasNodeId:'table',cellId:'prompt'}],'visual-profile':[{nodeId:'profile',portId:'visual-profile'}]};
  mentionText(gen);
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
  mentionText(c);
  assert.deepEqual(workflowOrder([a,b,c],a.id),['split','describe','generate']);
  c.outputs.session={type:'session',nodeIds:['old']};
  assert.deepEqual(invalidateWorkflow([a,b,c],b.id)[2].outputs,{});
  b.inputs.text=[{canvasNodeId:'table',cellId:'prompt'}];
  assert.throws(()=>workflowOrder([a,b,c],a.id),/循环/);
});

test('generation exposes one image output for downstream consumption', () => {
  const a=node('a','generation'), b=node('b');
  assert.deepEqual(workflowOutputs(a),[{id:'image',label:'图片',type:'image'}]);
  assert.match(workflowConnectionError([a,b],'a','session','b','image'),/相同类型/);
  a.outputs.image={type:'image',assetIds:['legacy']};b.inputs.image=[{nodeId:'a',portId:'image'}];
  assert.deepEqual(workflowInputValues([a,b],b).image[0].assetIds,['legacy']);
});

test('aggregate instruction ports exist before execution', () => {
  const a=node('a','instruction');
  assert.equal(workflowOutputs(a)[0].label,'提示词');
  a.action='layers';assert.equal(workflowOutputs(a)[0].label,'产物');
});
test('cell bindings resolve current text by identity and reject removed cells', () => {
  const a=node('a');a.inputs.text=[{canvasNodeId:'note',cellId:'cell-1'}];
  assert.equal(workflowInputValues([a],a,(id,cell)=>id==='note'&&cell==='cell-1'?'updated':undefined).text[0].text,'updated');
  assert.throws(()=>workflowInputValues([a],a,()=>undefined),error=>error.node.id==='a'&&error.source.canvasNodeId==='note'&&error.source.cellId==='cell-1'&&/来源卡片或单元格不存在/.test(error.message));
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

test('numbered pipes migrate stale cells on different cards and read current sources for Agent and generation', () => {
  for (const kind of ['agent','generation']) {
    const n={...node('consumer',kind),prompt:'@[one] / @[two]',inputs:{text:[{canvasNodeId:'new-a',cellId:'a'},{canvasNodeId:'new-b',cellId:'b'}]},promptReferences:[
      {id:'one',type:'text',label:'文本 1',input:{nodeId:'deleted-agent',portId:'text'}},
      {id:'two',type:'text',label:'文本 2',input:{canvasNodeId:'unrelated-old-table',cellId:'old'}},
    ]};
    const migrated=normalizeWorkflowInputSlots(n);
    assert.deepEqual(migrated.promptReferences.map(r=>r.slot),[1,2]);
    const values=workflowInputValues([],generationInputNode(migrated),id=>id==='new-a'?'当前甲':'当前乙');
    if(kind==='generation')assert.equal(compileGenerationPrompt(migrated,values).prompt,'当前甲 / 当前乙');
    else assert.deepEqual(JSON.parse(compileAgentPrompt(migrated,values).source),{'引用文本 1':'当前甲','引用文本 2':'当前乙'});
  }
});

test('disconnect never renumbers another pipe; reconnect fills the empty pipe across reload and reordering', () => {
  let n=normalizeWorkflowInputSlots({...node('gen','generation'),prompt:'@[one] / @[two]',inputs:{text:[{nodeId:'a',portId:'text'},{nodeId:'b',portId:'text'}]},promptReferences:[
    {id:'one',type:'text',label:'文本 1',input:{}},{id:'two',type:'text',label:'文本 2',input:{}},
  ]});
  n=normalizeWorkflowInputSlots({...n,inputs:{text:[n.inputs.text[1]]}},n);
  assert.deepEqual(n.inputs.text.map(i=>i.slot),[2]);
  assert.throws(()=>compileGenerationPrompt(n,{text:[{type:'text',text:'乙'}]}),/已断开/);
  n=JSON.parse(JSON.stringify(n));
  n=normalizeWorkflowInputSlots({...n,inputs:{text:[...n.inputs.text,{nodeId:'c',portId:'text'}]}},n);
  assert.deepEqual(n.inputs.text.map(i=>i.slot),[2,1]);
  assert.equal(compileGenerationPrompt(n,{text:[{type:'text',text:'乙'},{type:'text',text:'新甲'}]}).prompt,'新甲 / 乙');
  n=normalizeWorkflowInputSlots({...n,inputs:{text:[...n.inputs.text].reverse()}},n);
  assert.equal(compileGenerationPrompt(n,{text:[{type:'text',text:'新甲'},{type:'text',text:'乙'}]}).prompt,'新甲 / 乙');
});

test('image pipes carry current upstream images and do not pin a selected asset', () => {
  for(const kind of ['generation','agent']) {
    let n=normalizeWorkflowInputSlots({...node('images',kind),prompt:'使用 @[photo]',inputs:{image:[{assetId:'old'}]},promptReferences:[{id:'photo',type:'image',label:'图片 1.1',assetId:'old',input:{assetId:'old'}}]});
    n=normalizeWorkflowInputSlots({...n,inputs:{image:[{groupId:'new-folder',assetIds:['new-a','new-b'],slot:1}]}},n);
    const values=workflowInputValues([],generationInputNode(n));
    const result=kind==='agent'?compileAgentPrompt(n,values):compileGenerationPrompt(n,values);
    assert.deepEqual(result.assetIds,['new-a','new-b']);
    assert.equal(n.prompt,'使用 @[photo]');
  }
});

test('execution reports the current pipe source when its upstream has no content', () => {
  const n=normalizeWorkflowInputSlots({...node('consumer','agent'),prompt:'@[one]',inputs:{text:[{canvasNodeId:'new',cellId:'empty'}]},promptReferences:[{id:'one',type:'text',label:'文本 1',input:{nodeId:'old',portId:'text'}}]});
  assert.throws(()=>workflowInputValues([],n,()=>''),error=>error.source.canvasNodeId==='new'&&error.source.slot===1&&error.referenceLabel==='文本 1');
});
