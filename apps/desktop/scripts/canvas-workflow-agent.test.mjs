import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({configFile:false,root:process.cwd(),server:{host:'127.0.0.1',port:1599,strictPort:true,hmr:false,watch:null}});
await server.listen();
const browser = await chromium.launch({channel:'chrome',headless:true});
const page = await browser.newPage({viewport:{width:1600,height:1000}});
try {
  await page.goto('http://127.0.0.1:1599/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.getByRole('button',{name:'新增 Agent 卡片',exact:true}).click();
  await page.getByRole('textbox',{name:'文本修改要求'}).waitFor();
  await page.getByRole('textbox',{name:'文本修改要求'}).fill('将「朱砂痣」替换为「春山可望」，保留文字的排布关系。');
  await page.evaluate(async()=>{
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const {newWorkflowNode}=await import('/src/lib/canvasWorkflow.ts');
    const c=canvasWorkflowController('p'), agent=c.document.nodes.find(node=>node.kind==='agent');
    await c.edit([{...newWorkflowNode('instruction',0,0,''),id:'pending-text'}, {...agent,inputs:{text:[{nodeId:'pending-text',portId:'text'}]}}]);
  });
  const editor=page.getByRole('textbox',{name:'文本修改要求'});
  await editor.press('End');await editor.pressSequentially('@');
  const menu=page.getByRole('listbox',{name:'收到的内容'});await menu.waitFor();
  assert.equal(await menu.getByRole('option').count(),1);
  await menu.getByRole('option').filter({hasText:'等待上游内容'}).click();
  assert.equal(await editor.locator('[data-reference-id]').count(),1);
  await page.evaluate(()=>window.save());await page.reload();await editor.waitFor();
  assert.equal(await editor.locator('[data-reference-id]').count(),1);
  await page.screenshot({path:'.tmp/workflow/agent-card.png'});
  const result = await page.evaluate(async()=>{
    const {api}=await import('/src/lib/api.ts');
    const {CanvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const {newWorkflowNode,workflowInputs,workflowOutputs}=await import('/src/lib/canvasWorkflow.ts');
    const {useStore}=await import('/src/store.ts');
    const check=(value,message)=>{if(!value)throw Error(message);};
    useStore.setState({cloudAuth:{logged_in:true,user_id:'test'},cloudEntitlement:{user_id:'test',is_test_account:true,policy:{can_use_agent_runs:true,max_parallel_agent_runs:1,allowed_agent_skills:['bowerbird-unified-agent'],agent_budget_options:['controlled-standard']}},openCloudAgentRun:()=>{}});
    let source='左上竖排「朱砂痣」，纤细字体',submitted=0,generated=0,polls=0,fail=false;
    const requests=[];
    api.generationHistory=async()=>({turns:[{prompt:source}],references:[]});
    api.cloudAgentStart=async input=>{submitted++;requests.push(input);return {runId:`edit-${submitted}`};};
    api.cloudAgentGet=async runId=>{polls++;return {runId,status:fail?'failed':'succeeded',snapshot:{run:{safe_message:fail?'改写结果格式无效':null},events:[{type:'text.result',display_payload:{schemaVersion:1,text:source.replaceAll('朱砂痣','春山可望')}}]}};};
    api.localAgentFindAssetId=async()=> 'existing';
    useStore.setState({startGeneration:async(...args)=>{
      generated++;check(args[0]===`新海报：${source.replaceAll('朱砂痣','春山可望')}`,'generation must receive rewritten text only');
      const identity=args[12];useStore.setState(s=>({genJobs:{...s.genJobs,[identity.jobId]:{turns:[{turnKey:identity.turnKey,images:['existing.png']}]}}}));return {accepted:true};
    }});
    const c=new CanvasWorkflowController('agent-test');await c.load();
    const upstream={...newWorkflowNode('instruction',0,0,'codex'),id:'upstream',action:'reuse',inputs:{image:[{assetId:'existing'}]}};
    const input={nodeId:'upstream',portId:'text'};
    const agent={...newWorkflowNode('agent',420,0,''),id:'agent',agentTransport:'cloud',prompt:'将 @[original] 中的朱砂痣替换为春山可望，其余保持',inputs:{text:[input]},promptReferences:[{id:'original',type:'text',input,label:'文本 1'}]};
    check(workflowInputs(agent).length===1&&workflowInputs(agent)[0].type==='text','agent accepts source text');
    check(workflowOutputs(agent)[0].type==='text','agent outputs text');
    const binding={nodeId:'agent',portId:'text'};
    const gen={...newWorkflowNode('generation',840,0,'codex'),id:'gen',prompt:'新海报：@[edited]',inputs:{text:[binding]},promptReferences:[{id:'edited',type:'text',input:binding,label:'改写文本'}]};
    const base=window.snapshot().nodes[0];
    await api.projectCanvasNodeCreate({...base,id:'text-target',kind:'note',assetId:null,role:null,payloadJson:JSON.stringify({schema_version:1,note_type:'text',title:'改写结果',text:'原内容',member_ids:[],cells:[[{id:'target-cell',text:'原内容'},{id:'keep-cell',text:'保留此格'}]]})});
    const writer={...newWorkflowNode('text',0,0,''),id:'writer',textTarget:{nodeId:'text-target',cellId:'target-cell'},inputs:{text:[binding]}};
    await c.edit([upstream,agent,writer,gen]);await c.start(upstream.id);
    check(c.document.run.status==='done',JSON.stringify(c.issue));
    check(JSON.parse(requests[0].textRewrite.source)['引用文本 1']===source&&requests[0].intentPrompt===agent.prompt.replace('@[original]','【引用文本 1】'),'instruction positions and current referenced upstream text remain separate');
    check(requests[0].references.length===0&&requests[0].agentRuntime==='dsh','cloud DSH text mode has no image tool input');
    const target=()=>JSON.parse(window.snapshot().nodes.find(n=>n.id==='text-target').payloadJson).cells;
    check(target()[0][0].text===source.replaceAll('朱砂痣','春山可望')&&target()[0][1].text==='保留此格','connected content cell is replaced without modifying neighboring cells');
    source='左下横排「朱砂痣」，留白';await c.start(upstream.id);
    check(c.document.run.status==='done'&&JSON.parse(requests[1].textRewrite.source)['引用文本 1']===source,'rerun reads new upstream text');
    check(c.document.nodes.find(n=>n.id==='gen').prompt===gen.prompt,'reusable downstream prompt remains unchanged');
    check(target()[0][0].text===source.replaceAll('朱砂痣','春山可望')&&target().length===1,'rerun updates the same target cell');
    check(generated===2&&submitted===2,'each run performs one edit and one generation');
    const saved=structuredClone(c.document);saved.run.status='running';saved.run.steps.agent.status='running';saved.run.steps.gen={status:'pending'};
    saved.runs=saved.runs.map(run=>run.id===saved.run.id?saved.run:run);
    sessionStorage.setItem('workflow-agent-resume',JSON.stringify({revision:1,document:saved}));
    const recovered=new CanvasWorkflowController('agent-resume');await recovered.load();await recovered.continue();
    check(submitted===2&&recovered.document.run.status==='done','recovery queries existing Agent task without resubmission');
    fail=true;await c.start(upstream.id);
    check(c.document.run.status==='failed'&&c.issue.nodeId==='agent'&&generated===3,'Agent error identifies card and stops generation');
    await c.edit(c.document.nodes.map(n=>n.id==='agent'?{...n,prompt:'没有引用'}:n));
    try {await c.start('agent',true);}catch{}
    check(submitted===3&&c.issue.message.includes('按 @'),'removing the reference never implicitly sends connected text');
    // Local Agent DS is the dev default, does not require cloud login, and waits for a correlated result.
    useStore.setState({cloudAuth:null,cloudEntitlement:null});
    let localSubmissions=0,delivered=true,ready=true,wrong=false;
    api.agentDsWorkflowStart=async(requestId,instruction,sourceText)=>{
      localSubmissions++;check(JSON.parse(sourceText)['引用文本 1']===source,'local delivery uses the current @ source');
      check(instruction.includes('【引用文本 1】'),'local instruction keeps reference mapping');
      return {path:'test-pending',autoDelivered:delivered,sessionTitle:'本机测试',notice:delivered?null:'未找到会话'};
    };
    api.agentDsWorkflowResult=async requestId=>ready?{schemaVersion:1,requestId:wrong?'another-task':requestId,text:source.replaceAll('朱砂痣','春山可望')}:null;
    const local=new CanvasWorkflowController('agent-local');await local.load();
    await local.edit([upstream,{...agent,agentTransport:undefined},gen]);await local.start(upstream.id);
    check(local.document.run.status==='done'&&localSubmissions===1&&submitted===3&&generated===4,'local result resumes downstream without submitting Cloud');
    delivered=false;ready=false;await local.start(upstream.id);
    check(local.document.run.status==='waiting'&&localSubmissions===2&&generated===4,'delivery fallback parks workflow without pretending to have a text result');
    await local.continue();check(localSubmissions===2&&local.document.run.status==='waiting','continue never repeats delivery');
    ready=true;await local.continue();check(local.document.run.status==='done'&&generated===5,'manual queue result is picked up');
    delivered=true;wrong=true;await local.start(upstream.id);
    check(local.document.run.status==='failed'&&generated===5,'a different task result must never flow downstream');
    // Persisted real-board shape: text 1 stays connected; text 2 was reconnected
    // to a new cell of the same table, but its prompt token still names the old cell.
    for(const [id,cells] of [['rules-table',[[{id:'rules',text:'保留排布'}]]],['rewired-table',[[{id:'new-cell',text:''},{id:'next-cell',text:'换接内容'}]]]]) {
      await api.projectCanvasNodeCreate({...base,id,kind:'note',assetId:null,role:null,payloadJson:JSON.stringify({schema_version:1,note_type:'text',text:'',member_ids:[],cells})});
    }
    const first={canvasNodeId:'rules-table',cellId:'*text'},second={canvasNodeId:'rewired-table',cellId:'new-cell'};
    const multi={...agent,agentTransport:undefined,prompt:'按照 @[rule] 改写 @[original]',inputs:{text:[first,second]},promptReferences:[
      {id:'rule',type:'text',input:first,label:'文本 1'},
      {id:'original',type:'text',input:{canvasNodeId:'rewired-table',cellId:'old-cell'},label:'文本 2'},
    ]};
    const cellWriter={...newWorkflowNode('text',0,0,''),id:'cell-writer',textTarget:{nodeId:'rewired-table',cellId:'new-cell'},inputs:{text:[input]}};
    const seed=new CanvasWorkflowController('agent-rewired-cells');await seed.load();
    await seed.save({...seed.document,nodes:[upstream,cellWriter,multi]});
    const repaired=new CanvasWorkflowController('agent-rewired-cells');await repaired.load();
    check(repaired.document.nodes[2].promptReferences[1].input.cellId==='new-cell','load repairs only the identifiable stale cell reference');
    let expectedSource=source,rewiredCalls=0;
    api.agentDsWorkflowStart=async(_id,_instruction,sourceText)=>{
      const values=JSON.parse(sourceText);rewiredCalls++;
      check(values['引用文本 1']==='保留排布'&&values['引用文本 2']===expectedSource,'two references remain distinct and use the new cell value');
      check(repaired.document.run.steps['cell-writer']?.status==='done'||repaired.document.run.order.length===1,'Agent must wait for the replacement cell writer');
      return {path:'test-pending',autoDelivered:true};
    };
    api.agentDsWorkflowResult=async requestId=>({schemaVersion:1,requestId,text:'改写完成'});
    await repaired.start(upstream.id);
    check(repaired.document.run.status==='done'&&rewiredCalls===1,'repaired persisted Agent completes after current writer');
    expectedSource='换接内容';
    await repaired.edit(repaired.document.nodes.map(n=>n.id===agent.id?{...n,inputs:{text:[first,{...second,cellId:'next-cell'}]}}:n));
    check(repaired.document.nodes[2].promptReferences[1].input.cellId==='next-cell','rewiring synchronizes stored prompt reference');
    await repaired.start(agent.id,true);
    check(repaired.document.run.status==='done'&&rewiredCalls===2,'single-card execution reads the replacement without replaying upstream');
    const persisted=JSON.parse(sessionStorage.getItem('workflow-agent-rewired-cells')).document;
    check(persisted.nodes[2].prompt===multi.prompt&&persisted.nodes[2].promptReferences[0].input.canvasNodeId==='rules-table'&&persisted.nodes[2].promptReferences[1].input.cellId==='next-cell','save preserves both the prompt token and repaired identities');
    return {submitted,generated,polls};
  });
  assert.equal(result.submitted,3);assert.equal(result.generated,5);
  console.log('PASS Agent card UI, upstream ordering, separate source/instruction, prompt reuse, recovery, failure stop',result);
} finally {await browser.close();await server.close();}
