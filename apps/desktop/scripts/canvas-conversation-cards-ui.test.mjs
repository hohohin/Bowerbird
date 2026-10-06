import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({configFile:false,root:process.cwd(),server:{host:'127.0.0.1',port:1597,strictPort:true,hmr:false,watch:null}});
await server.listen();
const browser = await chromium.launch({channel:'chrome',headless:true});
const page = await browser.newPage({viewport:{width:1600,height:1000}});
const errors=[]; page.on('pageerror',e=>errors.push(e.message));
try {
  await page.goto('http://127.0.0.1:1597/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(()=>{
    const s=window.snapshot(),base=s.nodes[0];
    const session={...base,id:'session',kind:'prompt',assetId:null,role:null,x:200,y:100,width:260,height:148,createdAt:1,payloadJson:JSON.stringify({schema_version:1,job_id:'job',turn_key:'one',text:'第一轮',provider:'codex',status:'done'})};
    const outputs=['a','b'].map((id,i)=>({...base,id:`output-${id}`,assetId:id,role:'output',x:500+i*220,y:100,createdAt:1,payloadJson:JSON.stringify({schema_version:1,snapshot:{name:id,width:190,height:150},execution:{job_id:'job',turn_key:'one'}})}));
    s.nodes=[{...base,x:50,y:500},session,...outputs];
    s.edges=outputs.map((n,i)=>({id:`edge-${i}`,projectId:'p',threadId:'t',fromNodeId:'session',toNodeId:n.id,kind:'produced',ordinal:i,createdAt:1}));
    s.view={...s.view,panX:50,panY:60,zoom:1};sessionStorage.setItem('reference-fixture',JSON.stringify(s));
  });
  await page.reload();
  const card=page.locator('[data-canvas-node-id="session"]');await card.waitFor();
  await page.locator('[data-conversation-image="b"]').waitFor();
  assert.equal(await page.locator('.canvas-prompt-node').count(),1);
  assert.equal(await page.locator('[data-canvas-node-id="output-a"]').count(),0);
  assert.equal(await page.locator('.canvas-graph-edges path').count(),0);
  await card.hover();await card.getByRole('button',{name:'上一张生成图片'}).click();
  await page.locator('[data-conversation-image="a"]').waitFor();
  assert.equal(await page.locator('[data-project-inspector]').count(),0);
  // Append a real-shaped continuation while mounted; the first card keeps its position.
  const before=await card.boundingBox();
  await page.evaluate(async()=>{
    const {api}=await import('/src/lib/api.ts');
    const s=window.snapshot(),base=s.nodes.find(n=>n.id==='session'),image=s.nodes.find(n=>n.id==='output-a');
    await api.projectCanvasNodeCreate({...base,id:'next',x:900,createdAt:2,payloadJson:JSON.stringify({schema_version:1,job_id:'job',turn_key:'two',text:'续轮修改',provider:'codex',status:'done'})});
    await api.projectCanvasNodeCreate({...image,id:'output-c',assetId:'c',createdAt:2,payloadJson:JSON.stringify({schema_version:1,snapshot:{name:'c',width:190,height:150},execution:{job_id:'job',turn_key:'two'}})});
    window.emitChange();
  });
  await page.locator('[data-conversation-image="c"]').waitFor();
  assert.equal(await page.locator('.canvas-prompt-node').count(),1);
  assert.equal(await page.locator('[data-canvas-node-id="next"]').count(),0);
  assert.equal(await page.locator('[data-workflow-session-output="next"]').count(),0);
  assert.match(await card.innerText(),/3\/3/);
  assert.deepEqual(await card.boundingBox(),before);
  await mkdir('.tmp/canvas-conversation-cards',{recursive:true});
  await page.screenshot({path:'.tmp/canvas-conversation-cards/group.png'});
  // Group remains a conversation entry, including saved jobs absent from memory.
  await card.click({position:{x:10,y:10}});
  await page.locator('[data-project-inspector]').waitFor();
  await page.getByTitle('关闭详情（进行中的任务不会中断）').click();
  // Existing exact-turn and single-image workflow wires both follow the folded card.
  await page.evaluate(async()=>{
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const {newWorkflowNode}=await import('/src/lib/canvasWorkflow.ts');
    const c=canvasWorkflowController('p');
    await c.edit([...c.document.nodes,{...newWorkflowNode('generation',600,500,'codex'),id:'downstream',inputs:{image:[{canvasNodeId:'session',cellId:'image'},{assetId:'a',assetNodeId:'output-a'}]}}]);
  });
  await page.locator('[data-workflow-target="downstream"]').first().waitFor({state:'attached'});
  assert.equal(await page.locator('[data-workflow-target="downstream"]').count(),2);
  // Removing the group hides all its turns/results; undo restores one group.
  await card.click({button:'right',position:{x:10,y:10}});
  await page.getByRole('menuitem',{name:/从画布移出/}).click();
  await card.waitFor({state:'detached'});
  assert.equal(await page.locator('.canvas-prompt-node').count(),0);
  assert.equal(await page.locator('[data-canvas-node-id="output-c"]').count(),0);
  await page.locator('[data-canvas-stage]').focus();
  await page.keyboard.press(process.platform==='darwin'?'Meta+z':'Control+z');
  await card.waitFor();await page.locator('[data-conversation-image="c"]').waitFor();
  await page.waitForFunction(()=>window.snapshot().nodes.filter(n=>["session","next","output-a","output-b","output-c"].includes(n.id)).every(n=>n.hiddenAt==null));
  await page.evaluate(()=>window.save());
  await page.reload();await card.waitFor();await page.locator('[data-conversation-image="c"]').waitFor();
  assert.equal(await page.locator('.canvas-prompt-node').count(),1);
  assert.deepEqual(errors,[]);
  console.log('conversation cards: carousel, continuation, stable position, visibility, remove/undo and reload passed');
} finally {await browser.close();await server.close();}
