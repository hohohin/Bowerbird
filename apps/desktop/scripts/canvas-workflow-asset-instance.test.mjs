import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server=await createServer({configFile:false,root:process.cwd(),server:{host:'127.0.0.1',port:1596,strictPort:true,hmr:false,watch:null}});
await server.listen();const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1800,height:1100}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
  await page.goto('http://127.0.0.1:1596/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async()=>{
    const s=window.snapshot(),original={...s.nodes[0],x:100,y:100};
    s.nodes=[original,{...original,id:'duplicate',x:700,y:460}];s.view={...s.view,zoom:0.8,panX:20,panY:60};
    sessionStorage.setItem('reference-fixture',JSON.stringify(s));
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');const {newWorkflowNode}=await import('/src/lib/canvasWorkflow.ts');
    await canvasWorkflowController('p').edit(['first','second'].map((id,i)=>({...newWorkflowNode('instruction',1100,100+i*400,'codex'),id,action:'reuse'})));
  });
  await page.reload();await page.locator('[data-workflow-card="first"]').waitFor();
  for(const [source,target] of [['old','first'],['duplicate','second']]){
    await page.locator(`[data-canvas-node-id="${source}"]`).hover();
    await page.locator(`[data-workflow-material="${source}"]`).click();
    await page.locator(`[data-workflow-card="${target}"]`).getByRole('button',{name:'输入：图片',exact:true}).click();
  }
  const checkOrigins=async()=>{
    const offsets=await page.evaluate(()=>['old','duplicate'].map((id,i)=>{
      const port=document.querySelector(`[data-workflow-material="${id}"]`).getBoundingClientRect();
      const path=document.querySelector(`[data-workflow-target="${i?'second':'first'}"]`);
      const origin=path.getPointAtLength(0),point=new DOMPoint(origin.x,origin.y).matrixTransform(path.getScreenCTM());
      return Math.hypot(point.x-(port.x+port.width/2),point.y-(port.y+port.height/2));
    }));assert.ok(offsets.every(n=>n<2),`origins follow their exact instance: ${offsets}`);
  };
  await checkOrigins();
  assert.deepEqual(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.map(n=>n.inputs.image[0])),[
    {assetId:'existing',assetNodeId:'old'}, {assetId:'existing',assetNodeId:'duplicate'},
  ]);
  // Drag only the second placement; neither wire may jump to the other copy.
  const before=await page.locator('[data-canvas-node-id="duplicate"]').boundingBox();
  await page.mouse.move(before.x+before.width/2,before.y+before.height/2);await page.mouse.down();
  await page.mouse.move(before.x+before.width/2-120,before.y+before.height/2+80,{steps:10});await page.mouse.up();
  await checkOrigins();
  const moved=await page.locator('[data-canvas-node-id="duplicate"]').boundingBox();assert.ok(Math.abs(moved.x-before.x)>80);
  await page.waitForFunction(()=>window.calls.some(c=>c.command==='project_canvas_node_update'&&c.args.nodeId==='duplicate'));
  await page.evaluate(()=>window.save());await page.reload();await page.locator('[data-workflow-target="second"]').waitFor();await checkOrigins();
  // Removing the selected placement must not silently retarget the surviving identical asset.
  await page.evaluate(async()=>{const {api}=await import('/src/lib/api.ts');await api.projectCanvasNodeRemove('duplicate');window.emitChange();});
  await page.locator('[data-canvas-node-id="duplicate"]').waitFor({state:'detached'});
  assert.equal(await page.locator('[data-workflow-target="second"]').count(),0);
  assert.equal(await page.locator('[data-workflow-target="first"]').count(),1);
  const message=await page.evaluate(async()=>{
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    try{await canvasWorkflowController('p').start('second',true);return 'unexpected success';}catch(e){return String(e);}
  });assert.match(message,/图片实例已移除/);
  await page.evaluate(async()=>{const {api}=await import('/src/lib/api.ts');await api.projectCanvasNodeRestore('p','duplicate');window.emitChange();});
  await page.locator('[data-workflow-target="second"]').waitFor();await checkOrigins();
  await page.evaluate(async()=>{
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');const c=canvasWorkflowController('p');await c.start('second',true);
    if(c.document.run.status!=='done')throw Error('restored source does not execute');
    const {newWorkflowNode,workflowBindingKey,compileGenerationPrompt,workflowInputValues,generationInputNode}=await import('/src/lib/canvasWorkflow.ts');
    const first={assetId:'existing',assetNodeId:'old'},second={assetId:'existing',assetNodeId:'duplicate'};
    if(workflowBindingKey(first)===workflowBindingKey(second))throw Error('instance identities collapsed');
    const gen={...newWorkflowNode('generation',0,0,'codex'),prompt:'@[ref]',inputs:{image:[first,second]},promptReferences:[{id:'ref',type:'image',input:second,assetId:'existing',label:'第二个实例'}]};
    if(compileGenerationPrompt(gen,workflowInputValues([gen],generationInputNode(gen))).assetIds[0]!=='existing')throw Error('wrong generated asset');
    gen.inputs.image=[first];let rejected=false;try{compileGenerationPrompt(gen,workflowInputValues([gen],generationInputNode(gen)));}catch{rejected=true;}if(!rejected)throw Error('disconnected reference jumped to first copy');
    // Legacy asset-only bindings remain readable without inventing an instance history.
    await c.edit(c.document.nodes.map(n=>n.id==='first'?{...n,inputs:{image:[{assetId:'existing'}]}}:n));await c.start('first',true);
    if(c.document.run.status!=='done')throw Error('legacy input failed');
  });
  assert.deepEqual(errors,[]);
  console.log('asset instances: real duplicate wiring, drag, reload, remove/no fallback, preflight rejection, restore, prompt identity and legacy input passed');
} finally {await browser.close();await server.close();}
