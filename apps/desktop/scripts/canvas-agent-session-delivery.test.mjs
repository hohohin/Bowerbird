import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ configFile:false, root:process.cwd(), server:{ host:'127.0.0.1', port:1661, strictPort:true, hmr:false, watch:null } });
await server.listen();const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();
try {
 await page.goto('http://127.0.0.1:1661/scripts/fixtures/canvas-reference/preview.html');await page.locator('[data-canvas-node-id="old"]').waitFor();
 console.log(await page.evaluate(async()=>{
  const {api}=await import('/src/lib/api.ts');
  const {CanvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
  const {newWorkflowNode}=await import('/src/lib/canvasWorkflow.ts');
  const {useStore}=await import('/src/store.ts');
  const check=(ok,message)=>{if(!ok)throw Error(message);};
  const base=window.snapshot().nodes[0],requests=new Map();let c,table,submissions=0,deliveries=0,callCount=1,ready=false,failResult=false,failSave='';
  const originalUpdate=api.projectCanvasNoteUpdate;
  api.projectCanvasNoteUpdate=async(...args)=>{const fail=failSave;failSave='';if(fail==='before')throw Error('before write');const out=await originalUpdate(...args);if(fail==='after')throw Error('after write');return out;};
  api.agentDsWorkflowStart=async id=>{deliveries++;requests.set(id,{index:0,calls:Array.from({length:callCount},()=>({id:crypto.randomUUID(),prompt:'画图',images:[]}))});return {autoDelivered:true};};
  api.agentDsWorkflowGenerationRequest=async id=>{const r=requests.get(id);return r?.calls[r.index]??null;};
  api.agentDsWorkflowGenerationResponse=async id=>{requests.get(id).index++;};
  api.agentDsWorkflowResult=async id=>{if(failResult)throw Error('Agent final reply interrupted');const r=requests.get(id);return ready&&r.index===r.calls.length?{schemaVersion:1,requestId:id,text:'已提交'}:null;};
  useStore.setState({defaultProvider:'jimeng',startGeneration:async(...args)=>{
    submissions++;const identity=args[12];
    await api.projectCanvasNodeCreate({...base,id:`gen-prompt:${identity.jobId}:${identity.turnKey}:0`,kind:'prompt',assetId:null,role:null,payloadJson:JSON.stringify({schema_version:1,job_id:identity.jobId,turn_key:identity.turnKey,status:'running'})});
    return {accepted:true};
  }});
  const setup=async(loop=false)=>{
    c=new CanvasWorkflowController('eager-'+crypto.randomUUID());await c.load();table='table-'+crypto.randomUUID();
    await api.projectCanvasNodeCreate({...base,id:table,kind:'note',assetId:null,role:null,payloadJson:JSON.stringify({schema_version:1,note_type:'text',text:'',cells:[[{id:'anchor',text:''},{id:'neighbor',text:'保留'}]],member_ids:[]})});
    const agent={...newWorkflowNode('agent',0,0,''),id:'agent',agentTransport:'codex-cli',prompt:'画图',inputs:loop?{image:[{nodeId:'loop',portId:'image'}]}:{}};
    const writer={...newWorkflowNode('text',0,0,''),id:'writer',textTarget:{nodeId:table,cellId:'anchor',append:true,appendAxis:'column',axisCellIds:['anchor'],image:true},inputs:{image:[{nodeId:'agent',portId:'image'}]}};
    await c.edit(loop?[{...newWorkflowNode('loop',0,0,''),id:'loop',inputs:{image:[{assetId:'a'},{assetId:'b'}]}},agent,writer]:[agent,writer]);
  };
  const cells=()=>JSON.parse(window.snapshot().nodes.find(n=>n.id===table).payloadJson).cells.flat();
  const refs=()=>cells().filter(cell=>cell.generation_ref).map(cell=>cell.generation_ref.session_node_id);
  const wait=async condition=>{for(let i=0;i<100;i++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('expected early delivery never happened');};
  await setup();const running=c.start('agent',true);await wait(()=>refs().length===1);
  check(c.document.run.steps.agent.status==='running'&&c.document.run.steps.writer.status==='pending','session delivered before Agent finishes or downstream runs');
  check(cells().find(cell=>cell.id==='neighbor').text==='保留','neighbor preserved');ready=true;await running;
  check(c.document.run.status==='done'&&refs().length===1,'final reply does not append twice');
  ready=false;failResult=true;await setup();await c.start('agent',true);
  check(refs().length===1&&c.document.run.status==='failed','Agent failure cannot lose submitted session');failResult=false;
  for(const boundary of ['before','after']) {
    ready=true;await setup();failSave=boundary;await c.start('agent',true);
    check(c.document.run.status==='waiting','write interruption parks without resubmission');const counts=[submissions,deliveries];
    c=new CanvasWorkflowController(c.projectId);await c.load();await c.continue();
    check(c.document.run.status==='done'&&refs().length===1&&JSON.stringify(counts)===JSON.stringify([submissions,deliveries]),'reload reuses reserved cell after '+boundary+' write failure');
  }
  callCount=2;await setup();await c.start('agent',true);
  check(c.document.run.status==='done'&&new Set(refs()).size===2&&refs().length===2,'multiple tool calls each own one cell');
  callCount=1;await setup(true);await c.start('loop',true);
  check(c.document.run.status==='done'&&c.document.run.loop.completed.length===2&&new Set(refs()).size===2,'each loop iteration appends exactly once');
  // Explicit output assignments must not broadcast sessions into destinations before routing.
  ready=false;await setup();const nodes=c.document.nodes.map(n=>n.id==='agent'?{...n,prompt:'给 @[target] 输出',promptReferences:[{id:'target',type:'image',direction:'output',label:'目标',input:{nodeId:'writer',portId:'image'}}]}:n);
  await c.edit(nodes);const directed=c.start('agent',true);const count=submissions;await wait(()=>submissions>count);
  await new Promise(resolve=>setTimeout(resolve,100));check(refs().length===0,'directed output waits for assignment');await c.stop();await directed;
  return {submissions,deliveries,earlyDelivery:true,recovery:'exactly once',loops:2};
 }));
 console.log('PASS immediate Agent session delivery, interrupted final reply, save recovery, multiple calls, loop and directed-output boundary');
}finally{await browser.close();await server.close();}
