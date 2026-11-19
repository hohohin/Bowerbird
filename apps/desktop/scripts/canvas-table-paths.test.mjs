import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({cacheDir: '.tmp/table-paths', server:{host:'127.0.0.1',port:1679,strictPort:true,hmr:false}});
await server.listen();
const browser = await chromium.launch({channel:'chrome'});
try {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:1679/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  for (const mixed of [false,true]) for (const route of ['agent','loop','generation']) {
    const result = await page.evaluate(async ({mixed,route}) => {
      const {api} = await import('/src/lib/api.ts');
      const {CanvasWorkflowController} = await import('/src/lib/canvasWorkflowRuntime.ts');
      const {newWorkflowNode} = await import('/src/lib/canvasWorkflow.ts');
      const {useStore} = await import('/src/store.ts');
      const name = route + mixed, id = 'table-' + name;
      const cells = [['标题',''],['内容', mixed?'@图片1':'正文']].map((row,r)=>row.map((text,c)=>({
        id:'cell'+r+c,text, ...(mixed && r===1 && c===1 ? {content_type:'image',image_refs:[{token:'@图片1',asset_id:'b'}]} : {})
      })));
      await api.projectCanvasNodeCreate({...window.snapshot().nodes[0],id,kind:'note',assetId:null,role:null,payloadJson:JSON.stringify({schema_version:1,note_type:'text',cells,member_ids:[],text:''})});
      const native = {text:[{canvasNodeId:id,cellId:'*text',autoConnect:'native'}],image:[{canvasNodeId:id,cellId:'*',autoConnect:'native',mediaFilter:['image']}]};
      const loop = {...newWorkflowNode('loop',0,0,''),id:'loop',loopMode:'rows',inputs:{text:native.text}};
      const reader = {...newWorkflowNode(route==='generation'?'generation':'agent',400,0,'codex'),id:'reader',prompt:'读取输入',inputs:route==='loop'?Object.fromEntries(['text','image'].map(port=>[port,[{nodeId:'loop',portId:port,autoConnect:'iteration'}]])):native};
      const calls=[];
      const {localChat} = await import('/src/lib/localChat.ts');
      const {useLocalChatStore} = await import('/src/lib/localChatStore.ts');
      localChat.getByRequest=async()=>null;
      useLocalChatStore.setState({loadProject:async()=>{},applyConversation:()=>{},send:async input=>{
        calls.push({rows:JSON.parse(input.text.slice(input.text.indexOf('{')))['引用文本 1'].rows,images:input.referenceAssetIds});
        return {id:'chat',projectId:name,nodeId:'reader',submittedTurnId:'turn',messages:[{turnId:'turn',role:'assistant',status:'done',text:'完成'}]};
      }});
      useStore.setState({startGeneration:async (...args)=>{
        calls.push({rows:JSON.parse(args[0].slice(args[0].indexOf('{'))).rows,images:args[1].map(a=>a.id)});
        const {jobId}=args[12]; useStore.setState(s=>({genJobs:{...s.genJobs,[jobId]:{turns:[{images:['output.png']}]}}}));
        return {accepted:true,jobId};
      }});
      api.localAgentFindAssetId=async()=> 'output';
      const c=new CanvasWorkflowController(name);await c.load();await c.edit(route==='loop'?[loop,reader]:[reader]);
      await c.start(route==='loop'?'loop':'reader');
      return {status:c.document.run?.status,issue:c.issue,calls};
    },{mixed,route});
    console.log(route,mixed,result.status);
    assert.equal(result.status,'done',JSON.stringify(result));
    const rows=[['标题',''],['内容',mixed?'@图片1':'正文']];
    assert.deepEqual(result.calls.map(c=>c.rows),route==='loop'?rows.map(row=>[row]):[rows]);
    assert.deepEqual(result.calls.map(c=>c.images),route==='loop'?[[],mixed?['b']:[]]:[mixed?['b']:[]]);
  }
} finally { await browser.close(); await server.close(); }

