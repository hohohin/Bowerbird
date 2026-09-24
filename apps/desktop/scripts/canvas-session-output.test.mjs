import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ configFile:false, root:process.cwd(), server:{host:'127.0.0.1',port:1594,strictPort:true,hmr:false,watch:null} });
await server.listen();
const browser = await chromium.launch({channel:'chrome',headless:true});
const page = await browser.newPage({viewport:{width:1600,height:1000}});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:1594/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(()=>{
    const s=window.snapshot(),base=s.nodes[0];
    const session={...base,id:'session',kind:'prompt',assetId:null,role:null,x:100,y:100,width:260,height:180,payloadJson:JSON.stringify({schema_version:1,job_id:'job',turn_key:'one',text:'第一轮',provider:'codex',status:'done'})};
    const outputs=['a','b'].map((id,i)=>({...base,id:`output-${id}`,assetId:id,role:'output',x:400+i*220,y:100,payloadJson:JSON.stringify({schema_version:1,snapshot:{name:id,width:190,height:150},execution:{job_id:'job',turn_key:'one'}})}));
    const later={...outputs[0],id:'output-c',assetId:'c',y:350,payloadJson:JSON.stringify({schema_version:1,snapshot:{name:'later',width:190,height:150},execution:{job_id:'job',turn_key:'two'}})};
    const note={schema_version:1,note_type:'images',text:'',cells:[[{id:'cell',text:'',bold:false,italic:false,align:'left'}]],member_ids:[]};
    const container={...base,id:'container',kind:'note',assetId:null,role:null,x:900,y:100,width:340,height:220,payloadJson:JSON.stringify(note)};
    s.nodes=[{...base,x:100,y:430},session,...outputs,later,container];
    s.edges=outputs.map((n,i)=>({id:`edge-${i}`,projectId:'p',threadId:'t',fromNodeId:'session',toNodeId:n.id,kind:'produced',ordinal:i,createdAt:1}));
    s.view={...s.view,panX:50,panY:60,zoom:0.8};sessionStorage.setItem('reference-fixture',JSON.stringify(s));
  });
  await page.reload();
  const session=page.locator('[data-canvas-node-id="session"]');await session.waitFor();
  assert.equal(await page.locator('[data-canvas-node-id="output-a"]').count(),1);
  await session.hover();
  const output=page.locator('[data-workflow-session-output="session"]');
  await output.click();
  await page.locator('[data-canvas-node-id="container"]').hover();
  await page.locator('[data-canvas-node-id="container"] [data-workflow-text-input=""][data-content-input-type="image"]').click();
  await page.waitForFunction(()=>{
    const note=JSON.parse(window.snapshot().nodes.find(n=>n.id==='container').payloadJson);
    return note.cells.flat().filter(cell=>cell.image_refs?.length===1).length===2;
  });
  await page.locator('[data-canvas-node-id="output-a"]').waitFor({state:'detached'});
  assert.equal(await page.locator('[data-canvas-node-id="output-b"]').count(),0);
  assert.equal(await page.locator('[data-canvas-node-id="output-c"]').count(),1);
  assert.equal(await page.locator('[data-canvas-node-id="old"]').count(),1);
  await page.evaluate(async()=>{
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const {newWorkflowNode}=await import('/src/lib/canvasWorkflow.ts');
    const {useStore}=await import('/src/store.ts');const {api}=await import('/src/lib/api.ts');
    const c=canvasWorkflowController('p');const input={canvasNodeId:'session',cellId:'image'};
    const node={...newWorkflowNode('generation',100,700,'codex'),id:'downstream',prompt:'参考 @[session]',inputs:{image:[input]},promptReferences:[{id:'session',input,type:'image',label:'会话图片'}]};
    await c.edit([...c.document.nodes,node]);
    api.localAgentFindAssetId=async()=> 'existing';
    useStore.setState({startGeneration:async(...args)=>{
      if(args[1].map(a=>a.id).join(',')!=='a,b')throw new Error('must use original turn only');
      const identity=args[12];useStore.setState(s=>({genJobs:{...s.genJobs,[identity.jobId]:{turns:[{turnKey:identity.turnKey,images:['existing.png']}]}}}));return {accepted:true};
    }});
    await c.start(node.id,true);if(c.document.run.status!=='done')throw new Error(c.document.run.error||'session downstream failed');
    if(window.snapshot().nodes.find(n=>n.id==='output-a').hiddenAt!==null)throw new Error('must retain native result record');
    window.save();
  });
  await page.reload();await session.waitFor();
  assert.equal(await page.locator('[data-canvas-node-id="output-a"]').count(),0);
  assert.equal(await page.locator('[data-workflow-session-output="session"]').count(),1);
  await session.hover();
  await mkdir('.tmp/workflow',{recursive:true});
  await page.screenshot({path:'.tmp/workflow/session-container-output.png'});
  // Clearing the container restores the independent results without recreating assets.
  await page.evaluate(async()=>{
    const {api}=await import('/src/lib/api.ts');const card=window.snapshot().nodes.find(n=>n.id==='container'),note=JSON.parse(card.payloadJson);
    for(const cell of note.cells.flat()){cell.image_refs=[];cell.text='';}
    await api.projectCanvasNoteUpdate(card.id,JSON.stringify(note));window.emitChange();
  });
  await page.locator('[data-canvas-node-id="output-a"]').waitFor();
  await page.locator('[data-canvas-node-id="output-b"]').waitFor();
  // A workflow-owned session moves into history; the generator socket carries reruns.
  await page.evaluate(async()=>{
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');const {newWorkflowNode}=await import('/src/lib/canvasWorkflow.ts');const c=canvasWorkflowController('p');
    await c.edit([...c.document.nodes,{...newWorkflowNode('generation',100,700,'codex'),id:'owner',activeSessionNodeId:'session',sessionNodeIds:['session'],outputs:{image:{type:'image',assetIds:['a','b']}}}]);
  });
  await session.waitFor({state:'detached'});
  await page.locator('[data-workflow-card="owner"]').getByRole('button',{name:'输出：图片',exact:true}).click();await page.locator('[data-canvas-node-id="container"]').hover();
  await page.locator('[data-canvas-node-id="container"] [data-workflow-text-input=""][data-content-input-type="image"]').click();
  await page.waitForFunction(async()=>{
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');return canvasWorkflowController('p').document.nodes.some(n=>n.textTarget?.nodeId==='container'&&n.inputs.image?.[0].nodeId==='owner');
  });
  // Rerun detaches the historical session even while its pictures remain in other container cells.
  await page.evaluate(async()=>{
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');const c=canvasWorkflowController('p');
    await c.edit(c.document.nodes.filter(n=>!n.textTarget||n.inputs.image?.[0].nodeId==='owner'));
    const s=window.snapshot(),previous=s.nodes.find(n=>n.id==='session');
    s.nodes.push({...previous,id:'session-two',y:350,payloadJson:JSON.stringify({schema_version:1,job_id:'job',turn_key:'two',text:'第二轮',provider:'codex',status:'done'})});
    s.edges.push({...s.edges[0],id:'edge-two',fromNodeId:'session-two',toNodeId:'output-c'});
    sessionStorage.setItem('reference-fixture',JSON.stringify(s));
  });
  await page.reload();await page.locator('[data-workflow-card="owner"]').waitFor();
  await page.locator('[data-canvas-node-id="output-a"]').waitFor({state:'detached'});
  assert.equal(await page.locator('.canvas-graph-edges .is-produced').count(),1);
  await page.evaluate(async()=>{
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');const c=canvasWorkflowController('p');
    await c.edit(c.document.nodes.map(n=>n.id==='owner'?{...n,activeSessionNodeId:null,outputs:{}}:n));
  });
  await page.locator('[data-canvas-node-id="output-a"]').waitFor();
  assert.equal(await page.locator('[data-canvas-node-id="output-b"]').count(),1);
  await page.locator('[data-workflow-generated-link="output-a"]').waitFor({state:'attached'});
  assert.equal(await page.locator('[data-workflow-generated-link="output-b"]').count(),1);
  assert.equal(await page.locator('.canvas-graph-edges .is-produced').count(),1);
  await page.evaluate(async()=>{
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');const {api}=await import('/src/lib/api.ts');const c=canvasWorkflowController('p');
    await c.edit(c.document.nodes.map(n=>n.id==='owner'?{...n,activeSessionNodeId:'session-two',sessionNodeIds:['session','session-two'],outputs:{image:{type:'image',assetIds:['c']}}}:n));
    const writer=c.document.nodes.find(n=>n.textTarget&&n.inputs.image?.[0].nodeId==='owner');
    await c.start(writer.id,true);
    // Retain a copy of old images in the disconnected row to prove suppression follows live wires.
    const table=window.snapshot().nodes.find(n=>n.id==='container'),note=JSON.parse(table.payloadJson);
    note.cells[0][0].image_refs=[{asset_id:'a',token:'@图片1'},{asset_id:'b',token:'@图片2'}];
    await api.projectCanvasNoteUpdate(table.id,JSON.stringify(note));window.emitChange();window.save();
  });
  await page.locator('[data-canvas-node-id="output-c"]').waitFor({state:'detached'});
  assert.equal(await page.locator('[data-workflow-generated-link="output-c"]').count(),0);
  assert.equal(await page.locator('[data-workflow-generated-link="output-a"]').count(),1);
  assert.equal(await page.locator('[data-workflow-generated-link="output-b"]').count(),1);
  assert.ok(await page.locator('path[data-workflow-text-link].is-image').count()>0);
  assert.equal(await page.locator('[data-canvas-node-id="output-a"]').count(),1);
  assert.equal(await page.locator('[data-canvas-node-id="output-b"]').count(),1);
  assert.equal(await page.locator('.canvas-graph-edges .is-produced').count(),0);
  assert.equal(await page.locator('[data-workflow-session-link="session"]').count(),0);
  assert.equal(await page.locator('[data-workflow-session-link="session-two"]').count(),0);
  await page.reload();await page.locator('[data-workflow-card="owner"]').waitFor();
  assert.equal(await page.locator('[data-canvas-node-id="output-a"]').count(),1);
  await page.waitForFunction(()=>document.querySelectorAll('.canvas-graph-edges .is-produced').length===0);
  await page.screenshot({path:'.tmp/workflow/session-history-restored.png'});
  // Explicit disconnect also returns the current session's image without clearing the container.
  await page.evaluate(async()=>{
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');const c=canvasWorkflowController('p');await c.edit(c.document.nodes.filter(n=>!n.textTarget));
  });
  await page.locator('[data-canvas-node-id="output-c"]').waitFor();
  await page.locator('[data-workflow-generated-link="output-c"]').waitFor({state:'attached'});
  assert.equal(await page.locator('.canvas-graph-edges .is-produced').count(),0);
  assert.deepEqual(errors,[]);
  console.log('session outputs: socket, container suppression, exact-turn downstream, clear/restore, rerun history images/edges, new-session isolation, disconnect and reload passed');
}finally{await browser.close();await server.close();}
