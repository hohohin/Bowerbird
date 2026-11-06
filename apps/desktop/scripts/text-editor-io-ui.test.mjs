import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium} from '../../html-renderer/node_modules/playwright/index.mjs';
const server=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),cacheDir:'.tmp/text-editor-io-vite',plugins:process.env.BOWERBIRD_IO_DEBUG?[{name:'probe',enforce:'pre',transform(code,id){if(id.endsWith('/textEditorExport.tsx'))return code.replace('const html = await documentHtml(editor);','console.log("export html");const html = await documentHtml(editor);console.log("export frame");').replace('const doc = frame.contentDocument!;','console.log("frame loaded");const doc = frame.contentDocument!;').replace('await doc.fonts.ready;','await doc.fonts.ready;console.log("fonts ready");').replace("const { default: html2canvas }",'console.log("images ready");const { default: html2canvas }').replace('logging: false','logging: true').replace('return await html2canvas','console.log("html2canvas ready");return await html2canvas');}}]:[],server:{host:'127.0.0.1',port:0,strictPort:false,hmr:false,watch:null}});await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(15000);
const coverage=[];let collecting=false;
async function collect(){if(collecting)coverage.push(...(await page.coverage.stopJSCoverage()).filter(e=>e.url.includes('/src/')));collecting=false;}
async function beginCoverage(){await collect();if(process.env.BOWERBIRD_DEMO_COVERAGE){await page.coverage.startJSCoverage();collecting=true;}}
const errors=[],notices=[];page.on('pageerror',e=>errors.push(e.message));await page.exposeFunction('notice',m=>notices.push(m));await page.addInitScript(()=>window.addEventListener('bowerbird://notify',e=>window.notice(e.detail)));
if(process.env.BOWERBIRD_IO_DEBUG)page.on('console',m=>console.log('CONSOLE',m.text()));
const editor=page.getByRole('textbox',{name:'文档正文',exact:true}),toolbar=page.getByRole('toolbar',{name:'文字格式',exact:true});
async function fresh(){await beginCoverage();await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/text-workspace-live/preview.html?markdown`,{timeout:60000});await editor.locator('[data-slate-node=element]').first().click();}
try{
await fresh();await page.context().grantPermissions(['clipboard-read','clipboard-write']);
await page.evaluate(text=>navigator.clipboard.writeText(text),'# 文档标题\n\n**粗体**与[链接](https://example.com)\n\n| A | B |\n| --- | --- |\n| one | two |\n\n- [ ] task\n\n```js\nconst answer = 42;\n```\n');await page.keyboard.press('Control+v');
await editor.locator('h1').waitFor();assert.equal(await editor.locator('table').count(),1);assert.match(await editor.innerText(),/answer = 42/);console.log('PASS Markdown paste preserves heading, marks, links, table, task and code');
await mkdir('.tmp/text-editor-io',{recursive:true});
for(const [label,ext,signature] of [['Markdown','md','#'],['HTML','html','<!doctype html>'],['图片','png','PNG'],['PDF','pdf','%PDF'],['Word','docx','PK']]){
await toolbar.locator('[aria-label="导出"]').click();const download=page.waitForEvent('download',{timeout:60000});await page.getByRole('menuitem',{name:`导出 ${label}`,exact:true}).click();const d=await download;const path=`.tmp/text-editor-io/document.${ext}`;await d.saveAs(path);const bytes=await readFile(path);assert.ok(bytes.length>100);assert.ok(bytes.subarray(0,30).toString().includes(signature));console.log('PASS export',label,bytes.length);
if(ext==='html'){const content=bytes.toString();assert.match(content,/文档标题/);assert.doesNotMatch(content,/<script|fonts.googleapis|platejs.org/);}
}
assert.deepEqual(errors,[]);assert.deepEqual(notices.filter(n=>n.tone==='error'),[]);
}finally{console.log('PAGE_ERRORS',errors,'NOTICES',notices);await page.screenshot({path:'.tmp/text-editor-io/current.png'});if(process.env.BOWERBIRD_DEMO_COVERAGE){await mkdir('.tmp/text-editor-io',{recursive:true});await writeFile('.tmp/text-editor-io/coverage.json',JSON.stringify((await collect(),coverage)));}await browser.close();await server.close();}
