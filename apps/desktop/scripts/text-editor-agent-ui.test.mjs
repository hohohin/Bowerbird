import assert from 'node:assert/strict';
import {readDocumentState} from '../src/lib/documentState.ts';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium} from '../../html-renderer/node_modules/playwright/index.mjs';
const server=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),cacheDir:'.tmp/text-editor-agent-vite',server:{host:'127.0.0.1',port:0,strictPort:false,hmr:false,watch:null}});await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(15000);
const coverage=[];let collecting=false;
async function collect(){if(collecting)coverage.push(...(await page.coverage.stopJSCoverage()).filter(e=>e.url.includes('/src/')));collecting=false;}
async function beginCoverage(){await collect();if(process.env.BOWERBIRD_DEMO_COVERAGE){await page.coverage.startJSCoverage();collecting=true;}}
const errors=[];page.on('pageerror',e=>errors.push(e.stack));const editor=page.getByRole('textbox',{name:'文档正文',exact:true}),toolbar=page.getByRole('toolbar',{name:'文字格式',exact:true});
async function fresh(){await beginCoverage();await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/text-workspace-live/preview.html?markdown&agent`,{timeout:60000});await editor.locator('[data-slate-node=element]').first().click();}
async function ask(text){await toolbar.getByRole('button',{name:'Agent 指令',exact:true}).click();await page.getByPlaceholder('让 Agent 帮你写作…').fill(text);await page.keyboard.press('Enter');}
try{
await fresh();await ask('帮我写一段雨景');await page.waitForFunction(()=>window.draft?.markdown.includes('雨落在空荡的街道'));
await page.getByRole('option',{name:'接受',exact:true}).click();assert.match(await editor.innerText(),/雨落在空荡的街道/);
const request=await page.evaluate(()=>window.calls.find(c=>c.command==='agent_ds_workflow_start'));assert.ok(request);assert.doesNotMatch(JSON.stringify(request),/bowerbird-document/);console.log('PASS full editor Agent generation and acceptance');

await fresh();await page.keyboard.type('Original paragraph');await page.keyboard.press('Home');await page.keyboard.press('Shift+End');await ask('改写成雨景');await page.getByText('雨落在空荡的街道。',{exact:true}).waitFor();await page.getByRole('option',{name:'接受',exact:true}).click();assert.match(await editor.innerText(),/雨落在空荡的街道/);assert.doesNotMatch(await editor.innerText(),/Original paragraph/);console.log('PASS selection Agent rewrite and acceptance');

await fresh();await page.evaluate(()=>{window.agentReadError=true;});await ask('帮我继续写');await page.getByRole('button',{name:'取回原请求',exact:true}).click({trial:true});await page.evaluate(()=>{window.agentReadError=false;});await page.getByRole('button',{name:'取回原请求',exact:true}).click();await page.waitForFunction(()=>window.draft?.markdown.includes('雨落在空荡的街道'));assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='agent_ds_workflow_start').length),1);console.log('PASS editor Agent original-request recovery');
await fresh();await page.keyboard.type('Original paragraph');await page.keyboard.press('Home');await page.keyboard.press('Shift+End');await toolbar.getByRole('button',{name:'Agent 指令',exact:true}).click();await page.getByRole('option',{name:'润色',exact:true}).click();await page.getByRole('option',{name:'接受',exact:true}).waitFor();await page.getByRole('option',{name:'接受',exact:true}).click();assert.match(await editor.innerText(),/雨落在空荡的街道/);assert.doesNotMatch(await editor.innerText(),/Original paragraph/);console.log('PASS preset rewrite applies tracked suggestions');
for(const accept of [false,true]){
await fresh();await page.keyboard.type('Comment target');await page.keyboard.press('Home');await page.keyboard.press('Shift+End');await toolbar.getByRole('button',{name:'Agent 指令',exact:true}).click();await page.getByRole('option',{name:'评论',exact:true}).click();await page.getByRole('button',{name:accept?'接受':'拒绝',exact:true}).click();const stored=readDocumentState(await page.evaluate(()=>window.draft.markdown));assert.equal(stored.value?.discussions?.length??0,accept?1:0);console.log('PASS Agent comment',accept?'accept':'reject');
}

for(const valid of [true,false]){
 await fresh();await page.keyboard.type('/');await page.getByRole('option',{name:'表格',exact:true}).click();const cells=editor.locator('[data-table-cell-id]');
 await cells.nth(0).click();await page.keyboard.type('Original cell');
 const a=await cells.nth(0).boundingBox(),b=await cells.nth(3).boundingBox();await page.mouse.move(a.x+15,a.y+15);await page.mouse.down();await page.mouse.move(b.x+20,b.y+20,{steps:10});await page.mouse.up();
 await page.evaluate(valid=>window.agentText=valid?'| New A | New B |\n| --- | --- |\n| New C | New D |':'Invalid plain text',valid);
 await toolbar.getByRole('button',{name:'Agent 指令',exact:true}).click();await page.getByRole('option',{name:'润色',exact:true}).click();
 if(valid){await page.getByRole('option',{name:'接受',exact:true}).click();assert.match(await editor.innerText(),/New A/);assert.doesNotMatch(await editor.innerText(),/Original cell/);}
 else{await page.getByText('Agent 返回的表格与所选区域不匹配，未修改原表格。',{exact:true}).waitFor();assert.match(await editor.innerText(),/Original cell/);}
 console.log('PASS table Agent',valid?'rewrite':'mismatch preservation');
}
await fresh();await toolbar.getByRole('button',{name:'Agent 指令',exact:true}).click();await page.getByRole('button',{name:/选择Agent模型/}).click();await page.getByRole('button',{name:'Cloud DSH',exact:true}).click();await page.getByPlaceholder('让 Agent 帮你写作…').fill('Cloud text');await page.keyboard.press('Enter');await page.getByRole('option',{name:'接受',exact:true}).click();assert.match(await editor.innerText(),/雨落在空荡的街道/);assert.equal(await page.evaluate(()=>window.calls.find(c=>c.command==='cloud_agent_start').args.agentRuntime),'dsh');console.log('PASS full editor Cloud DSH generation');

await fresh();await page.keyboard.type('Original');await page.keyboard.press('Home');await page.keyboard.press('Shift+End');await page.evaluate(()=>window.agentHold=true);await ask('Rewrite');await page.waitForFunction(()=>window.calls.some(c=>c.command==='agent_ds_workflow_result'));await editor.locator('[data-slate-string]').first().click();await page.keyboard.press('End');await page.keyboard.type(' manual edit');await page.evaluate(()=>window.agentHold=false);await page.getByRole('option',{name:'接受',exact:true}).waitFor();assert.equal(readDocumentState(await page.evaluate(()=>window.draft.markdown)).source.trim(),'Original manual edit');assert.ok((await page.getByPlaceholder('让 Agent 帮你写作…').boundingBox()).width>=300);console.log('PASS concurrent edit retains manual text and shows a readable preview');
await fresh();await page.evaluate(()=>{window.agentHold=true;window.agentCancelError=true;});await ask('cancel test');await page.waitForFunction(()=>window.calls.some(c=>c.command==='agent_ds_workflow_result'));await page.keyboard.press('Escape');await page.getByRole('button',{name:'再次停止',exact:true}).waitFor();await page.evaluate(()=>{window.agentCancelError=false;});await page.getByRole('button',{name:'再次停止',exact:true}).click();await page.getByRole('button',{name:'再次停止',exact:true}).waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='agent_ds_workflow_start').length),1);assert.doesNotMatch(await editor.innerText(),/雨落在空荡的街道/);console.log('PASS failed cancellation retries original request without writing');
assert.deepEqual(errors,[]);
}finally{console.log('PAGE_ERRORS',errors);console.log('AGENT_CALLS',await page.evaluate(()=>window.calls.filter(c=>/agent_ds|cloud_agent/.test(c.command))));console.log('VISIBLE',await page.locator('body').innerText());await mkdir('.tmp/text-editor-agent',{recursive:true});await page.screenshot({path:'.tmp/text-editor-agent/current.png'});if(process.env.BOWERBIRD_DEMO_COVERAGE){await mkdir('.tmp/text-editor-agent',{recursive:true});await writeFile('.tmp/text-editor-agent/coverage.json',JSON.stringify((await collect(),coverage)));}await browser.close();await server.close();}
