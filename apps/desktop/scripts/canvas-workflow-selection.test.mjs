import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ configFile:false, root:process.cwd(), server:{host:'127.0.0.1',port:1586,strictPort:true,hmr:false,watch:null} });
await server.listen();
const browser = await chromium.launch({channel:'chrome',headless:true});
const page = await browser.newPage({viewport:{width:1800,height:1200}});
const errors=[]; page.on('pageerror', error=>errors.push(error.message));
const card = id => page.locator(`[data-workflow-card="${id}"]`);
const image = page.locator('[data-canvas-node-id="old"]');
const coords = () => page.evaluate(async()=>{
  const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
  return { workflow:canvasWorkflowController('p').document.nodes.map(({id,x,y})=>({id,x,y})), image:window.snapshot().nodes.find(n=>n.id==='old'), text:window.snapshot().nodes.find(n=>n.id==='text') };
});
const close = (a,b) => assert.ok(Math.abs(a-b)<0.1, `${a} ≠ ${b}`);
async function drag(locator, dx, dy, end=true) {
  const box=await locator.boundingBox();
  await page.mouse.move(box.x+35,box.y+12); await page.mouse.down();
  await page.mouse.move(box.x+35+dx,box.y+12+dy,{steps:8});
  if(end) await page.mouse.up();
}
async function reset(zoom) {
  await page.evaluate(async zoom=>{
    const snapshot=window.snapshot(); snapshot.nodes=snapshot.nodes.filter(n=>n.id==='old');
    snapshot.nodes[0]={...snapshot.nodes[0],x:100,y:100,width:190,height:180};
    snapshot.nodes.push({...snapshot.nodes[0],id:'text',kind:'note',assetId:null,role:null,x:100,y:290,width:190,height:130,payloadJson:JSON.stringify({schema_version:1,note_type:'text',text:'混合选择文本',member_ids:[]})});
    snapshot.view={...snapshot.view,zoom,panX:50,panY:70};
    sessionStorage.setItem('reference-fixture',JSON.stringify(snapshot));
    const {newWorkflowNode,emptyWorkflow}=await import('/src/lib/canvasWorkflow.ts');
    const document=emptyWorkflow();
    document.nodes=[{...newWorkflowNode('instruction',400,100,'codex'),id:'one'}, {...newWorkflowNode('visual-profile',800,100,'codex'),id:'two'}];
    document.nodes[1].inputs.text=[{nodeId:'one',portId:'text'}];
    sessionStorage.setItem('workflow-p',JSON.stringify({revision:0,document}));
    localStorage.setItem('bowerbird.canvasSnapEnabled','false');
  },zoom);
  await page.reload(); await card('two').waitFor();
}
try {
  await page.goto('http://127.0.0.1:1586/scripts/fixtures/canvas-reference/preview.html'); await image.waitFor();
  for (const zoom of [1,0.5]) {
    await reset(zoom);
    const ib=await image.boundingBox(), wb=await card('two').boundingBox();
    await page.mouse.move(ib.x-15,ib.y-15); await page.mouse.down();
    await page.mouse.move(wb.x+wb.width+15,wb.y+wb.height+15,{steps:10}); await page.mouse.up();
    assert.equal(await page.locator('.workflow-card.is-selected').count(),2);
    assert.ok((await image.getAttribute('class')).includes('is-selected'));
    await page.keyboard.down('Control'); await card('two').locator('header strong').click(); await page.keyboard.up('Control');
    assert.equal(await page.locator('.workflow-card.is-selected').count(),1);
    await page.keyboard.down('Control'); await card('two').locator('header strong').click(); await page.keyboard.up('Control');
    assert.equal(await page.locator('.workflow-card.is-selected').count(),2);
    const before=await coords();
    await drag(card('one').locator('header strong'),70,50);
    await page.waitForFunction(x=>window.snapshot().nodes.find(n=>n.id==='old').x!==x,before.image.x);
    const after=await coords();
    for(let i=0;i<2;i++){close(after.workflow[i].x-before.workflow[i].x,70/zoom);close(after.workflow[i].y-before.workflow[i].y,50/zoom);}
    close(after.image.x-before.image.x,70/zoom);
    close(after.text.x-before.text.x,70/zoom);
    assert.equal(await page.locator('.workflow-card.is-selected').count(),2);
    await page.keyboard.press('Control+z');
    await page.waitForFunction(x=>window.snapshot().nodes.find(n=>n.id==='old').x===x,before.image.x);
    assert.deepEqual((await coords()).workflow,before.workflow);
    // Starting from an image moves the same mixed selection, too.
    await drag(image,60,45);
    await page.waitForFunction(x=>window.snapshot().nodes.find(n=>n.id==='old').x!==x,before.image.x);
    close((await coords()).workflow[0].x-before.workflow[0].x,60/zoom);
    await page.keyboard.press('Control+z');
    await page.waitForFunction(x=>window.snapshot().nodes.find(n=>n.id==='old').x===x,before.image.x);
    // Escape restores all previews without committing a move.
    await drag(card('one').locator('header strong'),90,60,false);
    await page.keyboard.press('Escape'); await page.mouse.up();
    assert.deepEqual((await coords()).workflow,before.workflow);
    // Arrange the mixed selection through its normal context menu, then undo.
    await card('one').locator('header strong').click({button:'right'});
    await page.getByRole('menuitem',{name:'整理',exact:true}).click();
    await page.keyboard.press('Control+z');
    assert.deepEqual((await coords()).workflow,before.workflow);
    // Selecting a single card clears the marquee; snap to the image's left edge.
    await page.locator('.canvas-stage').click({position:{x:80,y:850}});
    await page.getByRole('button',{name:'吸附对齐',exact:true}).click();
    const source=await card('one').boundingBox(), target=await image.boundingBox();
    await drag(card('one').locator('header strong'),target.x-source.x+12,400*zoom,false);
    close((await card('one').boundingBox()).x,target.x);
    assert.ok(await page.locator('.canvas-snap-guide').count()>0);
    await page.mouse.up();
    const saved=(await coords()).workflow;
    await page.waitForFunction(x=>JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes[0].x===x,saved[0].x);
    await page.reload(); await card('one').waitFor();
    assert.deepEqual((await coords()).workflow,saved);
    assert.equal(await card('one').getByLabel('反推要求').count(),1);
  }
  assert.deepEqual(errors,[]);
  console.log('PASS workflow mixed marquee, drag from both card types, arrange, snap, cancellation, undo and persisted geometry at 100%/50%.');
} finally { await browser.close(); await server.close(); }
