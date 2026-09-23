import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium} from '../../html-renderer/node_modules/playwright/index.mjs';
const server=await createServer({configFile:false,root:process.cwd(),server:{host:'127.0.0.1',port:1617,strictPort:true,hmr:false,watch:null}});
await server.listen();const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1700,height:1100}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
  await page.goto('http://127.0.0.1:1617/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(()=>{const s=window.snapshot();s.nodes=s.nodes.filter(n=>n.id==='old');Object.assign(s.nodes[0],{x:20,y:650,width:100,height:100});s.groups=[];s.groupItems=[];s.edges=[];s.view={...s.view,panX:35,panY:40,zoom:.8};sessionStorage.setItem('reference-fixture',JSON.stringify(s));});
  await page.reload();await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async()=>{
    const {api}=await import('/src/lib/api.ts');const {newWorkflowNode}=await import('/src/lib/canvasWorkflow.ts');
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const base=window.snapshot().nodes[0];
    await api.projectCanvasNodeCreate({...base,id:'source-table',kind:'note',assetId:null,role:null,x:480,y:120,width:500,height:240,payloadJson:JSON.stringify({schema_version:1,note_type:'text',title:'引用来源',text:'',member_ids:[],cells:[[{id:'deleted-cell',text:'',content_type:'text'},{id:'current-cell',text:'新内容',content_type:'text'}]]})});
    const input={canvasNodeId:'source-table',cellId:'deleted-cell'};
    const c=canvasWorkflowController('p');await c.load();await c.edit([{...newWorkflowNode('generation',1080,120,'codex'),id:'consumer',prompt:'按 @[chosen] 生成',inputs:{text:[input]},promptReferences:[
      {id:'inactive',type:'text',label:'文本 1',input},{id:'chosen',type:'text',label:'文本 1',input},
    ]}]);window.save();
  });
  await page.reload();
  const card=page.locator('[data-canvas-node-id="source-table"]'),consumer=page.locator('[data-workflow-card="consumer"]');
  const editor=consumer.getByRole('textbox',{name:'卡片指令',exact:true});await editor.waitFor();

  const menu=page.getByRole('listbox',{name:'收到的内容'});
  await editor.press('End');await editor.pressSequentially('@');await menu.waitFor();
  assert.equal(await menu.getByRole('option').first().isEnabled(),true,'existing empty cell is a valid source');
  await editor.press('Escape');await editor.press('Backspace');
  await card.getByRole('textbox',{name:'第 1 行第 1 列',exact:true}).fill('旧内容');
  assert.equal(await card.getByRole('cell').first().getAttribute('data-canvas-cell'),'deleted-cell','editing retains identity');
  const add=card.getByRole('button',{name:'在第 1 列位置插入',exact:true});await add.locator('svg').hover();await add.locator('svg').click();
  assert.equal(await card.getByRole('cell').nth(1).getAttribute('data-canvas-cell'),'deleted-cell','inserting before it retains identity');
  const remove=card.getByRole('button',{name:'删除第 2 列',exact:true});await remove.hover();await remove.click();
  await editor.press('End');await editor.pressSequentially('@');await menu.waitFor();
  assert.equal(await menu.getByRole('option').first().isDisabled(),true,'deleted cell must not be offered as pending content');
  assert.match(await menu.innerText(),/已删除/);await editor.press('Escape');await editor.press('Backspace');
  await card.getByRole('textbox',{name:'第 1 行第 1 列',exact:true}).focus();
  await card.getByRole('button',{name:'撤销删除行列',exact:true}).click();
  assert.equal(await card.getByRole('cell').nth(1).getAttribute('data-canvas-cell'),'deleted-cell','undo restores original source identity');
  await remove.hover();await remove.click();
  // Explicitly connect the surviving cell: the obsolete connection and both
  // stored copies of its @ reference must be replaced together.
  await card.locator('[data-canvas-cell="current-cell"]').hover();
  await card.locator('[data-workflow-cell="current-cell"]').click();
  await consumer.getByRole('button',{name:'输入：文本',exact:true}).click();
  await page.waitForFunction(()=>{
    const n=JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(n=>n.id==='consumer');
    return n.inputs.text.length===1&&n.inputs.text[0].cellId==='current-cell'&&n.promptReferences.every(ref=>ref.input.cellId==='current-cell');
  });
  await page.evaluate(()=>window.save());await page.reload();await editor.waitFor();
  await page.evaluate(async()=>{
    const {api}=await import('/src/lib/api.ts');const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');const {useStore}=await import('/src/store.ts');
    let calls=0;api.localAgentFindAssetId=async()=> 'existing';
    useStore.setState({startGeneration:async(...args)=>{
      calls++;if(!args[0].includes('新内容'))throw Error('must use current source');
      const identity=args[12];useStore.setState(s=>({genJobs:{...s.genJobs,[identity.jobId]:{turns:[{turnKey:identity.turnKey,images:['existing.png']}]}}}));return {accepted:true};
    }});
    const c=canvasWorkflowController('p');await c.start('consumer',true);
    if(c.document.run.status!=='done'||calls!==1)throw Error('reconnected source must execute successfully');
    const {CanvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const original=c.document.nodes.find(n=>n.id==='consumer'),old={canvasNodeId:'source-table',cellId:'deleted-cell'};
    const ghost={...original,inputs:{text:[old,...original.inputs.text]},promptReferences:original.promptReferences.map(ref=>({...ref,input:old}))};
    const legacy=new CanvasWorkflowController('reference-legacy');await legacy.load();await legacy.save({...legacy.document,nodes:[ghost]});
    const restored=new CanvasWorkflowController('reference-legacy');await restored.load();await restored.start('consumer',true);
    if(restored.document.run.status!=='done'||calls!==2||restored.document.nodes[0].inputs.text.length!==1)throw Error('old and new saved wires must reconcile together on load');
    const {reconcileCanvasWorkflowReferences}=await import('/src/lib/canvasSessionOutputs.ts');
    const canvas=window.snapshot().nodes;
    const unresolved=reconcileCanvasWorkflowReferences([{...ghost,inputs:{text:[old]}}],canvas)[0];
    if(unresolved.promptReferences.some(ref=>ref.input.cellId!=='deleted-cell'))throw Error('must not invent a replacement from unconnected cells');
    const occupied={...ghost,prompt:ghost.prompt+' @[other]',promptReferences:[...ghost.promptReferences,{id:'other',type:'text',input:original.inputs.text[0],label:'另一个引用'}]};
    if(reconcileCanvasWorkflowReferences([occupied],canvas)[0].inputs.text.length!==2)throw Error('must not steal a source selected by another reference');
  });
  assert.deepEqual(errors,[]);
  console.log('reference lifecycle: empty vs deleted, edit/insert/undo identity, ghost option disabled, explicit reconnect updates inputs and all tokens, persistence/reload and generation passed');
}finally{await browser.close();await server.close();}
