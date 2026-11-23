import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium} from '../../html-renderer/node_modules/playwright/index.mjs';
const server=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),cacheDir:'.tmp/text-editor-chrome-vite',plugins:process.env.BOWERBIRD_CHROME_MUTATION?[{name:'isolated-chrome-mutation',enforce:'pre',load(id){if(id.replaceAll('\\','/').endsWith('/'+process.env.BOWERBIRD_CHROME_MUTATION_FILE))return readFile(process.env.BOWERBIRD_CHROME_MUTATION,'utf8');}}]:[],server:{host:'127.0.0.1',port:0,strictPort:false,hmr:false,watch:null}});await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(8000);
const failures=[],errors=[],coverage=[];let collecting=false;page.on('pageerror',e=>errors.push(e.message));
const editor=page.getByRole('textbox',{name:'文档正文',exact:true}),toolbar=page.getByRole('toolbar',{name:'文字格式',exact:true}),bubble=page.getByRole('dialog',{name:'段落 Agent',exact:true});
async function collect(){if(collecting)coverage.push(...await page.coverage.stopJSCoverage());collecting=false;}
async function fresh(){await collect();if(process.env.BOWERBIRD_CHROME_COVERAGE){await page.coverage.startJSCoverage();collecting=true;}await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/text-workspace-live/preview.html?markdown&agent`,{timeout:60000});await editor.locator('[data-slate-node=element]').first().click();await page.keyboard.type('Menu background and editing target');}
async function check(name,fn){if(process.env.BOWERBIRD_CHROME_FILTER&&!name.includes(process.env.BOWERBIRD_CHROME_FILTER))return;try{await fresh();await fn();console.log('PASS',name);}catch(e){failures.push(name+': '+e.message);console.log('FAIL',name,e.message);await mkdir('.tmp/text-editor-chrome',{recursive:true});await page.screenshot({path:`.tmp/text-editor-chrome/failure-${failures.length}.png`});}}
async function opaque(locator){await locator.waitFor();const color=await locator.evaluate(el=>getComputedStyle(el).backgroundColor);assert.match(color,/^rgb\(/,color);}
try{
await check('document import entries are removed',async()=>assert.equal(await toolbar.locator('[aria-label="导入"]').count(),0));
await check('menus are opaque and low-frequency tools live with the selection', async () => {
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    for (const name of ['正文或标题', '导出', '列表', '插入素材']) {
      await toolbar.getByRole('button', { name, exact: true }).click();
      await opaque(page.getByRole('menu').last());
      await page.keyboard.press('Escape');
    }
    await editor.locator('[data-slate-string]').first().click();
    await page.keyboard.press('Home'); await page.keyboard.press('Shift+End');
    const selection = page.getByRole('toolbar', { name: '选中文字格式' });
    await selection.getByRole('button', { name: '更多选区工具' }).click();
    const tools = page.getByRole('dialog', { name: '更多选区工具' });
    await opaque(tools);
    for (const name of ['字色', '底色', '评论', '修订']) assert.equal(await tools.getByRole('button', { name, exact: true }).count(), 1);
    await page.keyboard.press('Escape'); await tools.waitFor({ state: 'hidden' });
  }
});
await check('compact toolbar gives every primary action space without horizontal scrolling', async () => {
  const names = ['撤销', '重做', '正文或标题', '加粗', '斜体', '列表', '插入素材', 'Agent 指令', '导出'];
  for (const width of [1440, 1100, 900, 510, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await toolbar.getByRole('button').count(), names.length);
    for (const name of names) await toolbar.getByRole('button', { name, exact: true }).waitFor();
    assert.equal(await toolbar.evaluate(node => node.scrollWidth <= node.clientWidth), true);
  }
  await toolbar.getByRole('button', { name: '插入素材', exact: true }).click();
  const draft = await editor.innerText();
  await page.getByRole('menuitem', { name: '插入其他块…', exact: true }).click();
  await page.getByRole('combobox', { name: '搜索块' }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('combobox', { name: '搜索块' }).waitFor({ state: 'hidden' });
  assert.equal(await editor.innerText(), draft);
});
await check('segment Agent dismisses outside but keeps model selection inside',async()=>{await page.setViewportSize({width:1440,height:1000});await editor.locator('[data-slate-string]').first().click();await page.getByRole('button',{name:'Agent',exact:true}).click();await bubble.getByRole('textbox',{name:'发送给 Agent'}).fill('kept while choosing');await bubble.getByRole('button',{name:/选择Agent模型/}).click();await page.getByRole('button',{name:'Cloud DSH',exact:true}).click();assert.equal(await bubble.getByRole('textbox',{name:'发送给 Agent'}).inputValue(),'kept while choosing');await page.getByRole('textbox',{name:'文档名称'}).click();await bubble.waitFor({state:'hidden'});assert.equal(await page.getByRole('textbox',{name:'文档名称'}).evaluate(e=>e===document.activeElement),true);await editor.locator('[data-slate-string]').first().click();await page.getByRole('button',{name:'Agent',exact:true}).click();await bubble.getByRole('textbox',{name:'发送给 Agent'}).click();await page.locator('.text-workspace-name > svg').click();await bubble.waitFor({state:'hidden'});assert.equal(await editor.evaluate(e=>e.contains(document.activeElement)),false);});
await check('outside dismissal cancels pending Agent and ignores late replies',async()=>{await page.getByRole('button',{name:'Agent',exact:true}).click();await page.evaluate(()=>window.agentHold=true);await bubble.getByRole('textbox',{name:'发送给 Agent'}).fill('pending');await bubble.getByRole('button',{name:'发送',exact:true}).click();await page.waitForFunction(()=>window.calls.some(c=>c.command==='agent_ds_workflow_result'));await editor.locator('[data-slate-string]').first().click();await bubble.waitFor({state:'hidden'});await page.waitForFunction(()=>window.calls.some(c=>c.command==='agent_ds_workflow_cancel'));await page.evaluate(()=>window.agentHold=false);assert.doesNotMatch(await editor.innerText(),/雨落/);});
assert.deepEqual(failures,[]);assert.deepEqual(errors,[]);
}finally{await mkdir('.tmp/text-editor-chrome',{recursive:true});await page.screenshot({path:'.tmp/text-editor-chrome/current.png'});await collect();if(coverage.length)await writeFile('.tmp/text-editor-chrome/coverage.json',JSON.stringify(coverage.filter(e=>e.url.includes('/src/'))));await browser.close();await server.close();}
