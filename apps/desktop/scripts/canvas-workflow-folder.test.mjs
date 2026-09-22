import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium} from '../../html-renderer/node_modules/playwright/index.mjs';
const server=await createServer({configFile:false,root:process.cwd(),server:{host:'127.0.0.1',port:1586,strictPort:true,hmr:false,watch:null}});
await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1800,height:1200}});
try {
  await page.goto('http://127.0.0.1:1586/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async()=>{
    const {newWorkflowNode}=await import('/src/lib/canvasWorkflow.ts');
    const canvas=window.snapshot(),base=canvas.nodes[0];
    canvas.nodes=['a','b'].map((assetId,i)=>({...base,id:'member-'+i,assetId,x:100,y:100,payloadJson:JSON.stringify({schema_version:1,snapshot:{name:assetId,width:190,height:150}})}));
    canvas.groups=[{id:'folder',projectId:'p',name:'图片文件夹',x:100,y:100,width:240,height:230,zIndex:1,createdAt:1,updatedAt:1}];
    canvas.groupItems=canvas.nodes.map((node,ordinal)=>({groupId:'folder',nodeId:node.id,ordinal}));
    canvas.edges=[];canvas.view={...canvas.view,panX:0,panY:0,zoom:1};
    sessionStorage.setItem('reference-fixture',JSON.stringify(canvas));
    sessionStorage.setItem('workflow-p',JSON.stringify({revision:0,document:{schema_version:1,run:null,nodes:[{...newWorkflowNode('visual-profile',500,100,'codex'),id:'profile'}]}}));
  });
  await page.reload();
  const folder=page.locator('[data-canvas-node-id="folder"]');await folder.waitFor();
  const port=page.getByRole('button',{name:'连接文件夹图片到工作流',exact:true});
  await page.mouse.move(2,2);assert.equal(await port.evaluate(el=>getComputedStyle(el).opacity),'0');
  await folder.hover();
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-workflow-material="folder"]')).opacity==='1');
  await port.click();await page.locator('[data-workflow-card="profile"]').getByRole('button',{name:'输入：图片',exact:true}).click();
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes[0].inputs.image?.[0].groupId==='folder');
  await page.reload();await folder.waitFor();
  assert.equal(await page.locator('[data-workflow-card="profile"] .workflow-preview img').count(),2);
  await folder.click();
  await page.waitForFunction(()=>document.querySelector('[data-canvas-node-id="folder"]').classList.contains('is-expanded'));
  const edge=await port.boundingBox(),rect=await folder.boundingBox();
  assert.ok(Math.abs(edge.x+edge.width/2-(rect.x+rect.width))<3,'expanded folder port follows its right edge');
  await page.evaluate(async()=>{
    const {api}=await import('/src/lib/api.ts');
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const {useStore}=await import('/src/store.ts');
    const c=canvasWorkflowController('p');
    await c.edit(c.document.nodes.map(n=>({...n,kind:'instruction',action:'describe',inputs:{image:[{groupId:'folder',assetIds:['stale']}]}})));
    const realGet=api.projectCanvasGet;let members=['b','a'];
    api.projectCanvasGet=async id=>{const snap=await realGet(id);snap.groupItems=members.map((asset,ordinal)=>({groupId:'folder',nodeId:asset==='a'?'member-0':'member-1',ordinal}));return snap;};
    const calls=[];
    api.describeAsset=async id=>{calls.push(id);members=[];return 'analysis-'+id;};
    api.listAnalysesByAsset=async id=>[{id:'analysis-'+id,payload:JSON.stringify({sections:[{title:'描述',body:id}]})}];
    useStore.setState({defaultUnderstandProvider:'bowerbird-cloud'});
    await c.start('profile');
    if(c.document.run.status!=='done'||calls.join(',')!=='b,a')throw new Error('folder inputs must refresh then freeze in member order');
    let empty=false;try{await c.start('profile');}catch(e){empty=String(e).includes('没有可用图片');}
    if(!empty||calls.length!==2)throw new Error('empty folder must block provider submission');
    api.projectCanvasGet=async id=>({...await realGet(id),groups:[]});
    let missing=false;try{await c.start('profile');}catch(e){missing=String(e).includes('文件夹已删除');}
    if(!missing)throw new Error('deleted folder must be explicit');
  });
  console.log('PASS folder hover port, visual-profile connection, reload, expanded anchor, ordered current members, frozen run and empty/deleted guards');
} finally {await browser.close();await server.close();}
