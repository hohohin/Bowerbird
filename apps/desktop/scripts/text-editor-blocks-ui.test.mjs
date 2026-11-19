import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
import {readDocumentState} from '../src/lib/documentState.ts';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium} from '../../html-renderer/node_modules/playwright/index.mjs';
const server=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),cacheDir:'.tmp/text-editor-blocks-vite',server:{host:'127.0.0.1',port:0,strictPort:false,hmr:false,watch:null}});await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(12000);
const errors=[],failures=[],remote=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().startsWith(server.resolvedUrls.local[0]))remote.push(r.url());});
const editor=page.getByRole('textbox',{name:'文档正文',exact:true}),toolbar=page.getByRole('toolbar',{name:'文字格式',exact:true});
async function fresh(){await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/text-workspace-live/preview.html?markdown`,{timeout:60000});await editor.locator('[data-slate-node=element]').first().click();}
async function slash(label){await page.keyboard.type('/');await page.getByRole('option',{name:label,exact:true}).click();}
async function reopen(){await page.getByRole('button',{name:'返回',exact:true}).click();await page.getByRole('button',{name:'放大编辑',exact:true}).click();await editor.waitFor();}
async function check(name,fn){try{await fresh();await fn();console.log('PASS',name);}catch(e){failures.push(`${name}: ${e.stack}`);await mkdir('.tmp/text-editor-blocks',{recursive:true});await page.screenshot({path:`.tmp/text-editor-blocks/${failures.length}.png`});console.log('FAIL',name,await page.locator('body').innerText());}}
try{
await check('callout, columns and their text survive reopening',async()=>{
await slash('提示块');await page.keyboard.type('Callout text');await reopen();assert.match(await editor.locator('.slate-callout').innerText(),/Callout text/);
await fresh();await slash('三栏');const columns=editor.locator('.slate-column');assert.equal(await columns.count(),3);await columns.nth(1).locator('[data-slate-node=element]').first().click();await page.keyboard.type('Middle column');await reopen();assert.equal(await columns.count(),3);assert.match(await columns.nth(1).innerText(),/Middle column/);
});
await check('table cells, row insertion, resize and persistence',async()=>{
await slash('表格');const table=editor.locator('table');const rows=await table.locator('tr').count();await table.locator('[data-table-cell-id]').first().click();await page.keyboard.type('Cell text');await toolbar.locator('[aria-label="表格"]').click();await page.getByRole('menuitem',{name:'行',exact:true}).hover();await page.getByRole('menuitem',{name:'向下插入行',exact:true}).click();assert.equal(await table.locator('tr').count(),rows+1);const first=table.locator('[data-table-cell-id]').first(),width=await first.evaluate(el=>el.getBoundingClientRect().width);const handle=first.locator('.cursor-col-resize').first();const bounds=await handle.boundingBox();await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);await page.mouse.down();await page.mouse.move(bounds.x+70,bounds.y+bounds.height/2,{steps:10});await page.mouse.up();assert.ok(await first.evaluate(el=>el.getBoundingClientRect().width)>width+30);await reopen();assert.ok(await first.evaluate(el=>el.getBoundingClientRect().width)>width+30);assert.match(await table.innerText(),/Cell text/);assert.equal(await table.locator('tr').count(),rows+1);
});
await check('table cell merge and split',async()=>{
await slash('表格');const table=editor.locator('table'),cells=table.locator('[data-table-cell-id]');const count=await cells.count();const a=await cells.nth(0).boundingBox(),b=await cells.nth(1).boundingBox();await page.mouse.move(a.x+15,a.y+15);await page.mouse.down();await page.mouse.move(b.x+20,b.y+20,{steps:10});await page.mouse.up();await toolbar.locator('[aria-label="表格"]').click();await page.getByRole('menuitem',{name:'单元格',exact:true}).hover();await page.getByRole('menuitem',{name:'合并单元格',exact:true}).click();assert.equal(await cells.count(),count-1);await cells.first().locator('.slate-p').first().click();await toolbar.locator('[aria-label="表格"]').click();await page.getByRole('menuitem',{name:'单元格',exact:true}).hover();await page.getByRole('menuitem',{name:'拆分单元格',exact:true}).click();assert.equal(await cells.count(),count);
});
await check('font size, alignment, line spacing and contents persist',async()=>{
await page.keyboard.type('Styled paragraph');await page.keyboard.press('Home');await page.keyboard.press('Shift+End');await toolbar.getByRole('textbox',{name:'字号',exact:true}).fill('24');await page.keyboard.press('Enter');await toolbar.locator('[aria-label="对齐"]').click();await page.getByRole('menuitemradio',{name:'居中',exact:true}).click();await toolbar.locator('[aria-label="行高"]').click();await page.getByRole('menuitemradio',{name:'2',exact:true}).click();await reopen();const state=readDocumentState(await page.evaluate(()=>window.draft.markdown));assert.equal(state.value[0].align,'center');assert.equal(state.value[0].lineHeight,2);assert.equal(String(state.value[0].children[0].fontSize),'24px');
await fresh();await page.keyboard.type('# Scene title');await page.keyboard.press('Enter');await slash('目录');await editor.locator('.slate-toc').getByRole('button',{name:'Scene title',exact:true}).waitFor();await reopen();await editor.locator('.slate-toc').getByRole('button',{name:'Scene title',exact:true}).waitFor();
});
await check('math renders and remains editable after reopening',async()=>{
await slash('公式');await page.getByRole('textbox',{name:'TeX 公式',exact:true}).fill('x^2 + y^2 = z^2');await page.getByRole('textbox',{name:'TeX 公式',exact:true}).press('Enter');await editor.locator('.katex').waitFor();await reopen();await editor.locator('.katex').waitFor();assert.match(await editor.locator('.katex').innerText(),/x/);
});
await check('date and emoji insert at caret and persist',async()=>{
await slash('日期');await editor.locator('.slate-date').click();await page.getByRole('gridcell').filter({hasText:/^15$/}).first().click();await page.keyboard.press('Escape');await editor.locator('[data-slate-node=element]').first().click();await page.keyboard.press('End');await toolbar.locator('[aria-label="表情"]').click();await page.getByRole('button',{name:'😀',exact:true}).click();await reopen();assert.match(await editor.innerText(),/😀/);assert.equal(await editor.locator('.slate-date').count(),1);
});
await check('footnote content and navigation survive reopening',async()=>{
await slash('脚注');await page.keyboard.type('Footnote body');await reopen();assert.match(await editor.innerText(),/Footnote body/);assert.match(await page.evaluate(()=>window.draft.markdown),/\[\^1\]/);
});
await check('Mermaid renders locally, PlantUML requires explicit online preview',async()=>{
await slash('代码绘图');const drawing=editor.locator('.slate-code_drawing');await drawing.getByPlaceholder('输入代码…').fill('graph TD\nA[Start] --> B[End]');await drawing.getByRole('combobox').first().click();await page.getByRole('option',{name:'Mermaid',exact:true}).click();await drawing.getByRole('img',{name:'代码图表'}).waitFor({timeout:30000});await reopen();await drawing.getByRole('img',{name:'代码图表'}).waitFor({timeout:30000});await drawing.getByRole('combobox').first().click();await page.getByRole('option',{name:'PlantUml',exact:true}).click();await page.getByRole('button',{name:'在线预览 PlantUML'}).waitFor();assert.equal(remote.filter(url=>url.includes('plantuml.com')).length,0);
});
await check('Excalidraw draws with local fonts and reopens',async()=>{
await slash('Excalidraw');const canvas=editor.locator('.excalidraw canvas').last();await canvas.waitFor({timeout:30000});const rect=await canvas.boundingBox();await canvas.click({position:{x:150,y:150}});await page.keyboard.press('r');await page.mouse.move(rect.x+160,rect.y+160);await page.mouse.down();await page.mouse.move(rect.x+260,rect.y+240,{steps:6});await page.mouse.up();await page.getByRole('button',{name:'返回',exact:true}).click();await page.getByRole('button',{name:'放大编辑',exact:true}).click();await canvas.waitFor({timeout:30000});assert.equal(remote.filter(url=>/excalidraw.*fonts|esm.sh/.test(url)).length,0);const state=readDocumentState(await page.evaluate(()=>window.draft.markdown));assert.ok(state.value.find(n=>n.type==='excalidraw').data.elements.some(e=>e.type==='rectangle'));
await toolbar.locator('[aria-label="导出"]').click();const download=page.waitForEvent('download');await page.getByRole('menuitem',{name:'导出 HTML',exact:true}).click();const exported=await download;const html=await readFile(await exported.path(),'utf8');assert.match(html,/<img[^>]+src="data:image/);console.log('PASS drawing export contains rendered image');
});
assert.deepEqual(failures,[]);assert.deepEqual(errors,[]);
}finally{console.log('PAGE_ERRORS',errors);console.log('REMOTE',remote);await browser.close();await server.close();}
