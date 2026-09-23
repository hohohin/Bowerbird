import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium} from '../../html-renderer/node_modules/playwright/index.mjs';
const server=await createServer({configFile:false,root:process.cwd(),server:{host:'127.0.0.1',port:1596,strictPort:true,hmr:false,watch:null}});
await server.listen();const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1700,height:1100}});
try {
  await page.goto('http://127.0.0.1:1596/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(()=>{const s=window.snapshot();s.nodes=s.nodes.filter(n=>n.id!=='far');sessionStorage.setItem('reference-fixture',JSON.stringify(s));});
  await page.reload();await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async()=>{
    const {canvasContentInput}=await import('/src/lib/canvasContentInput.ts');
    const {emptyCanvasCell}=await import('/src/lib/canvasNotes.ts');
    const check=(value,message)=>{if(!value)throw new Error(message);};
    for(let count=1;count<=16;count++) {
      const assets=Array.from({length:count},(_,i)=>'image-'+i);
      const note={schema_version:1,note_type:'text',text:'',member_ids:[],cells:[[{...emptyCanvasCell(),id:'first'}]]};
      const target={nodeId:'card',cellId:'first',append:true};
      const result=canvasContentInput(note,target,{type:'image',assetIds:assets});
      const width=Math.ceil(Math.sqrt(count)),height=Math.ceil(count/width);
      check(result.note.cells.length===height&&result.note.cells.every(row=>row.length===width),'balanced dimensions for '+count);
      check(JSON.stringify(result.note.cells.flat().flatMap(cell=>cell.image_refs?.map(ref=>ref.asset_id)??[]))===JSON.stringify(assets),'row-major order for '+count);
      check(result.note.column_widths.length===width&&result.note.row_heights.length===height,'matching grid weights');
      const rerun=canvasContentInput(result.note,{...target,cellIds:result.cellIds},{type:'image',assetIds:assets.map(id=>id+'-new')});
      check(JSON.stringify(rerun.cellIds)===JSON.stringify(result.cellIds)&&rerun.note.cells.length===height,'rerun keeps references and shape');
      const text=canvasContentInput(note,{...target,append:false},{type:'text',text:'unchanged text'});
      check(text.note.cells[0][0].text==='unchanged text','text remains literal');
    }
  });
  await page.getByRole('button',{name:'内容卡片工具',exact:true}).click();
  await page.locator('.canvas-stage').click({position:{x:700,y:280}});
  const card=page.locator('.is-content-card').first();await card.waitFor();
  await page.evaluate(async()=>{
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');const {newWorkflowNode}=await import('/src/lib/canvasWorkflow.ts');
    const c=canvasWorkflowController('p');await c.load();
    await c.edit([{...newWorkflowNode('skill',30,40,'codex'),id:'source',outputs:{image:{type:'image',assetIds:['a','b','c']}}}]);
  });
  await page.getByRole('button',{name:'适应内容',exact:true}).click();
  await page.locator('[data-workflow-card="source"]').getByRole('button',{name:'输出：图片',exact:true}).click();
  await card.hover();await card.getByRole('button',{name:'内容卡片图片输入',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.is-content-card')?.querySelectorAll('.canvas-image-content img').length===3);
  assert.equal(await card.getByRole('row').count(),2);
  const inputs=await card.getByRole('button',{name:'内容卡片图片输入',exact:true}).evaluate(e=>({color:getComputedStyle(e).backgroundColor,hit:document.elementFromPoint(e.getBoundingClientRect().x+6,e.getBoundingClientRect().y+6)===e}));
  assert.equal(inputs.color,'rgb(97, 184, 162)');assert.equal(inputs.hit,true);
  const add=card.getByRole('button',{name:'在第 2 列位置插入',exact:true});
  const addBox=await add.locator('svg').boundingBox(),gridBox=await card.getByRole('table').boundingBox();
  const cardBox=await card.boundingBox();
  assert.ok(Math.abs(gridBox.y-cardBox.y-31)<1,'table follows the original 30px title bar without added top spacing');
  assert.ok(addBox.y>=gridBox.y+gridBox.height,'add-column button sits below the table, away from title tools');
  await card.locator('.canvas-text-handle').hover({position:{x:20,y:10}});
  assert.equal(await add.evaluate(e=>getComputedStyle(e).opacity),'0','hovering or selecting the card does not reveal all insert controls');
  await add.locator('svg').hover();
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('[aria-label="在第 2 列位置插入"]')).opacity==='1');
  assert.equal(await add.evaluate(e=>getComputedStyle(e).opacity),'1','hovering the column insertion boundary reveals its control');
  for(const label of ['内容卡片输入','内容卡片图片输入','输出全部文本','输出容器图片','输入第 1 行第 1 列','输入第 1 行第 1 列图片','输出第 1 行第 1 列图片']) {
    if(label.includes('第 1 行')) await card.getByRole('cell').first().hover();
    const port=card.getByRole('button',{name:label,exact:true});await port.hover();
    assert.equal(await port.evaluate(e=>{const r=e.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===e;}),true,label+' is not covered by insert controls');
  }
  const rowAdd=card.getByRole('button',{name:'在第 2 行位置插入',exact:true});await rowAdd.click();
  assert.equal(await card.getByRole('row').count(),3);
  await card.getByRole('button',{name:'删除第 2 行',exact:true}).click();
  assert.equal(await card.getByRole('row').count(),2);
  await add.locator('svg').click();assert.equal(await card.getByRole('cell').count(),6);
  await page.evaluate(async()=>{
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const {newWorkflowNode,workflowOrder}=await import('/src/lib/canvasWorkflow.ts');const {api}=await import('/src/lib/api.ts');const {useStore}=await import('/src/store.ts');
    const c=canvasWorkflowController('p'),read=()=>JSON.parse(window.snapshot().nodes.find(n=>n.id===writer.textTarget.nodeId).payloadJson);
    let writer=c.document.nodes.find(n=>n.textTarget);const ids=writer.textTarget.cellIds.slice();
    const check=(v,m)=>{if(!v)throw new Error(m);};
    check(ids.length===3&&read().cells.flat().every(cell=>(cell.image_refs?.length??0)<=1),'one image per owned slot');
    const input={canvasNodeId:writer.textTarget.nodeId,cellId:ids[1]};
    const gen={...newWorkflowNode('generation',1200,40,'codex'),id:'gen',prompt:'参考 @[cell]',inputs:{image:[input]},promptReferences:[{id:'cell',type:'image',input,label:'第二格'}]};
    await c.edit([...c.document.nodes,gen]);check(workflowOrder(c.document.nodes,writer.id).includes('gen'),'secondary cell tracks producer');
    api.localAgentFindAssetId=async()=> 'existing';window.sent=[];
    useStore.setState({startGeneration:async(...args)=>{window.sent.push(args[1].map(a=>a.id));const identity=args[12];useStore.setState(s=>({genJobs:{...s.genJobs,[identity.jobId]:{turns:[{turnKey:identity.turnKey,images:['existing.png']}]}}}));return {accepted:true};}});
    await c.edit(c.document.nodes.map(n=>n.id==='source'?{...n,outputs:{image:{type:'image',assetIds:['c','d','a']}}}:n));
    await c.start(writer.id);check(c.document.run.status==='done'&&window.sent[0].join(',')==='d','secondary cell sends current image downstream');
    check(read().cells.length===2,'rerun reuses rows');
    await c.edit(c.document.nodes.map(n=>n.id==='source'?{...n,outputs:{image:{type:'image',assetIds:['b']}}}:n));await c.start(writer.id,true);
    check(ids.map(id=>read().cells.flat().find(cell=>cell.id===id).image_refs[0].asset_id).join(',')==='b,d,a','only cells receiving new images are replaced');
    await c.edit(c.document.nodes.map(n=>n.id==='source'?{...n,outputs:{image:{type:'image',assetIds:['b','c','d','a']}}}:n));await c.start(writer.id,true);
    writer=c.document.nodes.find(n=>n.id===writer.id);
    check(ids.every((id,i)=>writer.textTarget.cellIds[i]===id)&&writer.textTarget.cellIds.length===4,'grow keeps stable cell references');
    const before=JSON.stringify(read().cells);
    let cycle=false;try{await c.bindTextInput(writer.textTarget.nodeId,ids[0],input,'image');}catch{cycle=true;}check(cycle&&JSON.stringify(read().cells)===before,'secondary slot self-cycle rejected');
    window.writerId=writer.id;window.save();
  });
  await page.reload();await card.waitFor();
  await page.waitForFunction(()=>document.querySelector('.is-content-card')?.querySelectorAll('.canvas-image-content img').length===4);
  assert.equal(await card.getByRole('row').count(),3);
  await card.hover();await card.getByRole('button',{name:'内容卡片图片输入',exact:true}).click({button:'right'});
  await page.waitForFunction(()=>!JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.some(n=>n.textTarget));
  assert.equal(await card.locator('.canvas-image-content img').count(),4);
  await page.evaluate(async()=>{
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const {newWorkflowNode,workflowOrder}=await import('/src/lib/canvasWorkflow.ts');
    const c=canvasWorkflowController('p');
    const table=window.snapshot().nodes.find(n=>n.kind==='note');
    const cells=JSON.parse(table.payloadJson).cells.flat();
    const source={canvasNodeId:table.id,cellId:cells[0].id};
    const target={canvasNodeId:table.id,cellId:cells[1].id};
    const bad={...newWorkflowNode('generation',1200,400,'codex'),id:'bad-reference',prompt:'@[image] @[missing]',
      inputs:{image:[target]},promptReferences:[
        {id:'image',type:'image',input:target,label:'图片 1'},
        {id:'missing',type:'text',input:{canvasNodeId:table.id,cellId:'removed'},label:'文本 2'},
      ]};
    await c.edit([...c.document.nodes,bad]);
    await c.bindTextInput(table.id,cells[1].id,source,'image');
    const read=()=>JSON.parse(window.snapshot().nodes.find(n=>n.id===table.id).payloadJson).cells.flat();
    if(read()[1].image_refs[0].asset_id!==read()[0].image_refs[0].asset_id)throw Error('cell-to-cell connection failed to copy image');
    workflowOrder(c.document.nodes,'bad-reference');
    await c.start('bad-reference');
    if(c.document.run.status!=='failed'||c.issue?.referenceLabel!=='文本 2')throw Error('execution must still reject broken prompt references');
    const before=JSON.stringify(read());
    let cycle=false;try{await c.bindTextInput(table.id,cells[0].id,target,'image');}catch(error){cycle=error.message.includes('循环');}
    if(!cycle||JSON.stringify(read())!==before)throw Error('cell-to-cell cycle must be rejected without changing content');
  });
  await page.screenshot({path:'.tmp/workflow/content-inputs.png'});
  console.log('content inputs: balanced grids for 1–16 images, green connection/disconnect, unobstructed ports, relocated add-column control, rerun/shrink/grow, stable references, secondary dependencies/cycle and reload passed');
}finally{await browser.close();await server.close();}
