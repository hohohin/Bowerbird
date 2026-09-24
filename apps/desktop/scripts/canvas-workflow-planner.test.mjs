import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({configFile:false,root:process.cwd(),server:{host:'127.0.0.1',port:1603,strictPort:true,hmr:false,watch:null}});
await server.listen();
const browser = await chromium.launch({channel:'chrome',headless:true});
const page = await browser.newPage({viewport:{width:1700,height:1100}});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:1603/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.getByRole('button',{name:'新增工作流助手',exact:true}).click();
  await page.getByRole('textbox',{name:'工作流需求'}).fill('生成一张春日海报，3:4。');
  await page.evaluate(async()=>{
    const {api}=await import('/src/lib/api.ts');
    window.plannerRequests=[];
    window.plan={summary:'触发器启动海报生成。',nodes:[{id:'start',kind:'trigger'},{id:'draw',kind:'generation',prompt:'春日海报',ratio:'3:4'}],edges:[{from:'start',output:'signal',to:'draw',input:'signal'}]};
    const spec={schemaVersion:2,summary:'触发器启动海报生成。',sourceUses:[],nodes:window.plan.nodes.slice(1),outputs:[{node:'draw',label:'春日海报'}]};
    let digest;
    api.agentDsWorkflowStart=async(...args)=>{window.plannerRequests.push(args);return {path:'pending',autoDelivered:true};};
    api.agentDsWorkflowResult=async requestId=>({schemaVersion:2,requestId,revision:1,phase:digest?'commit':'proposal',digest,text:JSON.stringify(spec)});
    api.agentDsWorkflowFeedback=async (_id,_revision,text)=>digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
  });
  await page.getByRole('button',{name:'编排工作流',exact:true}).click();
  await page.getByText('流程已搭建 · 未自动运行',{exact:true}).waitFor();
  assert.equal(await page.locator('.workflow-card.is-generation').count(),1);
  assert.equal(await page.locator('.workflow-card.is-trigger').count(),1);
  assert.equal(await page.locator('.workflow-card.is-planner [data-workflow-output]').count(),0);
  assert.equal(await page.evaluate(()=>window.plannerRequests[0][3]),'planning-v2');
  assert.equal(await page.evaluate(()=>window.calls.filter(call=>/generate|agent_run_start|describe/.test(call.command)).length),0);
  await page.locator('.workflow-card.is-planner').screenshot({path:'../../.tmp/workflow-planner.png'});
  await page.getByRole('button',{name:'撤回此次编排',exact:true}).click();
  await page.getByText('已撤回流程',{exact:true}).waitFor();
  assert.equal(await page.locator('.workflow-card.is-generation').count(),0);

  const result=await page.evaluate(async()=>{
    const {api}=await import('/src/lib/api.ts');
    const {CanvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const {newWorkflowNode,workflowOrder,workflowConnectionError,compileGenerationPrompt,generationInputNode,workflowInputValues}=await import('/src/lib/canvasWorkflow.ts');
    const {buildWorkflowPlan,canUndoWorkflowPlan,planningContract}=await import('/src/lib/workflowPlanner.ts');
    const {captureCanvasClipboard,cloneCanvasClipboard}=await import('/src/lib/canvasClipboard.ts');
    // Retain regression coverage for persisted v1 requests. New two-phase requests have a separate suite.
    const {WorkflowPlannerRuntime}=await import('/src/lib/workflowPlannerRuntime.ts');
    const startV2=WorkflowPlannerRuntime.prototype.start;
    WorkflowPlannerRuntime.prototype.start=async function(id){await startV2.call(this,id);await this.host.edit(this.host.document.nodes.map(node=>node.id===id?{...node,planning:{...node.planning,protocolVersion:undefined}}:node));};
    let checks=0;const check=(value,message)=>{checks++;if(!value)throw Error(message);};
    const owner={...newWorkflowNode('planner',10,20,'codex'),id:'assistant',prompt:'反推并改写，然后生成海报'};
    const sources=[{id:'source1',type:'image',input:{assetId:'existing'},label:'参考图'}];
    const plan={summary:'反推 → 改写 → 生图',nodes:[{id:'start',kind:'trigger'},{id:'describe',kind:'instruction',action:'describe'},{id:'rewrite',kind:'agent',prompt:'改为春日配色：{{describe.text}}'},{id:'draw',kind:'generation',prompt:'{{rewrite.text}} 使用参考 {{source1.image}}',ratio:'3:4'}],edges:[
      {from:'start',output:'signal',to:'describe',input:'signal'},
      {from:'source1',output:'image',to:'describe',input:'image'},
      {from:'describe',output:'text',to:'rewrite',input:'text'},
      {from:'rewrite',output:'text',to:'draw',input:'text'},
      {from:'source1',output:'image',to:'draw',input:'image'},
    ]};
    const built=buildWorkflowPlan(JSON.stringify(plan),owner,sources,[owner]);
    check(buildWorkflowPlan(JSON.stringify(planningContract.result),owner,[],[owner]).nodes.length===2,'contract example is executable');
    const illegalInstruction=structuredClone(plan);illegalInstruction.nodes[1].prompt='反推 {{source1.image}}';
    let specific='';try{buildWorkflowPlan(JSON.stringify(illegalInstruction),owner,sources,[owner]);}catch(error){specific=error.message;}
    check(specific.includes('describe')&&specific.includes('不支持')&&specific.includes('source1.image'),'instruction placeholder failure identifies card and remedy');
    const missingRewrite=structuredClone(plan);missingRewrite.nodes[2].prompt='改为紫色产品';
    try{buildWorkflowPlan(JSON.stringify(missingRewrite),owner,sources,[owner]);}catch(error){specific=error.message;}
    check(specific.includes('rewrite')&&specific.includes('{{describe.text}}'),'missing agent reference identifies required token');
    const [trigger,describe,rewrite,draw]=built.nodes;
    check(workflowOrder([owner,...built.nodes],trigger.id).join(',')===built.nodes.map(node=>node.id).join(','),'topological chain with real IDs');
    check(draw.promptReferences.length===2&&draw.provider==='codex'&&draw.ratio==='3:4','native prompts, provider and ratio');
    rewrite.outputs.text={type:'text',text:'改写后的提示词'};
    check(compileGenerationPrompt(draw,workflowInputValues(built.nodes,generationInputNode(draw))).prompt.includes('改写后的提示词'),'compiled prompt consumes generated text');
    check(workflowConnectionError([trigger,owner],trigger.id,'signal',owner.id,'signal')!==null,'planner cannot be triggered');
    const listening={...owner,inputs:{text:[{nodeId:rewrite.id,portId:'text'}]}};
    check(!workflowOrder([...built.nodes,listening],trigger.id).includes(owner.id),'planner is never downstream executable');
    for(const mutate of [
      p=>p.nodes[1].kind='loop',p=>p.nodes[1].provider='invented',p=>p.nodes[1].id='start',
      p=>p.edges[1].from='unknown',p=>p.edges[1].output='text',p=>p.edges.push(p.edges[0]),
      p=>p.nodes[3].prompt='{{unknown.text}}',p=>p.nodes[3].prompt='ignore connected inputs',
      p=>p.nodes[3].ratio='7:13',p=>p.edges.shift(),p=>p.nodes.push({id:'orphan',kind:'generation',prompt:'x'}),
      p=>p.edges.push({from:'draw',output:'image',to:'describe',input:'image'}),
      p=>p.nodes[2].prompt='@[untrusted]',p=>p.nodes[0].kind='planner',
    ]) {const invalid=structuredClone(plan);mutate(invalid);let rejected=false;try{buildWorkflowPlan(JSON.stringify(invalid),owner,sources,[owner]);}catch{rejected=true;}check(rejected,'invalid plan rejected: '+mutate.toString());}
    let sent=0,reply=null,delivered=false;
    api.agentDsWorkflowStart=async()=>{sent++;return {path:'pending',autoDelivered:delivered,notice:'模拟队列等待'};};
    api.agentDsWorkflowResult=async id=>reply?{schemaVersion:1,requestId:id,...reply}:null;
    const c=new CanvasWorkflowController('planner-life');await c.load();await c.edit([owner]);
    await c.planner.start(owner.id);const request=c.document.nodes[0].planning.requestId;
    check(sent===1&&c.document.nodes[0].planning.status==='waiting','durable waiting state');
    await c.planner.collect(owner.id);check(sent===1,'retrieval does not resubmit');
    const restored=new CanvasWorkflowController('planner-life');await restored.load();
    reply={text:JSON.stringify(window.plan)};await restored.planner.collect(owner.id);
    check(restored.document.nodes.length===3&&sent===1,'reload applies original reply once');
    await restored.planner.collect(owner.id);check(restored.document.nodes.length===3,'duplicate result never duplicates nodes');
    check(restored.document.nodes[0].planning.requestId===request,'request identity kept');
    const savedOwner=restored.document.nodes[0], inserted=restored.document.nodes[1];
    const clip=captureCanvasClipboard('p',new Set([owner.id]),[],[],[],[savedOwner]);
    check(!cloneCanvasClipboard(clip,'p',0,0).workflow[0].planning,'copy clears request and undo ownership');
    check(canUndoWorkflowPlan(savedOwner,restored.document.nodes,()=>false),'pristine plan reversible');
    await restored.edit(restored.document.nodes.map(node=>node.id===inserted.id?{...node,x:node.x+55}:node));
    await restored.planner.undo(owner.id);check(restored.document.nodes.length===1,'moving nodes still permits undo');
    await restored.planner.start(owner.id);await restored.planner.cancel(owner.id);await restored.planner.collect(owner.id);
    check(restored.document.nodes.length===1&&restored.document.nodes[0].planning.status==='cancelled','cancel discards late reply');
    await restored.planner.start(owner.id);await restored.edit(restored.document.nodes.map(node=>({...node,prompt:'用户已经改了需求'})));
    try{await restored.planner.collect(owner.id);}catch{}
    check(restored.document.nodes.length===1&&restored.document.nodes[0].planning.status==='failed','changed requirement refuses stale plan');
    await restored.planner.start(owner.id);reply={text:JSON.stringify({...window.plan,nodes:[{id:'bad',kind:'loop'}]})};
    try{await restored.planner.collect(owner.id);}catch{}
    check(restored.document.nodes.length===1,'invalid result applies nothing');
    reply={text:JSON.stringify(window.plan)};await restored.planner.start(owner.id);await restored.planner.collect(owner.id);
    const generated=restored.document.nodes.find(node=>node.kind==='generation');
    await restored.edit(restored.document.nodes.map(node=>node.id===generated.id?{...node,prompt:'用户修改后的内容'}:node));
    let protectedEdit=false;try{await restored.planner.undo(owner.id);}catch{protectedEdit=true;}
    check(protectedEdit&&restored.document.nodes.length===3,'undo preserves user edits');
    await restored.planner.start(owner.id);
    let resolve;api.agentDsWorkflowResult=()=>new Promise(r=>resolve=r);
    const collecting=restored.planner.collect(owner.id);await restored.planner.cancel(owner.id);
    resolve({schemaVersion:1,requestId:restored.document.nodes[0].planning.requestId,text:JSON.stringify(window.plan)});await collecting;
    check(restored.document.nodes.length===3,'cancel while IPC in flight prevents insertion');
    check(!restored.document.run,'planning never creates an execution run');
    const {useStore}=await import('/src/store.ts');let executed=0;
    api.localAgentFindAssetId=async()=> 'existing';
    useStore.setState({startGeneration:async(...args)=>{
      executed++;const identity=args[12];useStore.setState(s=>({genJobs:{...s.genJobs,[identity.jobId]:{turns:[{turnKey:identity.turnKey,images:['existing.png']}]}}}));return {accepted:true};
    }});
    await restored.start(restored.document.nodes.find(node=>node.kind==='trigger').id);
    check(restored.document.run.status==='done'&&executed===1,'applied cards execute through existing runtime only when explicitly started');
    let ran=false;try{await restored.planner.undo(owner.id);}catch{ran=true;}check(ran,'used workflow cannot be withdrawn');
    // A failed result save keeps one optimistic batch and one request identity for retry.
    const failed=new CanvasWorkflowController('planner-save-fail');await failed.load();await failed.edit([owner]);
    api.agentDsWorkflowResult=async requestId=>({schemaVersion:1,requestId,text:JSON.stringify(window.plan)});
    await failed.planner.start(owner.id);window.failWorkflowSave=true;
    try{await failed.planner.collect(owner.id);}catch{}finally{window.failWorkflowSave=false;}
    check(!!failed.error&&failed.document.nodes.length===3,'save failure is visible and does not drop proposal');
    await failed.retrySave();await failed.planner.collect(owner.id);
    check(!failed.error&&failed.document.nodes.length===3,'retry saves same batch without duplicates');
    const identity=new CanvasWorkflowController('planner-identity');await identity.load();await identity.edit([owner]);await identity.planner.start(owner.id);
    api.agentDsWorkflowResult=async()=>({schemaVersion:1,requestId:'wrong',text:JSON.stringify(window.plan)});
    try{await identity.planner.collect(owner.id);}catch{}
    check(identity.document.nodes.length===1&&identity.document.nodes[0].planning.status==='failed','uncorrelated reply is rejected');
    const connected=new CanvasWorkflowController('planner-sources');await connected.load();
    await connected.edit([{...owner,inputs:{image:[{assetId:'existing',assetNodeId:'old'}]}}]);
    await connected.planner.start(owner.id);
    api.agentDsWorkflowResult=async requestId=>({schemaVersion:1,requestId,text:JSON.stringify(plan)});
    await connected.planner.collect(owner.id);
    check(connected.document.nodes.length===5&&connected.document.nodes.find(node=>node.kind==='instruction').inputs.image[0].assetNodeId==='old','connected source is bound to the original canvas instance');
    await connected.planner.undo(owner.id);await connected.planner.start(owner.id);
    const getCanvas=api.projectCanvasGet;
    api.projectCanvasGet=async(...args)=>{const value=await getCanvas(...args);return {...value,nodes:value.nodes.filter(node=>node.id!=='old')};};
    try{await connected.planner.collect(owner.id);}catch{}finally{api.projectCanvasGet=getCanvas;}
    check(connected.document.nodes.length===1&&connected.document.nodes[0].planning.status==='failed','removed source instance invalidates pending plan');
    const cells=['page-one','page-two','page-three'];
    api.projectCanvasGet=async(...args)=>({...await getCanvas(...args),nodes:[{id:'pages',kind:'note',hiddenAt:null,payloadJson:JSON.stringify({cells:cells.map(id=>[{id,content_type:'image',image_refs:[{asset_id:'existing',token:'@图片1'}],text:''}])})}]});
    const pages=new CanvasWorkflowController('planner-pages');await pages.load();
    await pages.edit([{...owner,inputs:{image:[{canvasNodeId:'pages',cellId:'*'},{assetId:'existing'}]}}]);
    await pages.planner.start(owner.id);
    const pageSources=pages.document.nodes[0].planning.sources;
    check(pageSources.length===5&&pageSources.at(-1).id==='source2','child aliases preserve original source numbering');
    check(cells.every((cell,index)=>pageSources[index+1].input.cellId===cell&&pageSources[index+1].id===`source1_cell${index+1}`),'each page has a scoped cell binding');
    const threePages={summary:'三页独立改图',nodes:[{id:'start',kind:'trigger'},...cells.map((_,i)=>({id:`page${i}`,kind:'generation',prompt:`保持 {{source1_cell${i+1}.image}} 版式，产品使用 {{source2.image}}，产品名紫心宝螺。`}))],edges:cells.flatMap((_,i)=>[{from:'start',output:'signal',to:`page${i}`,input:'signal'},{from:`source1_cell${i+1}`,output:'image',to:`page${i}`,input:'image'},{from:'source2',output:'image',to:`page${i}`,input:'image'}])};
    api.agentDsWorkflowResult=async requestId=>({schemaVersion:1,requestId,text:JSON.stringify(threePages)});
    await pages.planner.collect(owner.id);
    check(pages.document.nodes.length===5&&pages.document.nodes.slice(2).every((node,i)=>node.inputs.image.length===2&&node.inputs.image[0].cellId===cells[i]),'three-page edit applies distinct references through runtime');
    await pages.planner.undo(owner.id);await pages.planner.start(owner.id);
    const expandedCanvas=api.projectCanvasGet;
    api.projectCanvasGet=async(...args)=>{const canvas=await expandedCanvas(...args);canvas.nodes[0].payloadJson=JSON.stringify({cells:[[{id:'replacement',content_type:'image',image_refs:[{asset_id:'existing',token:'@图片1'}],text:''}]]});return canvas;};
    try{await pages.planner.collect(owner.id);}catch{}
    check(pages.document.nodes.length===1&&pages.document.nodes[0].planning.status==='failed','changed image cells invalidate in-flight plan');
    api.projectCanvasGet=expandedCanvas;await pages.planner.start(owner.id);
    const getAssets=api.getAssetsByIds;
    api.getAssetsByIds=async ids=>{const originals=await getAssets(['existing']);return ids.map(id=>({...originals[0],id}));};
    api.projectCanvasGet=async(...args)=>{const canvas=await expandedCanvas(...args);const note=JSON.parse(canvas.nodes[0].payloadJson);note.cells[0][0].image_refs[0].asset_id='replacement-image';canvas.nodes[0].payloadJson=JSON.stringify(note);return canvas;};
    try{await pages.planner.collect(owner.id);}catch{}
    check(pages.document.nodes.length===1&&pages.document.nodes[0].planning.error.includes('来源已变化'),'same cell with same image metadata but different asset rejects stale plan');
    api.getAssetsByIds=getAssets;
    api.projectCanvasGet=getCanvas;
    return {checks};
  });
  assert.deepEqual(errors,[]);
  console.log('workflow planner UI + validation + recovery + cancellation + undo:',result);
} finally {await browser.close();await server.close();}
