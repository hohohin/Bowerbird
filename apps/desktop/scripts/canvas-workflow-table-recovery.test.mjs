import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium} from '../../html-renderer/node_modules/playwright/index.mjs';
const server=await createServer({configFile:false,root:process.cwd(),server:{host:'127.0.0.1',port:1638,strictPort:true,hmr:false,watch:null}});
await server.listen();const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();
try {
  await page.goto('http://127.0.0.1:1638/scripts/fixtures/canvas-reference/preview.html');await page.locator('[data-canvas-node-id="old"]').waitFor();
  const result=await page.evaluate(async()=>{
    const {canvasContentInput}=await import('/src/lib/canvasContentInput.ts');
    const {emptyCanvasCell}=await import('/src/lib/canvasNotes.ts');
    const {api}=await import('/src/lib/api.ts');
    const {CanvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const {newWorkflowNode}=await import('/src/lib/canvasWorkflow.ts');
    const {useStore}=await import('/src/store.ts');
    const check=(value,message)=>{if(!value)throw Error(message);};
    const grid=Array.from({length:22},(_,r)=>Array.from({length:9},(_,c)=>`r${r}c${c}`));
    const cell=(id,text='')=>({...emptyCanvasCell(),id,text});
    const note=cells=>({schema_version:1,note_type:'text',text:'',member_ids:[],cells});
    const target={nodeId:'receiver',cellId:grid[0][0],append:true,cellIds:grid.flat(),tableCellIds:grid};
    const table={columns:Array.from({length:9},(_,c)=>`列${c}`),rows:Array.from({length:21},(_,r)=>Array.from({length:9},(_,c)=>`${r}:${c}`))};
    const value={type:'text',text:'结果',table};
    const truncated=note(grid.slice(0,15).map(row=>row.slice(0,6).map(id=>cell(id,'旧值'))));
    const restored=canvasContentInput(truncated,target,value);
    check(restored.note.cells.length===22&&restored.note.cells.every(row=>row.length===9),'restore reported 15x6 receiver to its 22x9 owned grid');
    check(JSON.stringify(restored.tableCellIds)===JSON.stringify(grid),'reuse original destination identities');
    check(restored.note.cells[21][8].text==='20:8'&&truncated.cells.length===15,'write latest table without mutating input');

    const smaller={columns:table.columns.slice(0,6),rows:table.rows.slice(0,14).map(row=>row.slice(0,6))};
    const compact=canvasContentInput(truncated,target,{type:'text',text:'当前较小结果',table:smaller});
    check(compact.note.cells[14][5].text==='13:5'&&compact.note.cells[21][8].text==='', 'smaller current result clears restored historical slots');

    // Missing interior rows/columns are restored by insertion, without overwriting neighbors.
    const smallGrid=grid.slice(0,4).map(row=>row.slice(0,3));
    const smallTarget={...target,cellIds:smallGrid.flat(),tableCellIds:smallGrid};
    const small=note([...smallGrid.map((row,r)=>[...row.map(id=>cell(id)),cell(`neighbor-${r}`,'手写内容')]),[cell('footer','保留'),cell('f1'),cell('f2'),cell('f3')]]);
    small.cells=small.cells.filter((_,r)=>r!==1).map(row=>row.filter((_,c)=>c!==1));
    const expanded=canvasContentInput(small,smallTarget,{type:'text',text:'新文字'});
    check(smallGrid.flat().every(id=>expanded.note.cells.flat().some(cell=>cell.id===id)),'restore interior IDs');
    check(expanded.note.cells.flat().find(cell=>cell.id==='neighbor-2')?.text==='手写内容'&&expanded.note.cells.flat().find(cell=>cell.id==='footer')?.text==='保留','preserve neighboring content');
    for(const [t,reserved] of [[{...target,cellIds:target.cellIds.slice(1)},[]],[target,[grid[0][1]]]]) {
      let rejected=false;try{canvasContentInput(truncated,t,value,reserved);}catch{rejected=true;}check(rejected,'never reclaim cells owned by another input');
    }

    // Inject failure between saving the expanded ownership and saving the content.
    const base=window.snapshot().nodes[0];
    for(const [id,payload] of [['seed',note([[cell('seed-cell','本轮输入')]])],['receiver',note([[cell('root')]])]]) await api.projectCanvasNodeCreate({...base,id,kind:'note',assetId:null,role:null,payloadJson:JSON.stringify(payload)});
    const loop={...newWorkflowNode('loop',0,0,''),id:'loop',loopMode:'rows',inputs:{text:[{canvasNodeId:'seed',cellId:'*text'}]}};
    const agent={...newWorkflowNode('agent',0,0,''),id:'agent',prompt:'返回表格',inputs:{text:[{nodeId:'loop',portId:'text'}]}};
    const writer={...newWorkflowNode('text',0,0,''),id:'writer',inputs:{text:[{nodeId:'agent',portId:'text'}]},textTarget:{nodeId:'receiver',cellId:'root',append:true}};
    let submitted=0,fail=true;
    api.agentDsWorkflowStart=async()=>{submitted++;return {autoDelivered:true,path:'isolated'};};
    api.agentDsWorkflowResult=async requestId=>({schemaVersion:1,requestId,text:JSON.stringify({format:'bowerbird-table',...table})});
    const update=api.projectCanvasNoteUpdate;api.projectCanvasNoteUpdate=async(id,payload)=>{if(id==='receiver'&&fail){fail=false;throw Error('模拟内容写入中断');}return update(id,payload);};
    useStore.setState({cloudAuth:null,cloudEntitlement:null});
    const c=new CanvasWorkflowController('table-recovery');await c.load();await c.edit([loop,agent,writer]);await c.start('loop');
    check(c.document.run.status==='waiting'&&c.document.run.steps.agent.status==='done'&&c.document.run.steps.writer.status==='failed','write failure pauses loop after saving the Agent result');
    const request=c.document.run.steps.agent.localDsRequestId;
    const pending=c.document.nodes.find(n=>n.id==='writer').textTarget.tableCellIds;
    check(pending.length===22&&JSON.parse(window.snapshot().nodes.find(n=>n.id==='receiver').payloadJson).cells.length===1,'ownership saved before failed content write');
    const resumed=new CanvasWorkflowController('table-recovery');await resumed.load();await resumed.retryLoop(resumed.document.run.id);
    check(resumed.document.run.status==='done',JSON.stringify(resumed.issue));
    check(submitted===1&&resumed.document.run.steps.agent.localDsRequestId===request,'retry reuses original successful Agent request');
    const saved=JSON.parse(window.snapshot().nodes.find(n=>n.id==='receiver').payloadJson);
    check(JSON.stringify(saved.cells.map(row=>row.map(cell=>cell.id)))===JSON.stringify(pending),'retry materializes exact persisted grid');
    check(saved.cells[21][8].text==='20:8'&&resumed.document.run.loop.completed.length===1,'full result and loop checkpoint complete');
    return {submitted,rows:saved.cells.length,columns:saved.cells[0].length};
  });
  assert.equal(result.submitted,1);console.log('PASS table receiver repair, retained IDs/neighbors, ownership protection, interrupted write/reload/retry without Agent resubmission',result);
}finally{await browser.close();await server.close();}
