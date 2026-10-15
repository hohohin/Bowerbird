import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server=await createServer({configFile:false,root:process.cwd(),server:{host:'127.0.0.1',port:1617,strictPort:true,hmr:false,watch:null}});
await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1600,height:1100}});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const source=page.locator('[data-canvas-node-id="session"]');
const cell=page.locator('[data-canvas-cell="one"]');
const saved=()=>page.evaluate(()=>JSON.parse(window.snapshot().nodes.find(n=>n.id==='table').payloadJson));
async function drag(ready=true){
  const a=await source.boundingBox(),b=await cell.boundingBox();
  await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();
  await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:6});
  await page.getByRole('tooltip',{name:ready?'松开放入单元格':'悬停以放入单元格',exact:true}).waitFor();
  await page.mouse.up();
}
async function status(status,output=false){
  await page.evaluate(async({status,output})=>{
    const {api}=await import('/src/lib/api.ts');
    const n=window.snapshot().nodes.find(n=>n.id==='session');
    await api.projectCanvasNodeUpdate(n.id,{payloadJson:JSON.stringify({...JSON.parse(n.payloadJson),status})});
    if(output)await api.projectCanvasNodeCreate({...n,id:'result',kind:'asset',assetId:'b',role:'output',width:190,height:150,payloadJson:JSON.stringify({schema_version:1,snapshot:{name:'生成图片',width:190,height:150},execution:{job_id:'job',turn_key:'one'}})});
    window.emitChange();
  },{status,output});
}
try{
  await page.goto('http://127.0.0.1:1617/scripts/fixtures/canvas-reference/preview.html');await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(()=>{
    const s=window.snapshot(),base=s.nodes[0];
    s.nodes=[{...base,id:'session',kind:'prompt',assetId:null,role:null,x:70,y:120,width:260,height:148,payloadJson:JSON.stringify({schema_version:1,job_id:'job',turn_key:'one',text:'生成一张海报',provider:'codex',status:'running'})},
      {...base,id:'table',kind:'note',assetId:null,x:490,y:110,width:560,height:300,payloadJson:JSON.stringify({schema_version:1,note_type:'text',text:'待替换\t保留',cells:[[{id:'one',text:'待替换',content_type:'text',bold:false,italic:false,align:'left'},{id:'two',text:'保留',content_type:'text',bold:false,italic:false,align:'left'}]],member_ids:[]})}];
    s.groups=[];s.groupItems=[];s.edges=[];s.view={...s.view,panX:35,panY:40,zoom:.8};
    sessionStorage.setItem('reference-fixture',JSON.stringify(s));sessionStorage.removeItem('workflow-p');
  });
  await page.reload();await source.waitFor();await cell.waitFor();
  await drag(false);assert.equal((await saved()).cells[0][0].text,'待替换');
  // Save failure retains the original card and destination content.
  await page.evaluate(()=>{window.failNoteSave=true;});await drag();
  await page.waitForTimeout(150);assert.equal(await source.count(),1);assert.equal((await saved()).cells[0][0].text,'待替换');
  await page.evaluate(()=>{window.failNoteSave=false;});await drag();
  await cell.locator('[data-cell-generation="session"]').waitFor();await source.waitFor({state:'detached'});
  assert.equal((await saved()).cells[0][0].generation_ref.session_node_id,'session');
  assert.equal((await saved()).cells[0][1].text,'保留');
  assert.equal(await page.locator('[data-workflow-session-output="session"]').count(),0);
  await cell.getByRole('button',{name:'查看单元格生成会话'}).click();await page.locator('[data-project-inspector]').waitFor();
  await page.getByTitle('关闭详情（进行中的任务不会中断）').click();
  await page.evaluate(()=>window.save());await page.reload();await cell.locator('[data-cell-generation]').waitFor();
  assert.equal(await source.count(),0,'pending placement survives reload');
  await mkdir('.tmp/canvas-generation-cell',{recursive:true});
  await page.screenshot({path:'.tmp/canvas-generation-cell/pending.png'});
  await status('failed');await cell.getByText('codex · 生成失败').waitFor();
  await status('running');await cell.getByText('codex · 生成中').waitFor();
  await status('done',true);
  await cell.locator('.canvas-image-content img').waitFor();
  await page.waitForFunction(()=>JSON.parse(window.snapshot().nodes.find(n=>n.id==='table').payloadJson).cells[0][0].image_refs?.[0]?.asset_id==='b');
  assert.equal(await cell.locator('[data-cell-generation]').count(),0);
  await page.screenshot({path:'.tmp/canvas-generation-cell/completed.png'});
  assert.equal(await source.count(),0);assert.equal(await page.locator('[data-canvas-node-id="result"]').count(),0);
  assert.equal((await saved()).cells[0][1].text,'保留');
  const picture=cell.getByRole('button',{name:/查看生成会话/});
  await picture.click();await page.locator('[data-project-inspector]').waitFor();
  assert.equal(await page.getByRole('dialog',{name:'媒体预览，1 / 1'}).count(),0,'single click opens only the original session');
  await page.getByTitle('关闭详情（进行中的任务不会中断）').click();
  await picture.dblclick();await page.getByRole('dialog',{name:'媒体预览，1 / 1'}).waitFor();
  await page.waitForTimeout(450);assert.equal(await page.locator('[data-project-inspector]').count(),0,'double click cancels delayed session opening');
  await page.keyboard.press('Escape');
  assert.deepEqual(await page.evaluate(async()=>{const {canvasInputValue}=await import('/src/lib/canvasSessionOutputs.ts');const s=window.snapshot();return canvasInputValue(s.nodes.find(n=>n.id==='table'),'one',s.nodes).assetIds;}),['b']);
  await page.evaluate(()=>window.save());await page.reload();await cell.locator('.canvas-image-content img').waitFor();assert.equal(await source.count(),0);
  await cell.getByRole('button',{name:/查看生成会话/}).focus();await page.keyboard.press('Enter');await page.locator('[data-project-inspector]').waitFor();
  await page.getByTitle('关闭详情（进行中的任务不会中断）').click();
  await cell.hover();await cell.getByRole('button',{name:'清空第 1 行第 1 列图片'}).click();
  await source.waitFor();assert.equal((await saved()).cells[0][0].generation_ref,undefined);
  // A finished card can also be placed directly, without a workflow dependency.
  await drag();await cell.locator('.canvas-image-content img').waitFor();await source.waitFor({state:'detached'});
  assert.equal((await saved()).cells[0][0].image_refs[0].asset_id,'b');
  await page.evaluate(async()=>{const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');await canvasWorkflowController('p').storeCellImages('table','one',['a']);});
  await source.waitFor();await page.waitForFunction(()=>JSON.parse(window.snapshot().nodes.find(n=>n.id==='table').payloadJson).cells[0][0].image_refs?.[0]?.asset_id==='a');
  assert.equal((await saved()).cells[0][0].generation_ref,undefined,'replacement cannot be overwritten by the old generation');
  await page.evaluate(async()=>{const {api}=await import('/src/lib/api.ts');await api.projectCanvasNodeUpdate('session',{x:70,y:120});window.emitChange();});
  const ordinary=cell.getByRole('button',{name:/放大图片/});
  await ordinary.click();await page.waitForTimeout(450);
  assert.equal(await page.getByRole('dialog',{name:'媒体预览，1 / 1'}).count(),0,'ordinary image single click does not magnify');
  assert.equal(await page.locator('[data-project-inspector]').count(),0,'replacement no longer opens the old session');
  await ordinary.dblclick();await page.getByRole('dialog',{name:'媒体预览，1 / 1'}).waitFor();await page.keyboard.press('Escape');
  // Selecting an older result before dropping freezes that exact turn and image.
  await page.evaluate(async()=>{
    const {api}=await import('/src/lib/api.ts');const s=window.snapshot(),n=s.nodes.find(n=>n.id==='session'),output=s.nodes.find(n=>n.id==='result');
    await api.projectCanvasNodeCreate({...n,id:'later',payloadJson:JSON.stringify({...JSON.parse(n.payloadJson),turn_key:'two',status:'done'})});
    await api.projectCanvasNodeCreate({...output,id:'result-c',assetId:'c',payloadJson:JSON.stringify({schema_version:1,snapshot:{name:'later',width:190,height:150},execution:{job_id:'job',turn_key:'two'}})});
    window.emitChange();
  });
  await source.locator('[data-conversation-image="c"]').waitFor();
  await source.hover();await source.getByRole('button',{name:'上一张生成图片'}).click();
  await source.locator('[data-conversation-image="b"]').waitFor();await drag();await source.waitFor({state:'detached'});
  assert.equal((await saved()).cells[0][0].generation_ref.session_node_id,'session');
  assert.equal((await saved()).cells[0][0].image_refs[0].asset_id,'b');
  await page.evaluate(async()=>{
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const {newWorkflowNode}=await import('/src/lib/canvasWorkflow.ts');const controller=canvasWorkflowController('p');
    await controller.edit([...controller.document.nodes,{...newWorkflowNode('generation',1150,100,'codex'),id:'consumer',inputs:{image:[{canvasNodeId:'session',cellId:'image'}]}}]);
  });
  await page.locator('[data-workflow-target="consumer"]').waitFor({state:'attached'});
  await page.waitForFunction(()=>{
    const wire=document.querySelector('[data-workflow-target="consumer"]'),cell=document.querySelector('[data-canvas-cell="one"]');
    const point=wire.getPointAtLength(0),screen=new DOMPoint(point.x,point.y).matrixTransform(wire.getScreenCTM()),rect=cell.getBoundingClientRect();
    return Math.abs(screen.x-rect.right)<2&&Math.abs(screen.y-(rect.top+rect.height/2))<2;
  });
  assert.equal(await page.evaluate(()=>window.calls.some(call=>/^(generate_|start_generation)/.test(call.command))),false);
  assert.deepEqual(errors,[]);
  console.log('generation cell: drag threshold, failed-save retention, pending/failed/completed UI, original-session inspector, live completion, exact output, preview, reload, clear/replacement and no resubmission passed');
}finally{await browser.close();await server.close();}
