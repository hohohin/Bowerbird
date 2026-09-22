import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server=await createServer({configFile:false,root:process.cwd(),server:{host:'127.0.0.1',port:1580,strictPort:true,hmr:false,watch:null}});
await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage();
try {
  await page.goto('http://127.0.0.1:1580/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  const result=await page.evaluate(async()=>{
    const {api}=await import('/src/lib/api.ts');
    const {CanvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const {newWorkflowNode}=await import('/src/lib/canvasWorkflow.ts');
    const {useStore}=await import('/src/store.ts');
    const check=(value,message)=>{if(!value)throw new Error(message);};
    const create=async(name,nodes)=>{const c=new CanvasWorkflowController(name);await c.load();await c.edit(nodes);return c;};
    const input={assetId:'existing'};
    const a={...newWorkflowNode('instruction',0,0,'codex'),id:'a',action:'reuse',inputs:{image:[input]}};
    const b={...newWorkflowNode('generation',400,0,'codex'),id:'b',prompt:'柔和光线',inputs:{text:[{nodeId:'a',portId:'text'}],image:[{nodeId:'a',portId:'image'}]}};
    let submissions=0,release,started;
    const submitted=new Promise(resolve=>{started=resolve;});
    const finished=new Promise(resolve=>{release=resolve;});
    useStore.setState({startGeneration:async(...args)=>{
      submissions++;
      const identity=args[12];
      const persisted=JSON.parse(sessionStorage.getItem('workflow-runtime-chain')).document;
      check(persisted.run.steps.b.jobId===identity.jobId,'job identity must persist before provider call');
      check(args[0]==='保持产品主体，生成清晨场景\n\n柔和光线','upstream text and local prompt must combine');
      check(args[1][0].id==='existing','upstream references must bind');
      check(args[9].projectId==='runtime-chain','project is frozen');
      started();await finished;
      useStore.setState(s=>({genJobs:{...s.genJobs,[identity.jobId]:{turns:[{images:['output.png']}]} }}));
      return {accepted:true,jobId:identity.jobId};
    }});
    api.localAgentFindAssetId=async()=> 'output';
    const controller=await create('runtime-chain',[a,b]);
    const running=controller.start('a');
    await submitted;
    let duplicate=false;try {await controller.start('a');}catch {duplicate=true;}
    check(duplicate&&submissions===1,'double start must not submit twice');
    useStore.setState({activeProjectId:'different-project'});
    release();await running;
    check(controller.document.run.status==='done','chain completes');
    check(controller.document.nodes[1].outputs.session.nodeIds[0]===controller.document.nodes[1].sessionNodeIds[0],'generation returns its session');
    check(controller.document.nodes[1].sessionNodeIds[0].startsWith('gen-prompt:'),'session binding is persisted');
    const single=await create('runtime-single',[a,b]);await single.start('a',true);
    check(single.document.run.order.join(',')==='a'&&submissions===1,'single card does not run descendants or require a key');
    const history=api.generationHistory;
    api.generationHistory=async()=>{throw new Error('模拟失败');};
    const broken=await create('runtime-error',[a,b]);await broken.start('a');
    check(broken.document.run.status==='failed'&&broken.document.run.steps.a.status==='failed'&&submissions===1,'error terminates the flow before downstream');
    await broken.edit(broken.document.nodes);check(!broken.isLocked('a'),'error unlocks editing');
    api.generationHistory=history;

    // Relaunch an interrupted persisted run: recover by job id without resubmission.
    const persisted=structuredClone(controller.document);
    persisted.run.status='running';persisted.run.steps.b.status='running';persisted.nodes[1].outputs={};
    sessionStorage.setItem('workflow-runtime-resume',JSON.stringify({revision:1,document:persisted}));
    api.recentGenSessions=async()=>[{id:persisted.run.steps.b.jobId,status:'done',turns:[{images:['output.png']}]}];
    const resumed=new CanvasWorkflowController('runtime-resume');await resumed.load();await resumed.continue();
    check(resumed.document.run.status==='done'&&submissions===1,'recovery must not generate again');

    // Write failure must stop before any provider side effect.
    const failed=await create('runtime-save',[{...b,inputs:{},prompt:'test'}]);
    window.failWorkflowSave=true;let rejected=false;
    try {await failed.start('b');}catch {rejected=true;}
    check(rejected&&submissions===1,'failed save must block provider');window.failWorkflowSave=false;

    // Describe produces individually typed dimensions; reordering does not change port identity.
    useStore.setState({defaultUnderstandProvider:'bowerbird-cloud',cloudAuth:{logged_in:true,cloud_available:true,user_id:'test'}});
    api.describeAsset=async()=> 'analysis';
    api.listAnalysesByAsset=async()=>[{id:'analysis',payload:JSON.stringify({sections:[{title:'颜色',body:'蓝色'},{title:'构图',body:'居中'}]})}];
    const describe=await create('runtime-describe',[{...a,action:'describe'}]);await describe.start('a');
    check(describe.document.nodes[0].outputs['dimension-'+encodeURIComponent('颜色')].text==='蓝色','dimensions are independent');
    check(describe.document.nodes[0].outputs.text.text.includes('颜色：蓝色'),'aggregate prompt is forwarded');

    // Decomposition runs directly and marks the original asset only after result persistence.
    const dataUrl='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>');
    const layerDocument={schemaVersion:1,width:8,height:8,layers:[{id:'l0',name:'底图',dataUrl,x:0,y:0,width:8,height:8,opacity:1,visible:true,background:true},{id:'l1',name:'主体',dataUrl,x:0,y:0,width:8,height:8,opacity:1,visible:true,background:false}]};
    let workspace=null,layerStarts=0;
    api.layerWorkspaceLoad=async()=>workspace;
    api.layerWorkspaceSave=async(id,value)=>{workspace=structuredClone(value);};
    api.readImageDataUrl=async()=> 'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="red"/></svg>');
    api.layerCloudRequest=async request=>{
      if(request.action==='layer_quote')return {services:[{service:'image_layer_decompose',available:true}]};
      if(request.action==='get_by_key')return layerStarts?{status:'succeeded',layer_result:{document:layerDocument}}:{status:'not_found'};
      layerStarts++;check(workspace.pending.request.idempotency_key===request.idempotency_key,'save before split');
      check(!useStore.getState().layerWorkspaceIds.has('existing'),'do not mark before saved result');
      return {status:'succeeded',layer_result:{document:layerDocument}};
    };
    let exported=0;
    api.layerExport=async(assetId,doc,data,projectId,workflow)=>{
      check(workflow===true,'workflow export uses deduplicated canvas-only mode');
      check(doc.layers[0].background===true,'export must preserve native background-first contract');
      check(doc.layers.filter(layer=>layer.visible).length===1,'only the selected layer is rendered');
      return {id:['a','b'][exported++]};
    };
    useStore.setState({layerEditor:null,layerWorkspaceIds:new Set()});
    let releaseFirst;const firstHeld=new Promise(resolve=>{releaseFirst=resolve;});
    const described=[],completedDescriptions=[];
    api.describeAsset=async(id,instruction,provider,jobId)=>{
      check(jobId&&JSON.stringify(layers.document.run.steps['describe-layers'].describeJobIds).includes(jobId),'describe identity saved before submission');
      described.push(id);
      if(id==='a')await firstHeld;
      else releaseFirst();
      completedDescriptions.push(id);return 'analysis-'+id;
    };
    api.listAnalysesByAsset=async id=>[{id:'analysis-'+id,payload:JSON.stringify({sections:[{title:'提示词',body:'素材 '+id+' 的描述'}]})}];
    const downstream={...newWorkflowNode('instruction',500,0,'codex'),id:'describe-layers',action:'describe',inputs:{image:[{nodeId:'a',portId:'image'}]}};
    const layers=await create('runtime-layers',[{...a,action:'layers'},downstream]);await layers.start('a');
    check(layers.document.run.status==='done'&&layerStarts===1&&!useStore.getState().layerEditor,'direct split without modal');
    check(useStore.getState().layerWorkspaceIds.has('existing')&&workspace.document&&!workspace.pending,'source badge after save');
    check(layers.document.nodes[0].outputs['layer-l1'].assetIds[0]==='b','layer images are forwarded');
    check(layers.document.nodes[0].outputs.image.assetIds.join(',')==='a,b','all layers available on product output');
    const productGroupId=layers.document.nodes[0].resultGroupId;
    const productCanvas=await api.projectCanvasGet('runtime-layers');
    check(productCanvas.groups.some(group=>group.id===productGroupId),'products have a visible canvas folder');
    check(productCanvas.groupItems.filter(item=>item.groupId===productGroupId).length===2,'folder contains every product');
    check(described.join(',')==='a,b','layer outputs described individually in order');
    check(completedDescriptions.join(',')==='b,a','second description finishes while first is pending');
    const tableId=layers.document.nodes[1].resultNodeIds[0];
    const table=(await api.projectCanvasGet('runtime-layers')).nodes.find(node=>node.id===tableId);
    const tableData=JSON.parse(table.payloadJson);
    check(tableData.cells.length===3&&tableData.cells.every(row=>row.length===2),'two material rows plus a header, exactly two columns');
    check(tableData.cells[0].map(cell=>cell.text).join(',')==='素材,提示词','table headings');
    check(tableData.cells[1][1].text.includes('素材 a')&&tableData.cells[2][1].text.includes('素材 b'),'one prompt per material');
    // Existing decomposition is reused; refreshed table cells relay this run's text to generation.
    const cloudBefore=api.layerCloudRequest;
    api.layerCloudRequest=async()=>{throw new Error('cached layers must not call Cloud');};
    api.describeAsset=async id=>'fresh-'+id;
    api.listAnalysesByAsset=async id=>[{id:'fresh-'+id,payload:JSON.stringify({sections:[{title:'提示词',body:'本次更新 '+id}]})}];
    let relayed='';
    useStore.setState({startGeneration:async(...args)=>{
      relayed=args[0];const identity=args[12];
      useStore.setState(s=>({genJobs:{...s.genJobs,[identity.jobId]:{turns:[{images:['output.png']}]} }}));
      return {accepted:true,jobId:identity.jobId};
    }});
    let profileStatus='draft',profileExtractions=0;
    const sideProfile={...newWorkflowNode('visual-profile',900,0,'codex'),id:'side-profile',prompt:'统一色彩'};
    api.visualProfileInputPreview=async()=>[];
    api.visualProfileExtractInputs=async()=>{profileExtractions++;return {id:'side-profile-result'};};
    api.visualProfileGet=async()=>({id:'side-profile-result',status:profileStatus,version:1,summary:'统一色彩'});
    await layers.edit([...layers.document.nodes,sideProfile,{...b,id:'table-generation',prompt:'',inputs:{text:[{canvasNodeId:tableId,cellId:tableData.cells[1][1].id}],'visual-profile':[{nodeId:'side-profile',portId:'visual-profile'}]}}]);
    exported=0;
    await layers.start('a');
    check(layers.document.run.status==='waiting'&&layers.document.run.steps['side-profile'].status==='waiting'&&relayed==='','missing side profile joins run and pauses for confirmation');
    profileStatus='confirmed';await layers.continue();
    check(layers.document.run.status==='done'&&layers.document.run.order.includes('table-generation')&&profileExtractions===1,'text table continues downstream after side-profile confirmation without resubmission');
    check(relayed.includes('本次更新 a')&&!relayed.includes('素材 a 的描述'),'generation reads this run rather than frozen old table');
    check(layers.document.nodes[1].resultNodeIds.length===1,'rerun updates original result table without breaking wires');
    const rerunCanvas=await api.projectCanvasGet('runtime-layers');
    check(rerunCanvas.groups.filter(group=>group.id===productGroupId).length===1&&rerunCanvas.groupItems.filter(item=>item.groupId===productGroupId).length===2,'rerun reuses folder and members');
    api.layerCloudRequest=cloudBefore;
    api.listAnalysesByAsset=async id=>[{id:'analysis-'+id,payload:JSON.stringify({sections:[{title:'提示词',body:'素材 '+id+' 的描述'}]})}];
    // Failure cancels this batch; stopping another batch does not cancel a concurrent workflow.
    const batch={...a,action:'describe',inputs:{image:[{assetId:'a'},{assetId:'b'}]}};
    const held=new Map(),cancelledDescriptions=[];
    let allStarted;
    let startedBatch=new Promise(resolve=>{allStarted=resolve;});
    api.describeAsset=(asset,instruction,provider,job)=>new Promise((resolve,reject)=>{
      held.set(job,{asset,resolve,reject});if(held.size===4)allStarted();
    });
    api.cancelCodexDescribe=async job=>{cancelledDescriptions.push(job);held.get(job)?.reject(new Error('已取消'));};
    const stopBatch=await create('runtime-batch-stop',[batch]);
    const otherBatch=await create('runtime-batch-other',[batch]);
    const stopWork=stopBatch.start('a'),otherWork=otherBatch.start('a');
    await startedBatch;
    const stoppedJobs=stopBatch.document.run.steps.a.describeJobIds;
    await stopBatch.stop();await stopWork;
    check(cancelledDescriptions.every(job=>stoppedJobs.includes(job)),'stop never cancels another batch');
    for(const job of otherBatch.document.run.steps.a.describeJobIds)held.get(job).resolve('analysis-'+held.get(job).asset);
    await otherWork;
    check(stopBatch.document.run.status==='stopped'&&otherBatch.document.run.status==='done','stop isolation');
    check(!stopBatch.document.nodes[0].resultNodeIds,'stopped batch creates no result table');
    held.clear();cancelledDescriptions.length=0;
    startedBatch=new Promise(resolve=>{allStarted=resolve;});
    api.describeAsset=(asset,instruction,provider,job)=>new Promise((resolve,reject)=>{
      held.set(job,{asset,resolve,reject});if(held.size===2)allStarted();
    });
    const failBatch=await create('runtime-batch-fail',[batch,{...b,inputs:{text:[{nodeId:'a',portId:'text'}]}}]);
    const failWork=failBatch.start('a');await startedBatch;
    const failedJobs=failBatch.document.run.steps.a.describeJobIds;
    held.get(failedJobs[0]).reject(new Error('模拟第一张反推失败'));
    await failWork;
    check(failBatch.document.run.status==='failed'&&failBatch.document.run.steps.b.status==='pending','failure blocks downstream');
    check(cancelledDescriptions.includes(failedJobs[1])&&!failBatch.document.nodes[0].resultNodeIds,'failure cancels remaining requests and produces no partial table');
    const {workflowLayerDecompose}=await import('/src/lib/workflowLayerDecompose.ts');
    await workflowLayerDecompose('existing','source.png','',layers.document.run.steps.a.layerRequestKey,false,()=>false);
    check(layerStarts===1,'recovery queries original split instead of creating again');
    const savedAuth=useStore.getState().cloudAuth;
    useStore.setState({cloudAuth:null});
    const cachedDocument=await workflowLayerDecompose('existing','source.png','','new-run-key',true,()=>false);
    check(cachedDocument.layers.length===2&&layerStarts===1,'saved layers reusable offline without creating a decomposition');
    useStore.setState({cloudAuth:savedAuth});
    workspace=null;
    const saveWorkspace=api.layerWorkspaceSave;api.layerWorkspaceSave=async()=>{throw new Error('模拟保存失败');};
    let splitRejected=false;try {await workflowLayerDecompose('existing','source.png','','new-split',true,()=>false);}catch{splitRejected=true;}
    check(splitRejected&&layerStarts===1,'failed pending save prevents split submission');api.layerWorkspaceSave=saveWorkspace;

    // A Skill is the existing unified Agent; approve/accept remains in that Agent UI.
    let skillStarts=0;
    useStore.setState({cloudEntitlement:{user_id:'test',is_test_account:true,policy:{can_use_agent_runs:true,max_parallel_agent_runs:1,allowed_agent_skills:['bowerbird-unified-agent'],agent_budget_options:['controlled-standard']}}});
    const agent={runId:'agent-run',conversationId:'agent-conversation',skillId:'bowerbird-unified-agent',status:'awaiting_approval',snapshot:{run:{},artifacts:[],events:[]}};
    api.cloudAgentStart=async request=>{skillStarts++;check(request.skillId==='bowerbird-unified-agent','reuse unified Agent');return agent;};
    api.cloudAgentGet=async()=>({...agent,status:'succeeded',snapshot:{run:{},events:[],artifacts:[{id:'final',role:'final_result',mime:'image/png',user_visible:true}]}});
    api.cloudAgentIngestArtifacts=async()=>[{id:'agent-image'},{id:'agent-image-2'}];
    const skill=await create('runtime-skill',[{...newWorkflowNode('skill',0,0,'codex'),id:'s',prompt:'生成图片'}]);
    await skill.start('s');check(skill.document.run.status==='waiting','Agent pauses for approval');
    await skill.continue();check(skill.document.nodes[0].outputs.image.assetIds.join(',')==='agent-image,agent-image-2'&&skillStarts===1,'whole Agent result recovered without second start');
    // Independent runs overlap in time; editing and cancellation must remain local.
    const gen=id=>({...newWorkflowNode('generation',0,0,'codex'),id,prompt:id});
    const parallel=await create('runtime-parallel',[gen('one'),gen('two'),gen('draft')]);
    const pending=new Map();let signal;
    const bothStarted=new Promise(resolve=>{signal=resolve;});
    useStore.setState({startGeneration:async(...args)=>{
      const identity=args[12];
      await new Promise(resolve=>{pending.set(args[0],{resolve,identity});if(pending.size===2)signal();});
      useStore.setState(s=>({genJobs:{...s.genJobs,[identity.jobId]:{turns:[{images:[args[0]+'.png']}]} }}));
      return {accepted:true};
    }});
    const one=parallel.start('one',true),two=parallel.start('two',true);
    await bothStarted;
    check(parallel.document.runs.filter(r=>r.status==='running').length===2,'two simultaneous runs persist');
    check(parallel.isLocked('one')&&parallel.isLocked('two')&&!parallel.isLocked('draft'),'only participating cards lock');
    await parallel.edit([...parallel.document.nodes.map(n=>n.id==='draft'?{...n,prompt:'edited while running'}:n),gen('new')]);
    let locked=false;try {await parallel.edit(parallel.document.nodes.filter(n=>n.id!=='one'));}catch {locked=true;}
    check(locked,'running card cannot be deleted');
    const runOne=parallel.document.runs.find(r=>r.startId==='one'),runTwo=parallel.document.runs.find(r=>r.startId==='two');
    const beforeStop=structuredClone(parallel.document);
    const cancelled=[];api.cancelCodexCreate=async id=>{cancelled.push(id);};
    await parallel.stop(runOne.id);
    check(cancelled.join()===pending.get('one').identity.jobId&&parallel.run(runTwo.id).status==='running','stop targets only its own provider');
    await parallel.edit(parallel.document.nodes.map(n=>n.id==='one'?{...n,prompt:'new definition'}:n));
    pending.get('two').resolve();await two;
    pending.get('one').resolve();await one;
    check(parallel.document.runs.find(r=>r.id===runTwo.id).status==='done','second run completes independently');
    check(!parallel.document.nodes.find(n=>n.id==='one').outputs.image&&parallel.document.nodes.find(n=>n.id==='one').prompt==='new definition','late stopped result cannot overwrite edits');
    check(parallel.document.nodes.find(n=>n.id==='draft').prompt==='edited while running'&&parallel.document.nodes.some(n=>n.id==='new'),'concurrent writes preserve edits');
    sessionStorage.setItem('workflow-parallel-recovery',JSON.stringify({revision:1,document:beforeStop}));
    const recovery=new CanvasWorkflowController('parallel-recovery');await recovery.load();
    check(recovery.document.runs.every(r=>r.status==='waiting'),'all interrupted runs restore as waiting');
    api.recentGenSessions=async()=>[...pending.values()].map(p=>({id:p.identity.jobId,status:'done',turns:[{images:['output.png']}]}));
    await recovery.continue(runTwo.id);
    check(recovery.document.runs.find(r=>r.id===runOne.id).status==='waiting','continue does not resume another run');
    await recovery.continue(runOne.id);
    check(recovery.document.runs.every(r=>r.status==='done')&&pending.size===2,'both recover without resubmission');
    const upstream=await create('runtime-lock-upstream',[{...a,outputs:{text:{type:'text',text:'cached'},image:{type:'image',assetIds:['existing']}}},b,gen('free')]);
    let upstreamStarted;const queued=new Promise(resolve=>{upstreamStarted=resolve;});let releaseUpstream;
    useStore.setState({startGeneration:async()=>{upstreamStarted();await new Promise(resolve=>{releaseUpstream=resolve;});throw new Error('intentional failure');}});
    const upstreamRun=upstream.start('b',true);await queued;
    check(upstream.isLocked('a')&&upstream.isLocked('b')&&!upstream.isLocked('free'),'dependency ancestors lock without locking unrelated cards');
    let overlap=false;try {await upstream.start('a',true);}catch {overlap=true;}
    check(overlap,'overlapping run rejected');releaseUpstream();await upstreamRun;
    check(!upstream.isLocked('a'),'failure releases only its locks');
    return {submissions,skillStarts,checks:8};
  });
  assert.deepEqual(result,{submissions:1,skillStarts:1,checks:8});
  console.log('workflow runtime: chain, duplicate start, project switch, saved-job recovery, save failure, dimensions, layers and unified Skill passed');
} finally {await browser.close();await server.close();}
