import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium} from '../../html-renderer/node_modules/playwright/index.mjs';
const server=await createServer({configFile:false,root:process.cwd(),server:{host:'127.0.0.1',port:1637,strictPort:true,hmr:false,watch:null}});
await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1700,height:1100}});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:1637/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async()=>{
    const {api}=await import('/src/lib/api.ts');
    const {newWorkflowNode}=await import('/src/lib/canvasWorkflow.ts');
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const base=window.snapshot().nodes[0];
    await api.projectCanvasNodeCreate({...base,id:'pipes-table',kind:'note',assetId:null,role:null,x:80,y:200,width:550,height:220,payloadJson:JSON.stringify({schema_version:1,note_type:'text',title:'管道来源',text:'',member_ids:[],cells:[[{id:'a',text:'甲',content_type:'text'},{id:'b',text:'乙',content_type:'text'},{id:'c',text:'新甲',content_type:'text'}]]})});
    const c=canvasWorkflowController('p');await c.load();
    // A pre-upgrade save with two stale references, including the reported Agent source shape.
    await c.save({...c.document,nodes:[{...newWorkflowNode('generation',850,120,'codex'),id:'consumer',prompt:'@[one] / @[two]',inputs:{text:[{canvasNodeId:'pipes-table',cellId:'a'},{canvasNodeId:'pipes-table',cellId:'b'}]},promptReferences:[
      {id:'one',type:'text',label:'文本 1',input:{nodeId:'old-agent',portId:'text'}},
      {id:'two',type:'text',label:'文本 2',input:{canvasNodeId:'old-table',cellId:'old-cell'}},
    ]}]});window.save();
    const snapshot=window.snapshot();snapshot.nodes=snapshot.nodes.filter(n=>n.id==='old'||n.id==='pipes-table');
    Object.assign(snapshot.nodes.find(n=>n.id==='old'),{x:20,y:750,width:100,height:100});snapshot.groups=[];snapshot.groupItems=[];snapshot.edges=[];
    sessionStorage.setItem('reference-fixture',JSON.stringify(snapshot));
  });
  await page.reload();
  const consumer=page.locator('[data-workflow-card="consumer"]');
  const editor=consumer.getByRole('textbox',{name:'卡片指令',exact:true});await editor.waitFor();
  assert.deepEqual(await editor.locator('[data-reference-id]').allTextContents(),['@文本 1','@文本 2']);
  const execute=async expected=>assert.equal(await page.evaluate(async()=>{
    const {api}=await import('/src/lib/api.ts');
    const {useStore}=await import('/src/store.ts');
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    let received;
    api.localAgentFindAssetId=async()=> 'existing';
    useStore.setState({startGeneration:async(...args)=>{
      received=args[0];const identity=args[12];
      useStore.setState(s=>({genJobs:{...s.genJobs,[identity.jobId]:{turns:[{turnKey:identity.turnKey,images:['existing.png']}]}}}));return {accepted:true};
    }});
    const c=canvasWorkflowController('p');await c.start('consumer',true);
    if(c.document.run.status!=='done')throw Error(JSON.stringify(c.document.run));
    return received;
  }),expected);
  await execute('甲 / 乙');
  // Real UI disconnect and reconnect: pipe 2 must keep its number and its value.
  await consumer.getByRole('button',{name:'输入：文本',exact:true}).click({button:'right'});
  await page.getByRole('menuitem').filter({hasText:'文本 1'}).click();
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(n=>n.id==='consumer').inputs.text.length===1);
  await editor.press('End');await editor.pressSequentially('@');
  const menu=page.getByRole('listbox',{name:'收到的内容'});await menu.waitFor();
  assert.equal(await menu.getByRole('option').count(),1);
  assert.match(await menu.getByRole('option').innerText(),/文本 2/);
  await editor.press('Escape');await editor.press('Backspace');
  const cell=page.locator('[data-canvas-node-id="pipes-table"] [data-canvas-cell="c"]');
  await cell.hover();await cell.locator('[data-workflow-cell="c"]').click();
  await consumer.getByRole('button',{name:'输入：文本',exact:true}).click();
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(n=>n.id==='consumer').inputs.text.length===2);
  // Clicking the same source again must not duplicate the pipe (slot metadata is not source identity).
  await cell.hover();await cell.locator('[data-workflow-cell="c"]').click();
  await consumer.getByRole('button',{name:'输入：文本',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(n=>n.id==='consumer').inputs.text.map(i=>[i.slot,i.cellId])),[[2,'b'],[1,'c']]);
  await page.evaluate(()=>window.save());await page.reload();await editor.waitFor();
  assert.deepEqual(await editor.locator('[data-reference-id]').allTextContents(),['@文本 1','@文本 2']);
  await execute('新甲 / 乙');
  await page.evaluate(async()=>{
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const c=canvasWorkflowController('p');
    await c.edit(c.document.nodes.map(n=>({...n,inputs:{...n.inputs,text:[...n.inputs.text].reverse()}})));
  });
  await execute('新甲 / 乙');
  assert.deepEqual(errors,[]);
  console.log('PASS numbered input pipes: legacy mismatch, real disconnect/reconnect, stable menu/chips, duplicate wire, reload, reorder and current runtime values');
}finally{await browser.close();await server.close();}
