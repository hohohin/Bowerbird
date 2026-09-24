import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server=await createServer({configFile:false,root:process.cwd(),server:{host:'127.0.0.1',port:1595,strictPort:true,hmr:false,watch:null}});
await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1600,height:1000}});
try {
  await page.goto('http://127.0.0.1:1595/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(()=>{
    const s=window.snapshot(),base=s.nodes[0],cell=(id,text)=>({id,text,bold:false,italic:false,align:'left'});
    s.nodes=[{...base,id:'content',kind:'note',role:null,assetId:null,x:80,y:80,width:500,height:300,payloadJson:JSON.stringify({schema_version:1,note_type:'images',text:'',cells:[[{...cell('image','@图片1'),image_refs:[{asset_id:'a',token:'@图片1'}]},cell('replace','')]],member_ids:[]})},
      {...base,id:'source',kind:'note',role:null,assetId:null,x:700,y:80,width:300,height:200,payloadJson:JSON.stringify({schema_version:1,note_type:'text',text:'',cells:[[cell('text','  原文\n第二行  ')]],member_ids:[]})}];
    s.view={...s.view,zoom:1,panX:50,panY:50};sessionStorage.setItem('reference-fixture',JSON.stringify(s));
  });
  await page.reload();
  const card=page.locator('[data-canvas-node-id="content"]');await card.waitFor();
  assert.equal(await page.getByRole('button',{name:'图片容器工具',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'内容卡片工具',exact:true}).count(),1);
  await card.getByRole('button',{name:'放大图片：合成参考 a',exact:true}).click();
  await page.getByRole('dialog',{name:'媒体预览，1 / 1',exact:true}).waitFor();await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({state:'detached'});
  await page.evaluate(async()=>{
    const {api}=await import('/src/lib/api.ts');const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const {newWorkflowNode}=await import('/src/lib/canvasWorkflow.ts');const {readCanvasNote,canvasNoteValue}=await import('/src/lib/canvasNotes.ts');
    const {useStore}=await import('/src/store.ts');const check=(v,m)=>{if(!v)throw new Error(m);};
    const c=canvasWorkflowController('p');await c.load();
    await c.bindTextInput('content','replace',{canvasNodeId:'source',cellId:'text'},'text');
    let note=readCanvasNote(window.snapshot().nodes.find(n=>n.id==='content'));
    check(note.cells[0][0].id==='image'&&note.cells[0][0].content_type==='image','legacy image identity survives');
    check(note.cells[0][1].text==='  原文\n第二行  '&&note.cells[0][1].content_type==='text','legacy container accepts exact text');
    await c.bindTextInput('content',undefined,{assetId:'b'},'image');
    await c.bindTextInput('content',undefined,{canvasNodeId:'source',cellId:'text'},'text');
    note=readCanvasNote(window.snapshot().nodes.find(n=>n.id==='content'));
    check(note.cells.length===3&&note.cells[1][0].content_type==='image'&&note.cells[2][0].content_type==='text','main input appends matching cell types');
    check(note.cells[1][1].content_type==='text','new empty cells default to text');
    const imageInput={canvasNodeId:'content',cellId:'*'},textInput={canvasNodeId:'content',cellId:'*text'};
    const gen={...newWorkflowNode('generation',1100,80,'codex'),id:'gen',prompt:'@[text]\n参考 @[image]',inputs:{image:[imageInput],text:[textInput]},promptReferences:[{id:'text',type:'text',input:textInput,label:'全部文本'},{id:'image',type:'image',input:imageInput,label:'全部图片'}]};
    await c.edit([...c.document.nodes,gen]);
    api.localAgentFindAssetId=async()=> 'existing';window.contentRequests=[];
    useStore.setState({startGeneration:async(...args)=>{
      window.contentRequests.push({prompt:args[0],ids:args[1].map(a=>a.id)});const identity=args[12];
      useStore.setState(s=>({genJobs:{...s.genJobs,[identity.jobId]:{turns:[{turnKey:identity.turnKey,images:['existing.png']}]}}}));return {accepted:true};
    }});
    const writer=c.document.nodes.find(n=>n.textTarget?.append&&n.inputs.image);
    await c.start(writer.id);check(c.document.run.status==='done','aggregate consumers run after writers');
    check(window.contentRequests[0].ids.join(',')==='a,b','aggregate images');
    check(window.contentRequests[0].prompt===canvasNoteValue(note,'*text').text+'\n参考 @图片1 @图片2','aggregate preserves text and reference indices');
    let cycle=false;try{await c.bindTextInput('content','replace',textInput,'text');}catch{cycle=true;}check(cycle,'text aggregate rejects self cycle');
    await c.bindTextInput('content','replace',{assetId:'c'},'image');
    note=readCanvasNote(window.snapshot().nodes.find(n=>n.id==='content'));check(canvasNoteValue(note,'replace').assetIds[0]==='c','text converts to image in same cell');
    await c.bindTextInput('content','replace',{canvasNodeId:'source',cellId:'text'},'text');
    note=readCanvasNote(window.snapshot().nodes.find(n=>n.id==='content'));check(canvasNoteValue(note,'replace').text==='  原文\n第二行  ','image converts back to text in same cell');
    window.save();
  });
  await page.getByRole('button',{name:'适应内容',exact:true}).click();
  await card.hover();
  assert.equal(await card.getByRole('button',{name:'输出容器图片',exact:true}).isVisible(),true);
  assert.equal(await card.getByRole('button',{name:'输出全部文本',exact:true}).isVisible(),true);
  assert.equal(await card.getByRole('button',{name:'输出第 1 行第 1 列图片',exact:true}).count(),1);
  assert.equal(await card.getByRole('button',{name:'输出第 1 行第 2 列文本',exact:true}).count(),1);
  await page.screenshot({path:'.tmp/workflow/content-card.png'});
  await page.reload();await card.waitFor();
  assert.equal(await card.getByRole('textbox',{name:'第 1 行第 2 列',exact:true}).inputValue(),'  原文\n第二行  ');
  assert.equal(await card.locator('.canvas-image-preview').count(),2);
  console.log('content card: legacy migration, mixed cells, main append, type replacement, dual aggregates, downstream run, cycle rejection, preview and reload passed');
}finally{await browser.close();await server.close();}
