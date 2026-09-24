import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server=await createServer({configFile:false,root:process.cwd(),server:{host:'127.0.0.1',port:1604,strictPort:true,hmr:false,watch:null}});
await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1700,height:1100}});
page.setDefaultTimeout(10000);
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const workflow=()=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('workflow-p'))?.document);
async function drag(kind) {
  const card=page.locator(`.workflow-card.is-${kind}`), header=card.locator('header strong');
  const before=(await workflow()).nodes.find(node=>node.kind===kind);
  const box=await header.boundingBox();
  const x=box.x+Math.min(20,box.width/2),y=box.y+box.height/2;
  await page.mouse.move(x,y);await page.mouse.down();
  await page.mouse.move(x+150,y+90,{steps:10});await page.mouse.up();
  await page.waitForFunction(({kind,x})=>JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(node=>node.kind===kind).x>x+20,{kind,x:before.x});
}
try {
  await page.goto('http://127.0.0.1:1604/scripts/fixtures/canvas-reference/preview.html?provisional&strict-canvas');
  await page.waitForFunction(async()=>{const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');return canvasWorkflowController('p').ready;});
  assert.equal(await page.locator('.workflow-save-error').count(),0);
  assert.equal(await page.evaluate(()=>window.earlyCanvasReads??0),0);
  assert.equal(await page.evaluate(()=>window.calls.some(call=>call.command==='project_canvas_materialize')),false,'untouched canvas remains provisional');
  const stage=page.locator('[data-canvas-stage]');
  const expected=await stage.evaluate(element=>{const rect=element.getBoundingClientRect();const matrix=new DOMMatrix(getComputedStyle(document.querySelector('.canvas-plane')).transform);return {x:(600-matrix.e)/matrix.a,y:(200-matrix.f)/matrix.d};});
  await page.getByRole('button',{name:'新增工作流助手',exact:true}).dragTo(stage,{targetPosition:{x:600,y:200}});
  await page.locator('.workflow-card.is-planner').waitFor();
  assert.equal((await workflow()).nodes.length,1,'drag creates exactly one card');
  assert.ok(Math.abs((await workflow()).nodes[0].x-expected.x)<2&&Math.abs((await workflow()).nodes[0].y-expected.y)<2,'drop position is converted to canvas coordinates');
  const commands=await page.evaluate(()=>window.calls.map(call=>call.command));
  assert.ok(commands.indexOf('project_canvas_materialize')<commands.indexOf('canvas_workflow_save'));
  await drag('planner');
  await page.getByRole('button',{name:'新增 Agent 卡片',exact:true}).dragTo(stage,{targetPosition:{x:350,y:300}});
  await page.locator('.workflow-card.is-agent').waitFor();
  await page.locator('.workflow-card.is-agent').getByRole('textbox',{name:'文本修改要求'}).fill('改写提示词');
  await drag('agent');
  await page.getByRole('button',{name:'新增生成卡片',exact:true}).click();
  await page.locator('.workflow-card.is-generation').waitFor();await drag('generation');
  const saved=await workflow();await page.evaluate(()=>{window.save();const snapshot=JSON.parse(sessionStorage.getItem('reference-fixture'));snapshot.nodes=snapshot.nodes.filter(node=>node.id!=='far');sessionStorage.setItem('reference-fixture',JSON.stringify(snapshot));});await page.reload();
  await page.locator('.workflow-card.is-planner').waitFor();
  assert.equal(await page.evaluate(()=>window.earlyCanvasReads??0),0,'persisted loading waits for canvas ensure');
  assert.equal(await page.locator('.workflow-save-error').count(),0);
  assert.deepEqual((await workflow()).nodes.map(({id,x,y})=>({id,x,y})),saved.nodes.map(({id,x,y})=>({id,x,y})));
  await page.getByRole('button',{name:'适应内容',exact:true}).click();await drag('agent');await drag('planner');
  assert.deepEqual(errors,[]);
  console.log('workflow initialization: provisional no reads/writes, materialize-before-save, existing canvas ensure, planner/Agent/generation dragging and reload passed');
} catch(error) {console.log(await page.evaluate(()=>({text:document.body.innerText.slice(-1500),calls:window.calls?.slice(-8),errors:window.earlyCanvasReads})));throw error;} finally {await browser.close();await server.close();}
