import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium} from '../../html-renderer/node_modules/playwright/index.mjs';
const server=await createServer({cacheDir:'.tmp/group-current-vite',server:{host:'127.0.0.1',port:0,hmr:false,watch:null}});
await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1600,height:1100}});
try {
 await page.goto(server.resolvedUrls.local[0]+'scripts/fixtures/canvas-reference/preview.html');
 await page.locator('[data-canvas-node-id="old"]').waitFor();
 await page.evaluate(()=>{
  const s=window.snapshot(),base=s.nodes[0];
  s.nodes=[{...base,id:'session',kind:'prompt',assetId:null,role:null,x:180,y:180,width:260,height:148,payloadJson:JSON.stringify({schema_version:1,job_id:'job',conversation_id:'job',turn_key:'turn',text:'组图',status:'done'})},
   ...Array.from({length:10},(_,i)=>({...base,id:'output-'+(i+1),assetId:'frame-'+(i+1),role:'output',createdAt:i+1,payloadJson:JSON.stringify({schema_version:1,snapshot:{name:'frame '+(i+1),width:190,height:150},execution:{job_id:'job',turn_key:'turn'}})}))];
  s.edges=[];s.groups=[];s.groupItems=[];s.view={...s.view,panX:0,panY:0,zoom:1};
  sessionStorage.setItem('reference-fixture',JSON.stringify(s));
 });
 await page.reload();
 await page.locator('.canvas-conversation-images').waitFor();
 await page.getByRole('button',{name:'上一张生成图片'}).click();
 await page.evaluate(async()=>{
  const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
  const {newWorkflowNode}=await import('/src/lib/canvasWorkflow.ts');
  const c=canvasWorkflowController('p');await c.load();await c.edit([{...newWorkflowNode('generation',700,180,'codex'),id:'target',prompt:'使用参考图'}]);
 });
 await page.locator('[data-workflow-material="session"] [data-canvas-connect-side="output"]').first().dragTo(page.locator('[data-workflow-card="target"] header'));
 await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(n=>n.id==='target').inputs.image?.length);
 const read=()=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(n=>n.id==='target').inputs.image);
 const original=await read();
 assert.match(JSON.stringify(original),/output-9/);
 await page.getByRole('button',{name:'下一张生成图片'}).click();
 assert.deepEqual(await read(),original);
 await page.locator('[data-workflow-material="session"] [data-canvas-connect-side="output"]').first().dragTo(page.locator('[data-workflow-card="target"] header'));
 await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(n=>n.id==='target').inputs.image.length === 2);
 const both=await read();
 assert.equal(both[0].assetNodeId,'output-9');
 assert.equal(both[1].assetNodeId,'output-10');
 await page.reload();
 await page.locator('[data-workflow-card="target"]').waitFor();
 assert.deepEqual(await read(),both);
 await page.evaluate(() => {
  const s=window.snapshot(), session=s.nodes.find(n=>n.id==='session');
  session.payloadJson=JSON.stringify({...JSON.parse(session.payloadJson),workflow_generation_group:'workflow:producer'});
  s.nodes.push({...session,id:'session-new',createdAt:20,payloadJson:JSON.stringify({schema_version:1,job_id:'new-job',conversation_id:'new-job',workflow_generation_group:'workflow:producer',turn_key:'new-turn',text:'新一轮',status:'done'})});
  const last=s.nodes.find(n=>n.id==='output-10');
  last.payloadJson=JSON.stringify({...JSON.parse(last.payloadJson),execution:{job_id:'new-job',turn_key:'new-turn'}});
  sessionStorage.setItem('reference-fixture',JSON.stringify(s));
 });
 await page.reload();
 await page.locator('[data-conversation-image="frame-10"]').waitFor();
 await page.getByRole('button',{name:'上一张生成图片'}).click();
 await page.locator('[data-conversation-image="frame-9"]').waitFor();
 await page.evaluate(async()=>{
  const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
  const c=canvasWorkflowController('p');await c.edit(c.document.nodes.map(n=>({...n,inputs:{}})));
 });
 await page.locator('.workflow-material-hotspot.is-image-session [data-canvas-connect-side="output"],[data-workflow-material="session-new"] [data-canvas-connect-side="output"]').first().dragTo(page.locator('[data-workflow-card="target"] header'));
 await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(n=>n.id==='target').inputs.image?.length);
 assert.equal((await read())[0].assetNodeId,'output-9','historical turn keeps displayed exact asset');
 await page.evaluate(() => {
  const s=window.snapshot(),base=s.nodes[0];
  for(const n of s.nodes.filter(n=>n.kind==='prompt')) n.payloadJson=JSON.stringify({...JSON.parse(n.payloadJson),conversation_id:'embedded-session'});
  s.nodes.push({...base,id:'container',kind:'note',threadId:null,assetId:null,role:null,x:180,y:180,width:320,height:260,
   payloadJson:JSON.stringify({schema_version:1,note_type:'images',text:'',cells:[[{id:'cell',text:'@图片1',content_type:'image',image_refs:[{token:'@图片1',asset_id:'frame-1'}],generation_ref:{session_node_id:'session',output_node_id:'output-1'}}]]})});
  sessionStorage.setItem('reference-fixture',JSON.stringify(s));
 });
 await page.reload();
 const cell=page.locator('[data-canvas-cell="cell"]');
 await cell.locator('[data-conversation-image="frame-10"]').waitFor();
 await cell.getByRole('button',{name:'上一张生成图片'}).click();
 await cell.locator('[data-conversation-image="frame-9"]').waitFor();
 await page.evaluate(async()=>{
  const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
  const c=canvasWorkflowController('p');await c.edit(c.document.nodes.map(n=>({...n,inputs:{}})));
 });
 await cell.locator('[data-canvas-connect-side="output"]').dragTo(page.locator('[data-workflow-card="target"] header'));
 await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(n=>n.id==='target').inputs.image?.length);
 assert.equal((await read())[0].assetNodeId,'output-9','embedded gallery sends displayed exact asset');
 await cell.hover();
 await cell.locator('[data-canvas-connect-side="input"]').click();
 await page.getByRole('menu',{name:'添加上游',exact:true}).waitFor();
 await page.keyboard.press('Escape');
 await cell.hover();
 await page.getByRole('button',{name:'在第 2 列位置插入',exact:true}).click();
 await page.waitForFunction(()=> {
  const card=window.snapshot().nodes.find(n=>n.id==='container');
  return JSON.parse(card.payloadJson).cells[0].length===2;
 });
 console.log('PASS selected ninth image binding survives pagination and reload');
} finally {await browser.close();await server.close();}
