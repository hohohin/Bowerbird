import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server=await createServer({configFile:false,root:process.cwd(),server:{host:'127.0.0.1',port:1615,strictPort:true,hmr:false,watch:null}});
await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1600,height:1100}});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const node=id=>page.locator(`[data-canvas-node-id="${id}"]`);
const cell=id=>page.locator(`[data-canvas-cell="${id}"]`);
const center=async locator=>{const r=await locator.boundingBox();return{x:r.x+r.width/2,y:r.y+r.height/2};};
const move=async point=>page.mouse.move(point.x,point.y);
const note=()=>page.evaluate(()=>JSON.parse(window.snapshot().nodes.find(n=>n.id==='table').payloadJson));
async function reset(zoom=.8){
  await page.evaluate(zoom=>{
    const s=window.snapshot(),base=s.nodes[0];
    s.nodes=[{...base,id:'source',kind:'asset',assetId:'a',x:70,y:130,width:190,height:180,hiddenAt:null,payloadJson:JSON.stringify({schema_version:1,snapshot:{name:'source',width:190,height:150}})},
      {...base,id:'other',kind:'asset',assetId:'a',x:70,y:420,width:190,height:180,hiddenAt:null,payloadJson:JSON.stringify({schema_version:1,snapshot:{name:'other',width:190,height:150}})},
      {...base,id:'table',kind:'note',assetId:null,x:480,y:120,width:550,height:290,hiddenAt:null,payloadJson:JSON.stringify({schema_version:1,note_type:'text',text:'待替换\t保留',cells:[[{id:'one',text:'待替换',content_type:'text',bold:false,italic:false,align:'left'},{id:'two',text:'保留',content_type:'text',bold:false,italic:false,align:'left'}]],member_ids:[]})}];
    s.groups=[];s.groupItems=[];s.edges=[];s.view={...s.view,panX:35,panY:40,zoom};
    sessionStorage.setItem('reference-fixture',JSON.stringify(s));sessionStorage.removeItem('workflow-p');
  },zoom);
  await page.reload();await cell('one').waitFor();
}
async function drag(target='one'){
  await move(await center(node('source')));await page.mouse.down();
  await move(await center(cell(target)));
  await page.getByRole('tooltip',{name:'悬停以放入单元格',exact:true}).waitFor();
}
async function ready(){
  await page.getByRole('tooltip',{name:'松开放入单元格',exact:true}).waitFor();
  assert.equal((await note()).cells[0][0].text,'待替换','hover does not write before release');
}
async function noWrite(){
  assert.equal((await note()).cells[0][0].text,'待替换');
  assert.equal((await note()).cells[0][1].text,'保留');
  assert.equal(await page.locator('.canvas-cell-drop-target').count(),0);
}
async function external(type,point){
  await page.evaluate(async({type,point})=>{
    const {setDragAssets}=await import('/src/lib/dragPayload.ts');setDragAssets(['b']);
    document.querySelector('.canvas-stage').dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,clientX:point.x,clientY:point.y,dataTransfer:new DataTransfer()}));
  },{type,point});
}
try{
  await page.goto('http://127.0.0.1:1615/scripts/fixtures/canvas-reference/preview.html');await node('old').waitFor();
  await reset();await drag();await page.mouse.up();await noWrite();

  await reset();await drag();await ready();
  await mkdir('.tmp/workflow',{recursive:true});await page.screenshot({path:'.tmp/workflow/cell-drop-ready.png'});
  await page.mouse.up();await cell('one').locator('.canvas-image-content img').waitFor();
  await node('source').waitFor({state:'detached'});
  assert.equal(await node('other').count(),1,'only the dragged instance is moved');
  assert.equal((await note()).cells[0][0].image_refs[0].asset_id,'a');
  assert.equal(await page.evaluate(()=>window.snapshot().nodes.filter(n=>n.kind==='asset'&&n.hiddenAt==null).length),1);
  assert.equal((await note()).cells[0][1].text,'保留');
  assert.equal(await page.evaluate(async()=>{const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');return canvasWorkflowController('p').document.nodes.filter(n=>n.textTarget?.cellId==='one').length;}),0,'hover placement stores a value without a source dependency');
  assert.equal(await page.locator('[data-workflow-text-link="one"]').count(),0);
  await page.evaluate(()=>window.save());await page.reload();await cell('one').locator('img').waitFor();
  assert.equal(await page.locator('[data-workflow-text-link="one"]').count(),0,'no hidden connection after reload');
  assert.equal(await node('source').count(),0,'moved instance stays off the canvas after reload');

  // Dropping a library image replaces only this cell and its association, without adding an instance.
  const point=await center(cell('one'));await external('dragover',point);
  await page.getByRole('tooltip',{name:'松开放入单元格',exact:true}).waitFor();await external('drop',point);
  await page.waitForFunction(()=>JSON.parse(window.snapshot().nodes.find(n=>n.id==='table').payloadJson).cells[0][0].image_refs?.[0]?.asset_id==='b');
  assert.equal((await note()).cells[0][1].text,'保留');
  assert.equal(await page.evaluate(()=>window.snapshot().nodes.length),3);
  assert.equal(await node('other').count(),1,'library drop does not remove another instance');
  assert.equal(await page.evaluate(async()=>{const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');return canvasWorkflowController('p').document.nodes.filter(n=>n.textTarget?.cellId==='one').length;}),0);
  // An explicit input writes the same stored value. A missing source cannot invalidate that value.
  await node('other').hover();await page.locator('[data-workflow-material="other"]').click();
  await cell('one').hover();
  await cell('one').getByRole('button',{name:'输入第 1 行第 1 列图片',exact:true}).click();
  await page.locator('[data-workflow-text-link="one"]').waitFor();
  await page.waitForFunction(()=>JSON.parse(window.snapshot().nodes.find(n=>n.id==='table').payloadJson).cells[0][0].image_refs?.[0]?.asset_id==='a');
  assert.equal(await node('other').count(),1,'explicit wiring retains the source card');
  await page.evaluate(async()=>{
    const {api}=await import('/src/lib/api.ts');const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');const {newWorkflowNode}=await import('/src/lib/canvasWorkflow.ts');const {useStore}=await import('/src/store.ts');
    const {canvasContentInput}=await import('/src/lib/canvasContentInput.ts');const c=canvasWorkflowController('p');
    const input={canvasNodeId:'table',cellId:'one'};
    await c.edit([...c.document.nodes,{...newWorkflowNode('generation',1100,150,'codex'),id:'reader',prompt:'使用 @[stored]',inputs:{image:[input]},promptReferences:[{id:'stored',type:'image',input,label:'存图'}]}]);
    let expected='a';useStore.setState({startGeneration:async(...args)=>{
      if(args[1].map(a=>a.id).join(',')!==expected)throw Error('reader must use stored image '+expected);
      const identity=args[12];useStore.setState(s=>({genJobs:{...s.genJobs,[identity.jobId]:{turns:[{turnKey:identity.turnKey,images:['b.png']}]}}}));return{accepted:true};
    }});api.localAgentFindAssetId=async()=> 'b';
    await api.projectCanvasNodeRemove('other');window.emitChange();
    await c.start('reader');if(c.document.run.status!=='done'||c.document.run.order.join(',')!=='reader')throw Error('reading cell replayed its disconnected source');
    await c.storeCellImages('table','one',['b']);expected='b';await c.start('reader');
    if(c.document.run.status!=='done')throw Error('new image did not replace output');
    const saved=JSON.parse(window.snapshot().nodes.find(n=>n.id==='table').payloadJson);
    const unchanged=canvasContentInput(saved,{nodeId:'table',cellId:'one',image:true},{type:'image',assetIds:[]});
    if(JSON.stringify(unchanged.note)!==JSON.stringify(saved))throw Error('empty input erased stored image');
  });
  await cell('one').hover();
  await cell('one').getByRole('button',{name:'输入第 1 行第 1 列图片',exact:true}).click({button:'right'});
  await page.locator('[data-workflow-text-link="one"]').waitFor({state:'detached'});
  assert.equal((await note()).cells[0][0].image_refs[0].asset_id,'b');

  await reset();const original=await node('source').boundingBox();
  await page.evaluate(()=>{window.failNoteSave=true;window.notices=[];window.addEventListener('bowerbird://notify',event=>window.notices.push(event.detail.message));});
  await drag();await ready();await page.mouse.up();
  await page.waitForFunction(()=>window.notices.some(message=>message.includes('模拟文本保存失败')));
  await noWrite();
  assert.deepEqual(await node('source').boundingBox(),original,'failed destination save preserves source geometry');
  assert.equal(await page.evaluate(()=>window.snapshot().nodes.find(n=>n.id==='source').hiddenAt),null,'failed save never removes the source');

  for(const cancel of ['Escape','pointercancel','lostpointercapture']){
    await reset();await drag();await ready();
    if(cancel==='Escape')await page.keyboard.press('Escape');else await node('source').dispatchEvent(cancel,{pointerId:1,bubbles:true});
    await page.mouse.up();await noWrite();
  }
  for(const change of ['outside','reentry','other-cell']){
    await reset();await drag();await ready();
    await move({x:1450,y:750});
    if(change==='reentry')await move(await center(cell('one')));
    if(change==='other-cell')await move(await center(cell('two')));
    await page.mouse.up();await noWrite();
  }
  await reset();await drag();await ready();
  await node('source').dispatchEvent('pointerup',{pointerId:1,clientX:1450,clientY:750,bubbles:true});
  await page.mouse.up();await noWrite();

  await reset(.4);await drag('two');await ready();await page.mouse.up();
  await cell('two').locator('.canvas-image-content img').waitFor();
  assert.equal((await note()).cells[0][0].text,'待替换');
  assert.equal((await note()).cells[0][1].image_refs[0].asset_id,'a');

  await reset();await external('dragover',await center(cell('one')));await ready();
  await page.evaluate(()=>window.dispatchEvent(new DragEvent('dragend')));await noWrite();
  assert.deepEqual(errors,[]);
  console.log('cell drop: move only dragged instance after saving, failed-write source retention, reload, library placement, explicit wiring keeps source, independent replacement/output, empty input, cancellation, reentry/change/release recheck and zoom passed');
}finally{await browser.close();await server.close();}
