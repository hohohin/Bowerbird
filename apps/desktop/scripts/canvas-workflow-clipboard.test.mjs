import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server=await createServer({configFile:false,root:process.cwd(),server:{host:'127.0.0.1',port:1597,strictPort:true,hmr:false,watch:null}});await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1800,height:1200},permissions:['clipboard-read','clipboard-write']});const page=await context.newPage();
const errors=[];page.on('pageerror',error=>errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:1597/scripts/fixtures/canvas-reference/preview.html');await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async()=>{
    const s=window.snapshot(),base={...s.nodes[0],x:100,y:100};
    s.nodes=[base,{...base,id:'content',kind:'note',assetId:null,role:null,x:100,y:350,width:250,height:190,payloadJson:JSON.stringify({schema_version:1,note_type:'text',text:'蓝色背景',member_ids:[],cells:[[{id:'words',text:'蓝色背景',bold:false,italic:false,align:'left'},{id:'result',text:'',bold:false,italic:false,align:'left',content_type:'image'}]]})}];
    s.view={...s.view,zoom:0.7,panX:50,panY:50};sessionStorage.setItem('reference-fixture',JSON.stringify(s));
    const {newWorkflowNode,emptyWorkflow}=await import('/src/lib/canvasWorkflow.ts');const w=emptyWorkflow();
    const image={assetId:'existing',assetNodeId:'old'},text={canvasNodeId:'content',cellId:'words'},result={nodeId:'one',portId:'image'};
    w.nodes=[{...newWorkflowNode('trigger',400,560,'codex'),id:'switch'},
      {...newWorkflowNode('generation',400,100,'codex'),id:'one',prompt:'使用 @[text] 和 @[image]',ratio:'1:1',trigger:true,inputs:{text:[text],image:[image],signal:[{nodeId:'switch',portId:'signal'}]},promptReferences:[{id:'text',type:'text',input:text,label:'要求'},{id:'image',type:'image',input:image,assetId:'existing',label:'图片'}],outputs:{image:{type:'image',assetIds:['a']}},sessionNodeIds:['history'],activeSessionNodeId:'history',profileCache:{inputKey:'old',profileId:'cached'}},
      {...newWorkflowNode('generation',850,100,'codex'),id:'two',prompt:'修改 @[result]',inputs:{image:[result]},promptReferences:[{id:'result',type:'image',input:result,label:'上游图片'}]},
      {...newWorkflowNode('text',100,350,''),id:'writer',textTarget:{nodeId:'content',cellId:'result',image:true},inputs:{image:[{nodeId:'two',portId:'image'}]}}];
    sessionStorage.setItem('workflow-p',JSON.stringify({revision:0,document:w}));
  });await page.reload();await page.locator('[data-workflow-card="switch"]').waitFor();
  const image=await page.locator('[data-canvas-node-id="old"]').boundingBox(),last=await page.locator('[data-workflow-card="switch"]').boundingBox(),right=await page.locator('[data-workflow-card="two"]').boundingBox();
  await page.mouse.move(image.x-15,image.y-15);await page.mouse.down();await page.mouse.move(right.x+right.width+15,last.y+last.height+15,{steps:10});await page.mouse.up();
  assert.equal(await page.locator('.workflow-card.is-selected').count(),3);
  await page.keyboard.press('Control+c');
  await page.waitForFunction(async()=> (await navigator.clipboard.readText()).startsWith('BOWERBIRD_CANVAS_V1'));
  const clipboard=await page.evaluate(()=>navigator.clipboard.readText());
  await page.keyboard.press('Control+v');
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.length===8);
  await page.waitForFunction(()=>window.snapshot().nodes.filter(n=>n.hiddenAt==null).length===4);
  const cloneIds=await page.evaluate(async()=>{
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');const c=canvasWorkflowController('p'),old=new Set(['switch','one','two','writer']);
    const copies=c.document.nodes.filter(n=>!old.has(n.id));const one=copies.find(n=>n.prompt.startsWith('使用')),two=copies.find(n=>n.prompt.startsWith('修改')),key=copies.find(n=>n.kind==='trigger'),writer=copies.find(n=>n.kind==='text');
    const check=(v,m)=>{if(!v)throw Error(m)};
    check(one.inputs.image[0].assetNodeId!=='old'&&one.inputs.text[0].canvasNodeId!=='content','native ids remapped');
    check(one.promptReferences[0].input.canvasNodeId===one.inputs.text[0].canvasNodeId,'inline ref remapped');
    check(two.inputs.image[0].nodeId===one.id&&two.promptReferences[0].input.nodeId===one.id,'internal generation wire remapped');
    check(one.inputs.signal[0].nodeId===key.id&&one.trigger,'trigger retained');
    check(writer.textTarget.nodeId===one.inputs.text[0].canvasNodeId&&writer.inputs.image[0].nodeId===two.id,'writer remapped, original protected');
    check(copies.every(n=>!Object.keys(n.outputs).length&&!n.sessionNodeIds.length&&!n.activeSessionNodeId&&!n.profileCache),'runtime state cleared');
    check(two.x-one.x===450&&two.y===one.y,'relative placement');
    const {api}=await import('/src/lib/api.ts');const {useStore}=await import('/src/store.ts');api.localAgentFindAssetId=async()=> 'existing';let submitted=0;
    useStore.setState({startGeneration:async(...args)=>{submitted++;const identity=args[12];useStore.setState(s=>({genJobs:{...s.genJobs,[identity.jobId]:{turns:[{turnKey:identity.turnKey,images:['existing.png']}]}}}));return {accepted:true};}});
    await c.start(key.id);check(c.document.run.status==='done'&&submitted===2,'copied workflow executes');
    const original=JSON.parse(window.snapshot().nodes.find(n=>n.id==='content').payloadJson);check(!original.cells[0][1].image_refs?.length,'original container untouched');
    return copies.map(n=>n.id);
  });
  // A single undo removes exactly the pasted cards.
  await page.locator('.canvas-stage').focus();await page.keyboard.press('Control+z');
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.length===4);
  await page.waitForFunction(()=>window.snapshot().nodes.filter(n=>n.hiddenAt==null).length===2);
  assert.equal(await page.locator('.workflow-card').count(),3);
  // Repeated paste creates independent identities from the frozen clipboard.
  await page.keyboard.press('Control+v');await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.length===8);
  await page.waitForFunction(()=>window.snapshot().nodes.filter(n=>n.hiddenAt==null).length===4);
  assert.ok(await page.evaluate(ids=>JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.every(n=>!ids.includes(n.id)),cloneIds));
  // Text editing keeps the platform clipboard behavior rather than pasting cards.
  await page.locator('[data-workflow-card="one"] [role="textbox"]').focus();
  await page.evaluate(()=>navigator.clipboard.writeText('普通文字'));
  await page.keyboard.press('Control+v');assert.equal(await page.locator('.workflow-card').count(),6);
  // Group/section and cross-project remapping use the same clone plan.
  await page.evaluate(async()=>{
    const {captureCanvasClipboard,cloneCanvasClipboard}=await import('/src/lib/canvasClipboard.ts');const {newWorkflowNode}=await import('/src/lib/canvasWorkflow.ts');
    const native=window.snapshot().nodes.find(n=>n.id==='old'),group={id:'group',projectId:'p',name:'组',role:null,x:10,y:10,width:300,height:200,zIndex:1,createdAt:1,updatedAt:1};
    const node={...newWorkflowNode('generation',400,10,'codex'),id:'g',prompt:'test',inputs:{image:[{groupId:'group',assetIds:['existing']},{assetId:'existing',assetNodeId:'external'}],text:[{nodeId:'external',portId:'text'}]}};
    const value=captureCanvasClipboard('p',new Set(['g','group']),[native],[group],[{projectId:'p',groupId:'group',nodeId:'old',ordinal:0}],[node]);
    const copy=cloneCanvasClipboard(value,'another',100,100);
    if(copy.workflow[0].inputs.image[0].groupId!==copy.groups[0].id||copy.items[0].nodeId!==copy.nodes[0].id||copy.workflow[0].inputs.text.length||copy.workflow[0].inputs.image[1].assetNodeId)throw Error('group/cross-project remap');
    window.save();
  });await page.reload();await page.locator('[data-workflow-card="one"]').waitFor();assert.equal(await page.locator('.workflow-card').count(),6);
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.waitForFunction(()=>document.querySelector('.canvas-save-state')?.getAttribute('aria-hidden')==='true');
  // A failed workflow write after native cards were created retries those same identities.
  await page.evaluate(text=>{window.failWorkflowSave=true;return navigator.clipboard.writeText(text);},clipboard);
  await page.locator('.canvas-stage').focus();await page.keyboard.press('Control+v');
  await page.getByRole('button',{name:'重试保存画板',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.snapshot().nodes.filter(n=>n.hiddenAt==null).length),6);
  await page.evaluate(()=>{window.failWorkflowSave=false;});
  await page.getByRole('button',{name:'重试保存画板',exact:true}).click();
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.length===12);
  await page.waitForFunction(()=>!document.querySelector('.canvas-save-error'));
  assert.equal(await page.evaluate(()=>window.snapshot().nodes.filter(n=>n.hiddenAt==null).length),6);
  // Undo also survives a failed workflow save without losing the pending removal.
  await page.evaluate(()=>{window.failWorkflowSave=true;});
  await page.locator('.canvas-stage').focus();await page.keyboard.press('Control+z');
  await page.getByRole('button',{name:'重试保存画板',exact:true}).waitFor();
  await page.evaluate(()=>{window.failWorkflowSave=false;});
  await page.getByRole('button',{name:'重试保存画板',exact:true}).click();
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.length===8&&window.snapshot().nodes.filter(n=>n.hiddenAt==null).length===4);
  // Menu copy uses the platform clipboard API (including Windows CRLF conversion).
  await page.getByRole('button',{name:'适应内容',exact:true}).click();
  await page.locator('[data-workflow-card="two"] header strong').click({button:'right'});
  await page.getByRole('menuitem',{name:'复制所选卡片',exact:true}).click();
  await page.waitForFunction(async()=>JSON.parse((await navigator.clipboard.readText()).split('\n').slice(1).join('\n')).workflow.length===1);
  await page.locator('[data-workflow-card="two"] header strong').click({button:'right'});
  await page.getByRole('menuitem',{name:'粘贴卡片',exact:true}).click();
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.length===9);
  assert.equal(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.at(-1).inputs.image[0].nodeId),'one','same-project external source retained');
  assert.deepEqual(errors,[]);console.log('clipboard: mixed marquee, Ctrl+C/V, native/writer/reference/trigger remap, isolated execution, runtime reset, undo, repeated paste, text editing, groups/cross-project plan, reload, partial-save/undo retry and context menus passed');
}finally{await browser.close();await server.close();}
