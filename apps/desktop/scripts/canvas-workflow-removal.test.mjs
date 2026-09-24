import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server=await createServer({configFile:false,root:process.cwd(),server:{host:'127.0.0.1',port:1606,strictPort:true,hmr:false,watch:null}});
await server.listen();const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1700,height:1100}});
try {
  await page.goto('http://127.0.0.1:1606/scripts/fixtures/canvas-reference/preview.html');await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async()=>{
    const {api}=await import('/src/lib/api.ts');const {newWorkflowNode}=await import('/src/lib/canvasWorkflow.ts');const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const save=api.canvasWorkflowSave;
    api.canvasWorkflowSave=async(p,r,d)=>{if(d.nodes.some(n=>n.kind==='text'&&n.textTarget&&Object.values(n.inputs).flat().length!==1))throw Error('工作流数据无效');return save(p,r,d);};
    const base=window.snapshot().nodes[0];await api.projectCanvasNodeCreate({...base,id:'result',kind:'note',assetId:null,payloadJson:JSON.stringify({cells:[[{id:'cell',content_type:'image',text:'',image_refs:[{asset_id:'existing',token:'@图片1'}]}]]})});
    const producer={...newWorkflowNode('generation',420,60,'codex'),id:'producer'};
    const writer={...newWorkflowNode('text',0,0,''),id:'writer',textTarget:{nodeId:'result',cellId:'cell',image:true},inputs:{image:[{nodeId:'producer',portId:'image'}]}};
    const c=canvasWorkflowController('p');await c.load();await c.edit([producer,writer]);
    window.beforeRemoval=structuredClone(c.document.nodes);
  });
  await page.locator('.workflow-card.is-generation').getByRole('button',{name:'删除卡片',exact:true}).click();
  const state=await page.evaluate(async()=>{const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');const c=canvasWorkflowController('p');return {error:c.error,nodes:c.document.nodes,content:window.snapshot().nodes.find(n=>n.id==='result').payloadJson};});
  assert.equal(state.error,'','deletion with a downstream writer must save');assert.equal(state.nodes.length,0);assert.ok(state.content.includes('existing'),'generated content retained');
  await page.evaluate(async()=>{
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');const c=canvasWorkflowController('p');await c.edit(window.beforeRemoval);
    // Recreate the old UI's failed deletion, then a later user edit stuck behind that save.
    try{await c.edit([{...window.beforeRemoval[1],inputs:{image:[]}}]);}catch{}
    const {newWorkflowNode}=await import('/src/lib/canvasWorkflow.ts');
    try{await c.edit([...c.document.nodes,{...newWorkflowNode('planner',420,60,''),id:'later',prompt:'保留尚未保存的需求'}]);}catch{}
  });
  await page.getByRole('button',{name:'重试保存',exact:true}).click();
  await page.waitForFunction(async()=>{const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');return !canvasWorkflowController('p').error;});
  const repaired=await page.evaluate(async()=>{const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');const {api}=await import('/src/lib/api.ts');return {memory:canvasWorkflowController('p').document,saved:(await api.canvasWorkflowGet('p')).document};});
  assert.deepEqual(repaired.saved,repaired.memory);assert.equal(repaired.saved.nodes.length,1);assert.equal(repaired.saved.nodes[0].prompt,'保留尚未保存的需求');
  console.log('workflow removal: strict writer validation, content preserved, failed-queue repair and newer edits persisted');
}finally{await browser.close();await server.close();}
