import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server=await createServer({configFile:false,root:process.cwd(),server:{host:'127.0.0.1',port:1655,strictPort:true,hmr:false,watch:null}});
await server.listen();const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1600,height:1000}});
try {
  await page.goto('http://127.0.0.1:1655/scripts/fixtures/canvas-reference/preview.html');await page.locator('[data-canvas-node-id="old"]').waitFor();
  console.log(await page.evaluate(async()=>{
    const {api}=await import('/src/lib/api.ts');
    const {canvasWorkflowController,CanvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const {newWorkflowNode,workflowInputValues}=await import('/src/lib/canvasWorkflow.ts');
    const {canvasContentInput}=await import('/src/lib/canvasContentInput.ts');
    const {readCanvasNote}=await import('/src/lib/canvasNotes.ts');
    const {canvasInputValue}=await import('/src/lib/canvasSessionOutputs.ts');
    const check=(ok,message)=>{if(!ok)throw Error(message);};
    const c=canvasWorkflowController('p');await c.load();const base=window.snapshot().nodes[0];
    const session={...base,id:'generated-turn',kind:'prompt',assetId:null,role:null,x:700,y:200,hiddenAt:null,payloadJson:JSON.stringify({schema_version:1,job_id:'j',turn_key:'t',text:'画产品',status:'running'})};
    await api.projectCanvasNodeCreate(session);
    await api.projectCanvasNodeCreate({...base,id:'receiver',kind:'note',assetId:null,role:null,x:800,y:500,hiddenAt:null,payloadJson:JSON.stringify({schema_version:1,note_type:'text',title:'接收',member_ids:[],text:'',cells:[[{id:'cell',text:'旧值'},{id:'neighbor',text:'保留'}]]})});
    const producer={...newWorkflowNode('agent',250,250,''),id:'producer',agentTransport:'codex-cli',prompt:'画产品',inputs:{}};
    const writer={...newWorkflowNode('text',0,0,''),id:'writer',textTarget:{nodeId:'receiver',cellId:'cell',image:true},inputs:{image:[{nodeId:'producer',portId:'image'}]}};
    let starts=0,consumerImages=[];
    api.agentDsWorkflowGenerationRequest=async()=>null;
    api.agentDsWorkflowStart=async(requestId,_prompt,_source,_purpose,images,scope)=>{
      starts++;
      if(scope.nodeId==='producer') {
        const run=c.document.run;const step=run.steps.producer;
        const updated={...run,steps:{...run.steps,producer:{...step,localDsGenerations:{call:{request:{id:'call',prompt:'画产品',images:[],ratio:null},jobId:'j',turnKey:'t',response:{submitted:{jobId:'j',turnKey:'t',sessionNodeId:session.id}}}}}}};
        await c.save({...c.document,run:updated,runs:c.document.runs.map(r=>r.id===run.id?updated:r)});
      }else consumerImages=images;
      return {autoDelivered:true,path:'synthetic'};
    };
    api.agentDsWorkflowResult=async requestId=>({schemaVersion:1,requestId,text:'已处理'});
    await c.edit([producer,writer]);
    await Promise.race([c.start('producer',true),new Promise((_,reject)=>setTimeout(()=>reject(Error('cell delivery waited for generation')),4000))]);
    check(c.document.run.status==='done',JSON.stringify(c.issue));
    const note=()=>readCanvasNote(window.snapshot().nodes.find(n=>n.id==='receiver'));
    check(note().cells[0][0].generation_ref.session_node_id===session.id&&!note().cells[0][0].image_refs.length,'pending turn stored in exact cell');
    check(note().cells[0][1].text==='保留','neighbor preserved');
    const image=c.document.nodes.find(n=>n.id==='producer').outputs.image;
    check(image.type==='image'&&image.nodeIds[0]===session.id&&!c.document.nodes.find(n=>n.id==='producer').outputs.session,'one typed image delivery');
    const reload=new CanvasWorkflowController('p');await reload.load();await reload.continue();check(starts===1,'completed reload never resubmits');
    // Main input accepts mixed ordinary images and multiple pending turns in separate cells.
    const batch=canvasContentInput(note(),{nodeId:'receiver',cellId:'cell',append:true,image:true},{type:'image',assetIds:['a'],nodeIds:['one','two']});
    check(batch.cellIds.length===3,'each media item owns one cell');
    check(batch.note.cells.flat().filter(cell=>cell.generation_ref).length===2,'both pending tasks retained');
    let rejected=false;try{canvasContentInput(note(),writer.textTarget,{type:'image',nodeIds:['one','two']});}catch{rejected=true;}check(rejected,'fixed cell cannot silently discard multiple pending tasks');
    // A failed cell save retries only delivery and preserves the same task.
    const oldUpdate=api.projectCanvasNoteUpdate;let failOnce=true;
    api.projectCanvasNoteUpdate=async(...args)=>{if(failOnce){failOnce=false;throw Error('synthetic write failure');}return oldUpdate(...args);};
    await c.start('writer',true);check(c.document.run.status==='waiting','write failure recoverable');const before=starts;
    await c.continue();check(c.document.run.status==='done'&&starts===before,'retry writes original generation ref without a model call');api.projectCanvasNoteUpdate=oldUpdate;
    // Consumers wait for actual pixels; they must not run on the empty placeholder.
    const consumer={...newWorkflowNode('agent',600,600,''),id:'consumer',agentTransport:'codex-cli',prompt:'检查图片',inputs:{image:[{nodeId:'producer',portId:'image'}]}};
    await c.edit([...c.document.nodes,consumer]);const running=c.start('consumer',true);
    await new Promise(resolve=>setTimeout(resolve,200));check(starts===before,'consumer is waiting, no premature submission');
    await api.projectCanvasNodeCreate({...base,id:'output-b',kind:'asset',assetId:'b',role:'output',hiddenAt:null,payloadJson:JSON.stringify({schema_version:1,execution:{job_id:'j',turn_key:'t'}})});
    await api.projectCanvasNodeUpdate(session.id,{payloadJson:JSON.stringify({...JSON.parse(session.payloadJson),status:'done'})});
    await Promise.race([running,new Promise((_,reject)=>setTimeout(()=>reject(Error('consumer did not resolve completed turn')),5000))]);check(c.document.run.status==='done'&&consumerImages.length===1,'consumer receives completed image');
    check(!image.assetIds?.length,'resolving consumer never mutates producer snapshot');
    await c.syncCanvasReferences(window.snapshot().nodes);check(note().cells[0][0].image_refs[0].asset_id==='b','same cell becomes ordinary image');
    const legacy={...producer,outputs:{session:{type:'session',nodeIds:[session.id]}}};
    check(workflowInputValues([legacy,consumer],consumer).image[0].nodeIds[0]===session.id,'legacy saved session output readable through image interface');
    const pendingNote={...window.snapshot().nodes.find(n=>n.id==='receiver'),payloadJson:JSON.stringify({...note(),cells:[[{id:'cell',content_type:'image',text:'',image_refs:[],generation_ref:{session_node_id:'still-running'}}]]})};
    check(canvasInputValue(pendingNote,'cell',[]).nodeIds[0]==='still-running','pending embedded cell preserves dependency identity');
    const {workflowLoopItems}=await import('/src/lib/workflowLoop.ts');
    const loop={...newWorkflowNode('loop',0,0,''),id:'new-loop',inputs:{image:[{nodeId:'producer',portId:'image'}]}};
    check(workflowLoopItems(loop,c.document.nodes,window.snapshot().nodes)[0].assetIds[0]==='b','loop preview reads finished turn');
    const loopBody={...consumer,id:'loop-body',inputs:{image:[{nodeId:loop.id,portId:'image'}]}};
    await c.edit([...c.document.nodes,loop,loopBody]);
    await api.projectCanvasNodeUpdate(session.id,{payloadJson:JSON.stringify({...JSON.parse(session.payloadJson),status:'running'})});
    const beforeLoop=starts,loopRun=c.start(loop.id);
    await new Promise(resolve=>setTimeout(resolve,200));check(starts===beforeLoop,'loop waits for upstream image');
    await api.projectCanvasNodeUpdate(session.id,{payloadJson:JSON.stringify({...JSON.parse(session.payloadJson),status:'done'})});
    await Promise.race([loopRun,new Promise((_,reject)=>setTimeout(()=>reject(Error('loop did not resolve turn')),5000))]);
    check(c.document.run.status==='done'&&c.document.run.loop.completed.length===1,'loop executes exact resolved image');
    await api.projectCanvasNodeUpdate(session.id,{payloadJson:JSON.stringify({...JSON.parse(session.payloadJson),status:'failed'})});
    const beforeFailure=starts;await c.start('consumer',true);
    check(c.document.run.status==='failed'&&starts===beforeFailure,'failed generation blocks consumer without model submission');
    window.save();return 'PASS image port delivery: async fixed cell, mixed multi-task main input, no silent loss, reload, failed-write recovery, waiting consumer, exact turn completion and legacy outputs';
  }));
  const card=page.locator('[data-workflow-card="producer"]');assert.equal(await card.getByRole('button',{name:'输出：返回图片',exact:true}).count(),1);assert.equal(await card.getByRole('button',{name:'输出：生成任务',exact:true}).count(),0);
} finally {await browser.close();await server.close();}
