import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({configFile:false,root:process.cwd(),server:{host:'127.0.0.1',port:1598,strictPort:true,hmr:false,watch:null}});
await server.listen();
const browser = await chromium.launch({channel:'chrome',headless:true});
const page = await browser.newPage({viewport:{width:1500,height:1000},permissions:['clipboard-read','clipboard-write']});
try {
  await page.goto('http://127.0.0.1:1598/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async()=>{
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const {newWorkflowNode}=await import('/src/lib/canvasWorkflow.ts');
    const c=canvasWorkflowController('p');await c.load();
    const trigger={...newWorkflowNode('trigger',0,0,''),id:'switch'};
    const bad={...newWorkflowNode('instruction',5000,5000,''),id:'bad-instruction',inputs:{signal:[{nodeId:'switch',portId:'signal'}]}};
    await c.edit([trigger,bad]);
    try{await c.start(trigger.id);}catch{}
    if(c.issue?.nodeId!==bad.id||c.issue.phase!=='validation')throw Error('preflight must locate the bad card, not the switch');
  });
  const panel=page.getByRole('alert',{name:'工作流问题',exact:true});await panel.waitFor();
  assert.match(await panel.innerText(),/工作流未启动/);
  await panel.getByRole('button',{name:'定位出错卡片'}).click();
  const card=page.locator('[data-workflow-card="bad-instruction"]');
  await page.waitForFunction(()=>document.querySelector('[data-workflow-card="bad-instruction"]')?.classList.contains('is-selected'));
  const box=await card.boundingBox();assert.ok(box.x>=0&&box.x<1500&&box.y>=0&&box.y<1000);
  await page.getByRole('button',{name:'关闭工作流问题'}).click();assert.equal(await panel.count(),0);
  await page.evaluate(async()=>{
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const {newWorkflowNode}=await import('/src/lib/canvasWorkflow.ts');
    const c=canvasWorkflowController('p'),input={canvasNodeId:'missing-container',cellId:'*'};
    const gen={...newWorkflowNode('generation',5000,5000,''),id:'broken-generation',prompt:'private prompt @[ref]',inputs:{image:[input]},promptReferences:[{id:'ref',type:'image',input,label:'图片来源 1'}]};
    await c.edit([gen]);await c.start(gen.id,true);
    if(c.issue?.code!=='INPUT_UNAVAILABLE'||c.issue.referenceLabel!=='图片来源 1'||c.issue.step!==1||c.document.run.status!=='failed')throw Error('input failure must carry reference, card and step');
    if(c.error)throw Error('execution error must not appear as save failure');
    window.save();
  });
  await panel.waitFor();assert.match(await panel.innerText(),/第 1 步/);assert.match(await panel.innerText(),/@图片来源 1/);
  assert.equal(await page.getByRole('button',{name:'重试保存'}).count(),0);
  await panel.getByRole('button',{name:'复制诊断信息'}).click();
  const report=await page.evaluate(()=>navigator.clipboard.readText());
  assert.equal(JSON.parse(report).nodeId,'broken-generation');assert.ok(!report.includes('private prompt'));
  await page.reload();await panel.waitFor();assert.match(await panel.innerText(),/@图片来源 1/);
  await page.getByRole('button',{name:'关闭工作流问题'}).click();
  await page.locator('[data-workflow-card="broken-generation"]').getByRole('button',{name:'查看问题'}).click();await panel.waitFor();
  await page.screenshot({path:'.tmp/workflow/diagnostics.png'});
  await page.evaluate(async()=>{
    const {api}=await import('/src/lib/api.ts');const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const c=canvasWorkflowController('p'),base=window.snapshot().nodes[0];
    await api.projectCanvasNodeCreate({...base,id:'empty-source',kind:'note',role:null,assetId:null,x:300,y:200,payloadJson:JSON.stringify({schema_version:1,note_type:'text',title:'素材输入',text:'',member_ids:[],cells:[[{id:'empty-cell',content_type:'image',text:'',image_refs:[]}]]})});
    window.emitChange();
    const input={canvasNodeId:'empty-source',cellId:'empty-cell'};
    await c.edit(c.document.nodes.map(node=>({...node,inputs:{image:[input]},promptReferences:[{id:'ref',type:'image',input,label:'图片来源 1'}]})));
    await c.start('broken-generation',true);
  });
  await panel.getByText('来源：素材输入 · 第 1 行，第 1 列',{exact:true}).waitFor();
  assert.ok(await page.locator('[data-workflow-card="broken-generation"]').evaluate(node=>node.classList.contains('canvas-card-error')));
  const border=await page.locator('[data-workflow-card="broken-generation"]').evaluate(node=>{const style=getComputedStyle(node,'::after');return {padding:style.paddingTop,background:style.backgroundColor,pointer:style.pointerEvents};});
  assert.equal(border.background,'rgb(239, 68, 68)');assert.equal(border.pointer,'none');
  const runningWidth=await page.locator('[data-workflow-card="broken-generation"]').evaluate(node=>getComputedStyle(node).getPropertyValue('--canvas-running-width'));
  assert.ok(Math.abs(parseFloat(border.padding)-parseFloat(runningWidth||'4'))<0.01);
  const wire=page.locator('path[data-workflow-target="broken-generation"].is-error');
  assert.equal(await wire.count(),1);assert.equal(await wire.evaluate(node=>getComputedStyle(node).stroke),'rgb(239, 68, 68)');
  await panel.getByRole('button',{name:'定位来源'}).click();
  await page.waitForFunction(()=>document.querySelector('[data-canvas-node-id="empty-source"]')?.classList.contains('is-selected'));
  await page.evaluate(async()=>{
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');const c=canvasWorkflowController('p');
    const run=c.document.run,step=run.steps['broken-generation'];
    const waiting={...run,status:'waiting',steps:{...run.steps,'broken-generation':{...step,status:'waiting',diagnostic:undefined,error:'上游任务仍在处理，请等待结果'}}};
    c.dismissIssue();await c.save({...c.document,run:waiting,runs:[waiting]});
  });
  assert.equal(await panel.count(),0);
  assert.equal(await page.locator('.canvas-card-error').count(),0);
  assert.equal(await page.locator('.workflow-wires path.is-error').count(),0);
  await page.locator('.workflow-waiting[role="status"]').getByText('上游任务仍在处理，请等待结果',{exact:true}).waitFor();
  console.log('workflow diagnostics: preflight attribution, persistent panel, locate/select, execution reference context, copy without prompt, save/error separation, reload and reopen passed');
} finally {await browser.close();await server.close();}
