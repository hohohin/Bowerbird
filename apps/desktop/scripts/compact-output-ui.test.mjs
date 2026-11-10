import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/compact-output/vite', server: { host:'127.0.0.1',port:17936,strictPort:true,hmr:false,watch:null } });
await server.listen();
const browser = await chromium.launch({channel:'chrome',headless:true});
const page = await browser.newPage({viewport:{width:1600,height:1000}});
page.setDefaultTimeout(10000);
const errors=[]; page.on('pageerror',e=>errors.push(e.message));
await mkdir('.tmp/compact-output',{recursive:true});
try {
  await page.goto('http://127.0.0.1:17936/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  const checks = await page.evaluate(async()=>{
    const {newWorkflowNode}=await import('/src/lib/canvasWorkflow.ts');
    const {placeWorkflowOutput,canvasOutputObstacles}=await import('/src/lib/canvasOutputPlacement.ts');
    const {canvasOutputGrid}=await import('/src/lib/canvasReferencePlacement.ts');
    const {mergeWorkflowChanges}=await import('/src/lib/workflowExternalChanges.ts');
    const canvas=window.snapshot(), base=canvas.nodes[0];
    const source={...newWorkflowNode('agent',100,100,''),id:'source',layoutSize:{width:320,height:156}};
    const prompt=(id,y)=>({...base,id,kind:'prompt',role:null,assetId:null,x:484,y,width:260,height:180,createdAt:y,
      payloadJson:JSON.stringify({schema_version:1,job_id:id,turn_key:'one',conversation_id:'shared',status:'done'})});
    canvas.nodes=[prompt('first',100),prompt('history',9000)]; canvas.groups=[];canvas.groupItems=[];canvas.edges=[];
    const obstacles=canvasOutputObstacles(canvas,[source]);
    const placed=placeWorkflowOutput(canvas,[source],source,{width:260,height:148});
    const empty={...canvas,nodes:[]};
    const before={schema_version:1,nodes:[source],run:null};
    const merged=mergeWorkflowChanges(before,{...before,nodes:[{...source,layoutSize:{width:320,height:180}}]},
      {...before,nodes:[{...source,prompt:'updated in another window'}]});
    return {visible:obstacles.length,ghost:obstacles.some(r=>r.y===9000),placed,
      mergedPrompt:merged.nodes[0].prompt,mergedHeight:merged.nodes[0].layoutSize.height,
      first:placeWorkflowOutput(empty,[source],source,{width:260,height:148}),
      grid:canvasOutputGrid(Array.from({length:6},()=>({width:190,height:180}))),unchanged:canvas.nodes[1].y};
  });
  assert.equal(checks.visible,2);assert.equal(checks.ghost,false);assert.equal(checks.unchanged,9000);
  assert.equal(checks.mergedPrompt,'updated in another window');assert.equal(checks.mergedHeight,180);
  assert.deepEqual(checks.first,{x:484,y:100});
  assert.ok(Math.abs(checks.placed.y-100)<420);
  assert.deepEqual(checks.grid,[{x:0,y:0},{x:222,y:0},{x:444,y:0},{x:0,y:212},{x:222,y:212},{x:444,y:212}]);
  await page.evaluate(async()=>{
    const {newWorkflowNode,emptyWorkflow}=await import('/src/lib/canvasWorkflow.ts');
    const snapshot=window.snapshot(),base=snapshot.nodes[0];
    const source={...newWorkflowNode('generation',100,100,'codex'),id:'source',resultNodeIds:Array.from({length:6},(_,i)=>`result-${i}`)};
    snapshot.nodes=source.resultNodeIds.map((id,i)=>({...base,id,kind:'asset',assetId:['a','b','c','d','e','a'][i],role:'output',
      x:500,y:100+i*420,width:190,height:180,payloadJson:JSON.stringify({schema_version:1,snapshot:{name:id,width:190,height:150}})}));
    snapshot.nodes.push({...base,id:'untouched',x:1050,y:700});
    snapshot.edges=[];snapshot.view={...snapshot.view,panX:0,panY:0,zoom:1};
    sessionStorage.setItem('reference-fixture',JSON.stringify(snapshot));
    sessionStorage.setItem('workflow-p',JSON.stringify({revision:0,document:{...emptyWorkflow(),nodes:[source]}}));
  });
  await page.reload();
  const source=page.locator('[data-workflow-card="source"]');await source.waitFor();
  await page.waitForFunction(async()=>{
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    return canvasWorkflowController('p').ready;
  });
  const before=await page.evaluate(()=>window.snapshot().nodes.map(({id,x,y})=>({id,x,y})));
  await source.click({button:'right',position:{x:40,y:35}});
  await page.getByRole('menuitem',{name:'整理',exact:true}).click();
  await page.waitForFunction(()=>window.calls.filter(c=>c.command==='project_canvas_node_update').length>=6);
  const after=await page.evaluate(()=>window.snapshot().nodes.map(({id,x,y})=>({id,x,y})));
  const children=after.filter(n=>n.id.startsWith('result-'));
  assert.equal(new Set(children.map(n=>n.x)).size,3);
  assert.equal(new Set(children.map(n=>n.y)).size,2);
  assert.ok(Math.max(...children.map(n=>n.y))-Math.min(...children.map(n=>n.y))<300);
  assert.deepEqual(after.find(n=>n.id==='untouched'),before.find(n=>n.id==='untouched'));
  for(const theme of ['dark','light']) {
    await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
    await page.screenshot({path:`.tmp/compact-output/${theme}.png`});
  }
  await page.keyboard.press('Control+z');
  await page.waitForFunction(expected=>window.snapshot().nodes.filter(n=>n.id.startsWith('result-')).every(n=>{
    const old=expected.find(p=>p.id===n.id);return old.x===n.x&&old.y===n.y;
  }),before);
  // Geometry measurements are persisted with the next workflow write, not each frame.
  const measured=await page.evaluate(async()=>{
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const c=canvasWorkflowController('p');await c.save();return c.document.nodes.find(n=>n.id==='source').layoutSize;
  });
  assert.ok(measured.width>0&&measured.height>0);
  assert.deepEqual(errors,[]);
  console.log('PASS: measured sizes, folded-history obstacles, six compact outputs, workflow traversal, unchanged unrelated card, undo, dark/light');
} catch(error) {
  await page.screenshot({path:'.tmp/compact-output/failure.png'});throw error;
} finally { await browser.close();await server.close(); }
