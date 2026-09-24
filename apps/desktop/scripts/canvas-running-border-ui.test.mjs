import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ configFile:false, root:process.cwd(), server:{host:'127.0.0.1',port:1589,strictPort:true,hmr:false,watch:null} });
await server.listen();
const browser = await chromium.launch({channel:'chrome',headless:true});
const page = await browser.newPage({viewport:{width:1600,height:1000}});
const errors=[]; page.on('pageerror',error=>errors.push(error.message));
const workflow=page.locator('[data-workflow-card="work"]');
async function workflowState(status, step) {
  await page.evaluate(async ({status,step})=>{
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const controller=canvasWorkflowController('p');
    const run={id:'test-run',startId:'work',threadId:'t',order:['work'],lockedNodeIds:['work'],status,steps:{work:{status:step}}};
    await controller.save({...controller.document,runs:[run],run});
  },{status,step});
}
try {
  await page.goto('http://127.0.0.1:1589/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(()=>{
    const snapshot=window.snapshot(),base=snapshot.nodes[0];
    snapshot.nodes=[{...base,id:'session',kind:'prompt',assetId:null,role:null,x:100,y:120,width:290,height:160,
      payloadJson:JSON.stringify({text:'运行中的生成会话',status:'running',provider:'codex'})},
      {...base,id:'agent',kind:'agent_group',assetId:null,role:null,x:100,y:380,width:290,height:180,
      payloadJson:JSON.stringify({run_id:'agent-run',status:'running',skill_id:'bowerbird-unified-agent'})}];
    snapshot.view={...snapshot.view,zoom:1,panX:80,panY:50};
    sessionStorage.setItem('reference-fixture',JSON.stringify(snapshot));
  });
  await page.reload(); await page.locator('[data-canvas-node-id="session"]').waitFor();
  await page.evaluate(async()=>{
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const {newWorkflowNode}=await import('/src/lib/canvasWorkflow.ts');
    await canvasWorkflowController('p').edit([{...newWorkflowNode('generation',500,120,'codex'),id:'work'}]);
  });
  await workflow.waitFor();
  await workflowState('running','pending');
  assert.equal(await workflow.getAttribute('aria-busy'),'false');
  await workflowState('running','running');
  assert.equal(await page.locator('.canvas-card-running').count(),3);
  const border=()=>workflow.evaluate(el=>{const s=getComputedStyle(el,'::after');return {angle:s.getPropertyValue('--canvas-running-angle'),animation:s.animationName,pointer:s.pointerEvents,mask:s.maskComposite};});
  const first=await border();
  // Measure rendered thickness through the real canvas transform at each zoom.
  async function checkThickness() {
    const widths=await page.locator('.canvas-card-running').evaluateAll(elements=>elements.map(el=>{
      const scale=new DOMMatrixReadOnly(getComputedStyle(el.closest('.canvas-plane')).transform).a;
      const border=getComputedStyle(el,'::after');
      return {width:parseFloat(border.paddingTop)*scale,green:border.backgroundImage.includes('34, 197, 94')};
    }));
    assert.equal(widths.length,3);
    for(const value of widths) {assert.ok(Math.abs(value.width-4)<0.02);assert.equal(value.green,true);}
  }
  await checkThickness();
  for(let i=0;i<6;i++) {await page.getByRole('button',{name:'缩小',exact:true}).click();await checkThickness();}
  for(let i=0;i<12;i++) {await page.getByRole('button',{name:'放大',exact:true}).click();await checkThickness();}
  for(let i=0;i<6;i++) await page.getByRole('button',{name:'缩小',exact:true}).click();
  assert.equal(first.animation,'canvas-running-border'); assert.equal(first.pointer,'none'); assert.ok(first.mask.split(', ').every(value=>value==='exclude'));
  await page.waitForFunction(angle=>getComputedStyle(document.querySelector('[data-workflow-card="work"]'),'::after').getPropertyValue('--canvas-running-angle')!==angle,first.angle);
  await workflow.locator('header strong').click();
  assert.ok((await workflow.getAttribute('class')).includes('is-selected'));
  await mkdir('.tmp/workflow',{recursive:true});
  await page.screenshot({path:'.tmp/workflow/running-border-light.png'});
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  await page.screenshot({path:'.tmp/workflow/running-border-dark.png'});
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal((await border()).animation,'none');
  await page.emulateMedia({reducedMotion:'no-preference'});
  for(const [status,step] of [['running','waiting'],['waiting','running'],['stopped','running'],['failed','failed'],['done','done']]) {
    await workflowState(status,step);
    assert.equal(await workflow.getAttribute('aria-busy'),'false');
    assert.equal((await border()).animation,'none');
  }
  await page.evaluate(async()=>{
    const {api}=await import('/src/lib/api.ts');
    for(const node of window.snapshot().nodes) {const p=JSON.parse(node.payloadJson);p.status=node.kind==='prompt'?'success':'awaiting_approval';await api.projectCanvasNodeUpdate(node.id,{payloadJson:JSON.stringify(p)});}
    window.emitChange();
  });
  await page.waitForFunction(()=>!document.querySelector('.canvas-card-running'));
  assert.deepEqual(errors,[]);
  console.log('PASS running session/Agent/workflow border, active-step gating, terminal/waiting cleanup, real animation, selection and reduced motion.');
} finally { await browser.close(); await server.close(); }
