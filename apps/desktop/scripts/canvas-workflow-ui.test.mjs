import { placeWorkflowCard, selectCanvasTool } from "./fixtures/canvas-reference/place-card.mjs";
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
console.log('Starting isolated workflow preview');
const server = await createServer({ cacheDir:'.tmp/canvas-workflow-ui-vite', server:{host:'127.0.0.1',port:1579,strictPort:true,hmr:false,watch:null} });
await server.listen();
console.log('Preview listening');
const browser = await chromium.launch({channel:'chrome',headless:true});
const page = await browser.newPage({viewport:{width:1800,height:1200}});
page.setDefaultTimeout(15000);
const errors=[]; page.on('pageerror', e=>errors.push(e.message));
const snapshot = () => page.evaluate(()=>JSON.parse(sessionStorage.getItem('workflow-p'))?.document);
async function chooseOption(card, name, option) {
  await card.getByRole('combobox', { name, exact: true }).click();
  await page.getByRole('listbox', { name, exact: true }).getByRole('option', { name: option, exact: true }).click();
}
const outputHandle = card => card.getByRole('button', { name: '添加下游', exact: true });
async function connectOutput(output, target) {
  const from = await output.boundingBox();
  const to = await target.boundingBox();
  assert.ok(from && to, 'source handle and destination card are displayed');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + Math.min(75, to.height / 2), { steps: 12 });
  await page.mouse.up();
}
const promptField = card => card.getByRole('textbox', { name: '卡片指令', exact: true });
try {
  await page.goto('http://127.0.0.1:1579/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  // The shared fixture has a deliberately distant note for reference-placement tests.
  await page.evaluate(()=>{const canvas=window.snapshot();canvas.nodes=canvas.nodes.filter(node=>node.id!=='far');sessionStorage.setItem('reference-fixture',JSON.stringify(canvas));});
  await page.reload(); await page.locator('[data-canvas-node-id="old"]').waitFor();
  console.log('Canvas loaded');
  for (const name of ['新增技能卡片', '新增工作流助手', '工作流模板库']) {
    assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0);
  }
  await placeWorkflowCard(page, '新增指令卡片');
  const instruction=page.locator('.workflow-card.is-instruction'); await instruction.waitFor();
  await chooseOption(instruction, '指令功能', '复用生成提示词');
  await page.getByRole('button',{name:'适应内容',exact:true}).click();
  // Existing image output -> instruction input, using real pointer wiring.
  const materialOutput = outputHandle(page.locator('[data-workflow-material="old"]'));
  await page.mouse.move(5, 5);
  assert.equal(await materialOutput.evaluate(el=>getComputedStyle(el).opacity),'0');
  await page.locator('[data-canvas-node-id="old"]').hover();
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-workflow-material="old"] [data-canvas-connect-side="output"]')).opacity==='1');
  await connectOutput(materialOutput, instruction);
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('workflow-p'))?.document.nodes[0].inputs.image?.length===1);
  await instruction.getByRole('button',{name:'运行此卡片',exact:true}).click();
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('workflow-p'))?.document.run?.status==='done');
  assert.equal((await snapshot()).nodes[0].trigger,false);
  await selectCanvasTool(page, '触发卡');
  await instruction.locator('header strong').click();
  await instruction.getByRole('button',{name:'上发条，运行工作流',exact:true}).click();
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('workflow-p'))?.document.run?.status==='done');
  assert.equal((await snapshot()).nodes[0].outputs.text.text,'保持产品主体，生成清晨场景');
  await placeWorkflowCard(page, '新增生成卡片');
  await page.getByRole('button',{name:'适应内容',exact:true}).click();
  const generation=page.locator('.workflow-card.is-generation'); await generation.waitFor();
  await generation.locator('header').click({button:'right'});
  assert.equal(await page.getByRole('menuitem',{name:'存为模板',exact:true}).count(),0);
  assert.equal(await page.getByRole('menuitem',{name:'导出工作流数据包',exact:true}).count(),1);
  assert.equal(await page.getByRole('menuitem',{name:'导入工作流数据包',exact:true}).count(),1);
  await page.keyboard.press('Escape');
  assert.equal(await generation.getByRole('button',{name:'输出：会话',exact:true}).count(),0);
  assert.equal(await outputHandle(generation).count(),1);
  await promptField(generation).fill('使用柔和自然光');
  // One actual connection carries the instruction's text and image together.
  await connectOutput(outputHandle(instruction), generation);
  await page.waitForFunction(()=>{
    const input=JSON.parse(sessionStorage.getItem('workflow-p'))?.document.nodes[1].inputs;
    return input.image?.length===1 && input.text?.length===1;
  });
  const before=await snapshot();
  assert.equal(before.nodes[1].inputs.text[0].nodeId,before.nodes[0].id);
  assert.ok(before.nodes[1].inputs.text[0].autoConnect);
  assert.equal(before.nodes[1].inputs.image[0].autoConnect,before.nodes[1].inputs.text[0].autoConnect);
  await generation.locator('header').hover();
  await page.getByRole('toolbar',{name:'生成参数',exact:true}).waitFor();
  const bounds=await generation.locator('header strong').boundingBox();
  await page.mouse.move(bounds.x+20,bounds.y+7); await page.mouse.down();
  await page.mouse.move(bounds.x+170,bounds.y-100,{steps:8}); await page.mouse.up();
  await page.waitForFunction(x=>JSON.parse(sessionStorage.getItem('workflow-p'))?.document.nodes[1].x>x,before.nodes[1].x);
  await page.reload(); await page.locator('.workflow-card.is-generation').waitFor();
  assert.equal(await promptField(generation).innerText(),'使用柔和自然光');
  assert.equal((await snapshot()).nodes[1].inputs.text.length,1);
  // Existing skill cards still load after their creation entry is hidden.
  await page.evaluate(async () => {
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const {newWorkflowNode}=await import('/src/lib/canvasWorkflow.ts');
    const controller=canvasWorkflowController('p');
    await controller.edit([...controller.document.nodes,newWorkflowNode('skill',1150,520,'codex')]);
  });
  await page.getByRole('button',{name:'适应内容',exact:true}).click();
  const skillCard = page.locator('.workflow-card.is-skill');
  await chooseOption(skillCard, '选择技能', 'HTML 图文排版');
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.some(n=>n.kind==='skill' && n.skill==='html-layout'));
  assert.equal(await outputHandle(skillCard).count(),1);
  assert.ok(await page.evaluate(async ()=>{
    const {workflowOutputs}=await import('/src/lib/canvasWorkflow.ts');
    const node=JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(n=>n.kind==='skill');
    return workflowOutputs(node).some(port=>port.type==='image' && port.label==='排版截图');
  }));
  await mkdir('.tmp/workflow',{recursive:true}); await page.screenshot({path:'.tmp/workflow/canvas-light.png'});
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  await page.screenshot({path:'.tmp/workflow/canvas-dark.png'});
  // Failed persistence must be visible and prevent execution.
  await page.evaluate(()=>{window.failWorkflowSave=true;});
  await promptField(generation).fill('保存失败的编辑');
  await page.locator('.workflow-save-error').waitFor();
  await page.evaluate(()=>{window.failWorkflowSave=false;});
  await page.getByRole('button',{name:'重试保存',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.workflow-save-error'));
  assert.equal((await snapshot()).nodes[1].prompt,'保存失败的编辑');
  // A scoped content connection follows the same cell when a row is inserted.
  await page.evaluate(()=>{
    const canvas=window.snapshot();const base=canvas.nodes[0];
    canvas.nodes.push({...base,id:'text-source',kind:'note',assetId:null,role:null,x:80,y:100,width:300,height:180,
      payloadJson:JSON.stringify({schema_version:1,note_type:'text',text:'单元格内容',cells:[[{text:'单元格内容',bold:false,italic:false,align:'left'}]],member_ids:[]})});
    const saved=JSON.parse(sessionStorage.getItem('workflow-p'));const gen=saved.document.nodes.find(node=>node.kind==='generation');
    const instruction=saved.document.nodes.find(node=>node.kind==='instruction');instruction.x=80;instruction.y=550;
    gen.x=460;gen.y=100;gen.sessionNodeIds=['workflow-session'];
    saved.document.cardNames={...saved.document.cardNames,[gen.id]:'单元格接收器'};
    canvas.nodes.push({...base,id:'workflow-session',kind:'prompt',assetId:null,role:null,x:880,y:100,width:260,height:148,positionLocked:true,
      payloadJson:JSON.stringify({schema_version:1,text:'工作流生成',status:'running',provider:'codex'})});
    canvas.view={...canvas.view,panX:50,panY:60,zoom:0.8};
    sessionStorage.setItem('workflow-p',JSON.stringify(saved));sessionStorage.setItem('reference-fixture',JSON.stringify(canvas));
  });
  await page.reload();
  const source = page.locator('[data-canvas-node-id="text-source"]');
  const sourceOutput = outputHandle(source);
  await sourceOutput.press('Enter');
  const sourceMenu = page.getByRole('menu', { name: '添加下游', exact: true });
  await sourceMenu.getByRole('menuitem', { name: '指定内容', exact: true }).click();
  await page.getByRole('menu', { name: '指定内容', exact: true }).getByRole('menuitem', { name: '第 1 行，第 1 列', exact: true }).click();
  await sourceMenu.getByRole('menuitem', { name: '连接已有卡片', exact: true }).click();
  await page.getByRole('menu', { name: '连接已有卡片', exact: true }).getByRole('menuitem', { name: '单元格接收器', exact: true }).click();
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(n=>n.kind==='generation').inputs.text.some(i=>i.canvasNodeId==='text-source'));
  const binding=(await snapshot()).nodes.find(n=>n.kind==='generation').inputs.text.find(i=>i.canvasNodeId==='text-source');
  await page.getByLabel('第 1 行第 1 列',{exact:true}).click();
  await page.getByRole('button',{name:'在第 1 行位置插入',exact:true}).click();
  await page.waitForFunction(()=>JSON.parse(window.snapshot().nodes.find(n=>n.id==='text-source').payloadJson).cells.length===2);
  const cells=await page.evaluate(()=>JSON.parse(window.snapshot().nodes.find(n=>n.id==='text-source').payloadJson).cells);
  assert.equal(cells[1][0].id,binding.cellId);assert.equal(cells[1][0].text,'单元格内容');
  // An uncontained generation session keeps its own canvas card and wire.
  await page.locator('[data-canvas-node-id="workflow-session"]').waitFor();
  assert.equal(await page.locator('[data-workflow-session-link="workflow-session"]').count(),1);
  await generation.getByRole('button',{name:'生成历史',exact:true}).click();
  await page.locator('[data-workflow-history-session="workflow-session"]').waitFor();
  await page.keyboard.press('Escape');
  // Multi-image description creates a real table and refreshes the canvas without a reload.
  const resultTable = await page.evaluate(async()=>{
    const {api}=await import('/src/lib/api.ts');
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const {newWorkflowNode}=await import('/src/lib/canvasWorkflow.ts');
    const {useStore}=await import('/src/store.ts');
    api.describeAsset=async id=>'analysis-'+id;
    api.listAnalysesByAsset=async id=>[{id:'analysis-'+id,payload:JSON.stringify({sections:[{title:'提示词',body:'素材 '+id+' 的独立提示词'}]})}];
    useStore.setState({defaultUnderstandProvider:'bowerbird-cloud',cloudAuth:{logged_in:true,cloud_available:true,user_id:'test'}});
    const controller=canvasWorkflowController('p');
    await controller.edit([{...newWorkflowNode('instruction',100,100,'codex'),id:'batch',action:'describe',inputs:{image:[{assetId:'a'},{assetId:'b'}]}}]);
    await controller.start('batch');
    if(controller.document.run.status!=='done')throw new Error(JSON.stringify(controller.document.run));
    return controller.document.nodes[0].resultNodeIds[0];
  });
  const resultCard=page.locator(`[data-canvas-node-id="${resultTable}"]`);
  await resultCard.waitFor();
  assert.equal(await resultCard.locator('.canvas-text-cell').count(),6);
  assert.equal(await resultCard.getByLabel('第 1 行第 1 列',{exact:true}).inputValue(),'素材');
  assert.match(await resultCard.getByLabel('第 2 行第 2 列',{exact:true}).inputValue(),/素材 a 的独立提示词/);
  assert.match(await resultCard.getByLabel('第 3 行第 2 列',{exact:true}).inputValue(),/素材 b 的独立提示词/);
  assert.equal(await page.locator(`[data-workflow-result-link="${resultTable}"]`).count(),1);
  await page.getByRole('button',{name:'适应内容',exact:true}).click();
  await page.screenshot({path:'.tmp/workflow/batch-description.png'});
  const textBefore=await resultCard.getByLabel('第 2 行第 2 列',{exact:true}).inputValue();
  await resultCard.hover();
  await resultCard.getByRole('button',{name:'添加上游',exact:true}).click({button:'right'});
  await page.getByRole('menu', { name: '选择要断开的连线' }).getByRole('menuitem').click();
  await page.waitForFunction(id=>!document.querySelector(`[data-workflow-result-link="${id}"]`),resultTable);
  assert.equal(await resultCard.getByLabel('第 2 行第 2 列',{exact:true}).inputValue(),textBefore);
  await page.evaluate(()=>window.save());
  await page.reload();await resultCard.waitFor();
  assert.equal(await page.locator(`[data-workflow-result-link="${resultTable}"]`).count(),0);
  assert.equal((await snapshot()).nodes[0].resultNodeIds.length,0);
  await page.evaluate(async oldTable=>{
    const {api}=await import('/src/lib/api.ts');
    const {useStore}=await import('/src/store.ts');
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    api.describeAsset=async id=>'new-'+id;
    api.listAnalysesByAsset=async id=>[{id:'new-'+id,payload:JSON.stringify({sections:[{title:'提示词',body:'重跑的新内容'}]})}];
    useStore.setState({defaultUnderstandProvider:'bowerbird-cloud'});
    const controller=canvasWorkflowController('p');await controller.start('batch');
    if(controller.document.run.status!=='done'||controller.document.nodes[0].resultNodeIds.includes(oldTable))throw new Error('detached text must not reconnect on rerun');
  },resultTable);
  assert.equal(await resultCard.getByLabel('第 2 行第 2 列',{exact:true}).inputValue(),textBefore);
  // Run two independent cards through real buttons; a third remains editable.
  await page.evaluate(async()=>{
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const {newWorkflowNode}=await import('/src/lib/canvasWorkflow.ts');
    const {useStore}=await import('/src/store.ts');
    const controller=canvasWorkflowController('p');
    const {api}=await import('/src/lib/api.ts');
    api.visualProfileGet=async()=>({id:'shared-profile',status:'confirmed',version:1});
    await controller.edit([{...newWorkflowNode('visual-profile',100,560,'codex'),id:'shared',profileId:'shared-profile',outputs:{'visual-profile':{type:'visual-profile',profileId:'shared-profile',version:1}}},
      ...['left','right','editable'].map((id,i)=>({...newWorkflowNode('generation',100+i*390,100,'codex'),id,prompt:id,trigger:id==='left',inputs:id==='left'?{'visual-profile':[{nodeId:'shared',portId:'visual-profile'}]}:{}}))]);
    window.workflowReleases=[];
    useStore.setState({
      codexHealth:{ok:true,reason:''},
      cloudEntitlement:{policy:{can_use_byo:true,max_parallel_jobs:3},balances:{daily:0,sub:0,topup:0}},
      startGeneration:async()=>{await new Promise(resolve=>window.workflowReleases.push(resolve));return {accepted:false,error:'stopped'};},
    });
  });
  await page.getByRole('button',{name:'适应内容',exact:true}).click();
  const left=page.locator('[data-workflow-card="left"]'),right=page.locator('[data-workflow-card="right"]'),editable=page.locator('[data-workflow-card="editable"]');
  await left.getByRole('button',{name:'运行此卡片',exact:true}).click();
  await page.waitForFunction(()=>window.workflowReleases.length===1);
  // Adding another reader must stay possible while the source is in use.
  const shared=page.locator('[data-workflow-card="shared"]');
  const active = await snapshot();
  await connectOutput(outputHandle(shared), right);
  const connection = await Promise.race([
    page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(n=>n.id==='right').inputs['visual-profile']?.length===1).then(()=> 'connected'),
    page.getByText('来源卡片正在使用',{exact:true}).first().waitFor().then(()=> 'rejected as a locked source'),
  ]);
  assert.equal(connection,'connected','adding a reader leaves the locked source unchanged');
  const connected = await snapshot();
  for (const id of ['shared','left']) {
    assert.deepEqual(connected.nodes.find(n=>n.id===id),active.nodes.find(n=>n.id===id));
  }
  await left.getByRole('button',{name:'添加上游',exact:true}).click({button:'right'});
  const lockedWire = page.getByRole('menu',{name:'选择要断开的连线',exact:true}).getByRole('menuitem');
  await lockedWire.waitFor();
  assert.equal(await lockedWire.isDisabled(),true,'an existing input of the running consumer cannot be disconnected');
  await page.keyboard.press('Escape');
  await connectOutput(outputHandle(editable),left);
  await page.getByText('这张卡片正在运行',{exact:true}).first().waitFor();
  assert.deepEqual((await snapshot()).nodes.find(n=>n.id==='left'),active.nodes.find(n=>n.id==='left'),
    'the new-reader path cannot add inputs to a running consumer');
  await right.getByRole('button',{name:'运行此卡片',exact:true}).click();
  await page.waitForFunction(()=>window.workflowReleases.length===2);
  await left.getByRole('button',{name:'上发条，运行工作流',exact:true}).hover();
  await page.getByRole('tooltip').waitFor();
  assert.match(await page.getByRole('tooltip').innerText(),/工作流运行中.*0\/1/);
  assert.match(await page.getByRole('tooltip').innerText(),/生成图片，等待会话结果/);
  assert.equal(await left.locator('.workflow-key svg').evaluate(el=>getComputedStyle(el).animationName),'workflow-wind');
  assert.equal(await promptField(left).getAttribute('contenteditable'),'false');
  assert.equal(await shared.getByRole('combobox',{name:'视觉规范来源',exact:true}).isDisabled(),true);
  assert.equal(await promptField(right).getAttribute('contenteditable'),'false');
  await promptField(editable).fill('并发时仍可编辑');
  await placeWorkflowCard(page, '新增指令卡片');
  await page.locator('.workflow-card.is-instruction').waitFor();
  assert.equal((await snapshot()).runs.filter(r=>r.status==='running').length,2);
  await page.getByRole('button',{name:'适应内容',exact:true}).click();
  await right.getByRole('button',{name:'停止工作流',exact:true}).click();
  await page.evaluate(()=>window.workflowReleases[1]());
  await page.waitForFunction(()=>document.querySelector('[data-workflow-card="right"] [contenteditable]')?.getAttribute('contenteditable')==='true');
  assert.equal(await promptField(left).getAttribute('contenteditable'),'false');
  await left.getByRole('button',{name:'停止工作流',exact:true}).click();
  await page.evaluate(()=>window.workflowReleases.forEach(resolve=>resolve()));
  await page.waitForFunction(()=>document.querySelector('[data-workflow-card="left"] [contenteditable]')?.getAttribute('contenteditable')==='true');
  assert.equal(await shared.getByRole('combobox',{name:'视觉规范来源',exact:true}).isDisabled(),false);
  assert.deepEqual(errors,[]);
  console.log('workflow UI: creation, asset/text/image wiring, key, reuse execution, drag, reload, skill ports, failed-save retry passed');
} finally { await browser.close(); await server.close(); }
