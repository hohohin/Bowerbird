import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),cacheDir:'.tmp/text-editor-polish-vite',plugins:process.env.BOWERBIRD_BLOCK_MUTATION?[{name:'mutation',enforce:'pre',load(id){if(id.replaceAll('\\','/').endsWith('/src/components/TextBlockActions.tsx'))return readFile(process.env.BOWERBIRD_BLOCK_MUTATION,'utf8');}}]:[],server:{host:'127.0.0.1',port:0,strictPort:false,hmr:false,watch:null}});
await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(5000);
const errors=[],failures=[],entries=[];page.on('pageerror',e=>errors.push(e.message));
const coverage=process.env.BOWERBIRD_POLISH_COVERAGE==='1';
if(coverage)await page.coverage.startJSCoverage({resetOnNavigation:false});
const editor=page.getByRole('textbox',{name:'文档正文',exact:true});
async function check(name,fn){try{
 if(coverage&&page.url()!=='about:blank'){entries.push(...await page.coverage.stopJSCoverage());await page.coverage.startJSCoverage({resetOnNavigation:false});}
 await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/text-workspace-live/preview.html?markdown`);
 await editor.locator('.text-document-block').first().click();await fn();console.log('PASS',name);
}catch(e){failures.push(`${name}: ${e.stack}`);if(process.env.BOWERBIRD_POLISH_DEBUG)console.log(await page.evaluate(()=>({draft:window.draft,html:document.querySelector('.text-document-body')?.innerHTML,selection:window.getSelection()?.toString(),focused:document.activeElement?.outerHTML.slice(0,300)})));}}
async function reopen(){await page.getByRole('button',{name:'返回',exact:true}).click();await page.getByRole('button',{name:'放大编辑',exact:true}).click();await editor.waitFor();}
try{
await check('list markers reserve space independently of handles and Agent',async()=>{
 await page.keyboard.type('- first list item');await page.keyboard.press('Enter');await page.keyboard.type('second item');
 const list=editor.locator('.text-document-block').nth(1);await list.hover();
 const content=await list.locator('[data-slate-string]').boundingBox(),grip=await list.getByRole('button',{name:'段落操作'}).boundingBox();
 assert.ok(content.x-grip.x-grip.width>=28,'list marker needs its own gutter between handle and text');
 const agent=await list.getByRole('button',{name:'Agent',exact:true}).boundingBox();assert.ok(agent.x+agent.width<=grip.x);
 assert.ok((await list.boundingBox()).height<50,'list rows should have compact rhythm');
 await list.getByRole('button',{name:'段落操作'}).click();await page.getByRole('menuitem',{name:'复制段落',exact:true}).click();
 assert.equal(await editor.locator('ul').count(),3);
 for(const theme of ['dark','light']){await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await mkdir('.tmp/text-editor-polish',{recursive:true});await page.screenshot({path:`.tmp/text-editor-polish/list-${theme}.png`});}
});
await check('Tab and Shift+Tab nest lists and preserve nesting after reopening',async()=>{
 await page.keyboard.type('- parent');await page.keyboard.press('Enter');await page.keyboard.type('child');
 const child=editor.locator('[data-slate-string]').filter({hasText:'child'}),parent=editor.locator('[data-slate-string]').filter({hasText:'parent'});
 await page.keyboard.press('Tab');assert.ok((await child.boundingBox()).x>(await parent.boundingBox()).x+20);
 assert.match(await page.evaluate(()=>window.draft.markdown),/\n\s{2,}[-*] child/);
 await reopen();assert.equal(await editor.locator('ul').count(),2);assert.equal(await editor.locator('pre').count(),0);
 await child.click();await page.keyboard.press('End');await page.keyboard.press('Shift+Tab');assert.ok(Math.abs((await child.boundingBox()).x-(await parent.boundingBox()).x)<2);
 await page.keyboard.press('Enter');await page.keyboard.press('Enter');await page.keyboard.type('body');assert.equal(await editor.locator('ul').count(),2);
});
await check('quote has one handle, preserves children on copy and deletes safely',async()=>{
 await page.keyboard.type('> quoted');await page.keyboard.press('Enter');await page.keyboard.type('second quote line');
 assert.equal(await editor.getByRole('button',{name:'段落操作'}).count(),1);
 await page.keyboard.press('Alt+Enter');await page.getByRole('menuitem',{name:'复制段落',exact:true}).click();
 assert.equal(await editor.locator('blockquote').count(),2);
 await editor.locator('.text-document-block').last().getByRole('button',{name:'段落操作'}).click();await page.getByRole('menuitem',{name:'删除段落',exact:true}).click();
 assert.equal(await editor.locator('blockquote').count(),1);
});
await check('block type picker changes heading levels and returns to body without losing selection',async()=>{
 await page.keyboard.type('change heading');await page.keyboard.press('Home');await page.keyboard.press('Shift+End');
 const toolbar=page.getByRole('toolbar',{name:'文字格式',exact:true});
 await toolbar.getByRole('button',{name:'段落类型'}).click();
 await page.waitForFunction(()=>document.activeElement?.getAttribute('role')==='menuitemradio');
 await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
 assert.equal(await editor.locator('h1').innerText(),'change heading');
 await toolbar.getByRole('button',{name:'段落类型'}).click();await page.getByRole('menuitemradio',{name:'标题 3',exact:true}).click();assert.equal(await editor.locator('h3').innerText(),'change heading');
 await toolbar.getByRole('button',{name:'段落类型'}).click();await page.getByRole('menuitemradio',{name:'正文',exact:true}).click();assert.equal(await editor.locator('h1,h2,h3').count(),0);
 await page.getByRole('toolbar',{name:'选中文字格式'}).getByRole('button',{name:'加粗',exact:true}).click();assert.equal(await editor.locator('strong').innerText(),'change heading');
});
await check('drag has visible insertion position and preserves paragraph undo',async()=>{
 await page.keyboard.type('first');await page.keyboard.press('Enter');await page.keyboard.type('second');
 const blocks=editor.locator('.text-document-block');const from=blocks.first().getByRole('button',{name:'段落操作'}),target=blocks.last();
 await blocks.first().hover();const a=await from.boundingBox(),b=await target.boundingBox();
 await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();await page.mouse.move(b.x+80,b.y+b.height-2,{steps:15});await page.mouse.move(b.x+80,b.y+b.height-1);
 assert.equal(await editor.locator('[data-drop-edge="after"]').count(),1);await page.mouse.up();
 await page.waitForFunction(()=>window.draft.markdown.indexOf('second')<window.draft.markdown.indexOf('first'));
 await page.keyboard.press('Control+z');assert.match(await page.evaluate(()=>window.draft.markdown),/first[\s\S]*second/);
 assert.equal(await editor.locator('[data-drop-edge]').count(),0);
});
await check('nested list parent copies, moves and deletes with its children',async()=>{
 await page.keyboard.type('- parent');await page.keyboard.press('Enter');await page.keyboard.press('Tab');await page.keyboard.type('child');
 await page.keyboard.press('Enter');await page.keyboard.press('Shift+Tab');await page.keyboard.type('sibling');
 const blocks=editor.locator('.text-document-block');
 await blocks.first().getByRole('button',{name:'段落操作'}).dragTo(blocks.last(),{targetPosition:{x:100,y:25}});
 await page.waitForFunction(()=>window.draft.markdown.indexOf('sibling')<window.draft.markdown.indexOf('parent'));
 assert.match(await page.evaluate(()=>window.draft.markdown),/sibling\n[-*] parent\n\s+[-*] child/);
 await blocks.nth(1).getByRole('button',{name:'段落操作'}).click();await page.getByRole('menuitem',{name:'复制段落',exact:true}).click();
 assert.equal(await blocks.count(),5);
 const ids=await editor.locator('[data-block-id]').evaluateAll(nodes=>nodes.map(n=>n.dataset.blockId));assert.equal(new Set(ids).size,ids.length);
 await blocks.nth(3).getByRole('button',{name:'段落操作'}).click();await page.getByRole('menuitem',{name:'删除段落',exact:true}).click();assert.equal(await blocks.count(),3);
 await blocks.nth(1).getByRole('button',{name:'段落操作'}).dragTo(blocks.first(),{targetPosition:{x:100,y:1}});
 await page.waitForFunction(()=>window.draft.markdown.indexOf('parent')<window.draft.markdown.indexOf('sibling'));
 assert.match(await page.evaluate(()=>window.draft.markdown),/parent\n\s+[-*] child\n[-*] sibling/);
});
await check('long numbered lists wrap cleanly at narrow width; heading handles align',async()=>{
 await page.setViewportSize({width:1000,height:900});
 await page.keyboard.type('## Scene title');await page.keyboard.press('Enter');await page.keyboard.type('1. first');
 for(let n=2;n<=12;n++){await page.keyboard.press('Enter');await page.keyboard.type(`line ${n}`);}
 await page.keyboard.type(' with a long continuation that wraps onto several lines of text');
 const block=editor.locator('.text-document-block').last();await block.hover();
 const grip=await block.getByRole('button',{name:'段落操作'}).boundingBox(),text=await block.locator('[data-slate-string]').boundingBox();
 assert.ok(text.x-grip.x-grip.width>=28);assert.equal(await editor.locator('ol').last().getAttribute('start'),'12');
 const bounds=await editor.boundingBox(),agent=await block.getByRole('button',{name:'Agent',exact:true}).boundingBox();assert.ok(agent.x>=bounds.x);
 const heading=editor.locator('.text-document-block').first();await heading.hover();
 const h=await heading.locator('h2').boundingBox(),handle=await heading.getByRole('button',{name:'段落操作'}).boundingBox();assert.ok(Math.abs(h.y-handle.y)<10);
 for(const theme of ['dark','light']){await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.screenshot({path:`.tmp/text-editor-polish/numbered-${theme}.png`});}
});
assert.deepEqual(failures,[]);assert.deepEqual(errors,[]);
}finally{if(coverage){entries.push(...await page.coverage.stopJSCoverage());await mkdir('.tmp/text-editor-polish',{recursive:true});await writeFile('.tmp/text-editor-polish/coverage.json',JSON.stringify(entries.filter(e=>/\/src\/components\/(?:Text|textBlock)/.test(e.url))));}await browser.close();await server.close();}
