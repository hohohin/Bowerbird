import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: '.tmp/workflow-agent-errors-vite', server: { host: '127.0.0.1', port: 1654, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const errors=[];page.on('pageerror',error=>errors.push(error.message));
async function mocks() {
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    window.submissions=0;window.ready=false;
    api.agentDsWorkflowGenerationRequest=async()=>null;
    api.agentDsWorkflowStart=async()=>{window.submissions++;return {autoDelivered:true,path:'synthetic'};};
    api.agentDsWorkflowResult=async requestId=>window.ready?{schemaVersion:1,requestId,text:'文案层：标题。产品层：瓶子。'}:null;
    api.agentDsWorkflowProgress=async requestId=>[{id:'public1',kind:'message',text:`正在检查文字与产品区域 · ${requestId}`,status:'done',at:Date.now()},{id:'tool1',kind:'tool',text:'执行本机命令',status:'running',at:Date.now()}];
    api.agentDsWorkflowCancel=async()=>{window.cancelled=true;};
  });
}
try {
  await page.goto('http://127.0.0.1:1654/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();await mocks();
  await page.evaluate(async()=>{
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const {newWorkflowNode}=await import('/src/lib/canvasWorkflow.ts');
    const c=canvasWorkflowController('p');await c.load();
    await c.edit([{...newWorkflowNode('agent',300,300,''),id:'agent',agentTransport:'codex-cli',prompt:'区分文案与产品图层',inputs:{image:[{assetId:'a'}]}}]);
    window.run=c.start('agent',true);
  });
  await page.waitForFunction(async()=>{const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');return !!canvasWorkflowController('p').document.run?.steps.agent.localDsRequestId;});
  const card=page.locator('article.workflow-card').filter({has:page.getByRole('textbox',{name:'Agent 要求'})});
  await card.locator('header strong').click();
  const detail=page.locator('[data-agent-detail="agent"]');await detail.waitFor();
  await detail.getByText(/正在检查文字与产品区域/).waitFor();
  assert.match(await detail.innerText(),/区分文案与产品图层/);
  assert.equal(await detail.getByRole('button',{name:'查看图片 1'}).count(),1);
  assert.equal(await page.evaluate(()=>window.submissions),1);
  await page.getByRole('button',{name:'关闭项目详情'}).click();
  assert.equal(await detail.count(),0);assert.equal(await page.evaluate(()=>window.cancelled),undefined);
  await card.getByRole('button',{name:'查看 Agent 详情'}).click();await detail.waitFor();
  await page.evaluate(async()=>{window.ready=true;await window.run;window.save();});
  await detail.getByText('文案层：标题。产品层：瓶子。',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.submissions),1);
  await page.getByRole('button',{name:'关闭项目详情'}).click();
  await page.evaluate(async()=>{const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');const c=canvasWorkflowController('p');await c.edit(c.document.nodes.map(n=>({...n,prompt:'新任务要求'})));window.save();});
  await page.reload();await mocks();await page.getByRole('button',{name:'查看 Agent 详情'}).click();
  await detail.getByText('区分文案与产品图层',{exact:true}).waitFor();
  await detail.getByText('文案层：标题。产品层：瓶子。',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.submissions),0);
  await mkdir('.tmp/workflow',{recursive:true});await page.waitForTimeout(300);await page.screenshot({path:'.tmp/workflow/agent-detail.png'});
  await page.getByRole('button',{name:'关闭项目详情'}).click();
  await page.evaluate(async()=>{
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');const c=canvasWorkflowController('p');
    const run=structuredClone(c.document.run);const completed=structuredClone(run.steps.agent);
    completed.agentInput.prompt='第一轮输入';completed.agentOutputs={text:{type:'text',text:'第一轮输出'}};
    run.status='running';run.steps.agent={...completed,status:'running',agentInput:{...completed.agentInput,prompt:'第二轮输入'},agentOutputs:undefined,localDsRequestId:'second-request'};
    run.loop={nodeId:'loop',bodyIds:['agent'],index:1,startIndex:0,items:[{text:'a',assetIds:[]},{text:'b',assetIds:[]}],completed:[{steps:{agent:completed},outputs:{agent:completed.agentOutputs}}]};
    await c.save({...c.document,run,runs:[run]});
  });
  await page.getByRole('button',{name:'查看 Agent 详情'}).click();
  await detail.getByText('第二轮输入',{exact:true}).waitFor();assert.equal(await detail.getByText('第一轮输出',{exact:true}).count(),0);
  await detail.getByRole('combobox',{name:'Agent 执行记录'}).selectOption({label:'运行 1 · 第 1 轮'});
  await detail.getByText('第一轮输入',{exact:true}).waitFor();await detail.getByText('第一轮输出',{exact:true}).waitFor();
  await detail.getByRole('combobox',{name:'Agent 执行记录'}).selectOption('latest');await detail.getByText('第二轮输入',{exact:true}).waitFor();
  await page.evaluate(async()=>{
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');const c=canvasWorkflowController('p');
    const run=structuredClone(c.document.run);run.status='failed';run.steps.agent.status='failed';run.steps.agent.error='模拟工具失败';
    await c.save({...c.document,run,runs:[run]});
  });
  await detail.getByRole('alert').filter({hasText:'模拟工具失败'}).waitFor();
  assert.equal(await detail.getByText('第一轮输出',{exact:true}).count(),0);
  await page.evaluate(async()=>{
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');const c=canvasWorkflowController('p');
    const run=structuredClone(c.document.run);
    window.rawAgentFailure='执行失败：SQLITE_BUSY at C:\\private\\agent.ts:52';
    run.steps.agent.error=window.rawAgentFailure;
    run.steps.agent.detail=window.rawAgentFailure;
    await c.save({...c.document,run,runs:[run]});
  });
  await detail.getByRole('alert').filter({hasText:'资料库正忙，请稍候再试。'}).waitFor();
  assert.doesNotMatch(await detail.innerText(),/SQLITE_BUSY|private|agent\.ts/);
  assert.equal(await page.evaluate(async()=>{const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');return canvasWorkflowController('p').document.run.steps.agent.error;}),await page.evaluate(()=>window.rawAgentFailure));
  await page.keyboard.press('Escape');assert.equal(await detail.count(),0);assert.deepEqual(errors,[]);
  console.log('PASS Agent detail: running click, live public progress, input images, close without cancellation, output, snapshot/reload, no resubmission, loop history and Escape');
} finally {await browser.close();await server.close();}
