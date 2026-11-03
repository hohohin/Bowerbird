import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ root:fileURLToPath(new URL('..',import.meta.url)), plugins: process.env.BOWERBIRD_BLOCK_MUTATION ? [{name:'isolated-block-mutation',enforce:'pre',load(id){if(id.replaceAll('\\','/').endsWith('/src/components/TextBlockActions.tsx')) return readFile(process.env.BOWERBIRD_BLOCK_MUTATION,'utf8');}}] : [], server: { host:'127.0.0.1', port:0, strictPort:false, hmr:false, watch:null } });
await server.listen();
const browser = await chromium.launch({ channel:'chrome', headless:true });
const page = await browser.newPage({ viewport:{width:1440,height:900} });
page.setDefaultTimeout(5000);
await page.route('**/fixture/reference.png*', route => route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>'}));
const failures=[];
async function check(name, action) { try { await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/text-workspace-live/preview.html?blocks`); await page.getByRole('textbox',{name:'文档正文',exact:true}).waitFor(); await action(); console.log('PASS',name); } catch(e) { failures.push(name+': '+e.message); } }
try {
await check('block controls and drag reorder',async()=>{
 const blocks=page.locator('.text-workspace-writing .text-document-block');
 await blocks.nth(1).hover();
 const handle=blocks.nth(1).getByRole('button',{name:'段落操作'});
 await handle.dragTo(blocks.nth(2),{targetPosition:{x:100,y:25}});
 await page.waitForFunction(()=>window.draft?.markdown.indexOf('第二段')<window.draft?.markdown.indexOf('窗外'));
 await blocks.nth(1).getByRole('button',{name:'段落操作'}).click();
 await page.getByRole('menuitem',{name:'复制段落',exact:true}).click();
 assert.equal(await blocks.filter({hasText:'第二段内容。'}).count(),2);
 await blocks.nth(1).getByRole('button',{name:'段落操作'}).click();
 await page.getByRole('menuitem',{name:'删除段落',exact:true}).click();
 assert.equal(await blocks.filter({hasText:'第二段内容。'}).count(),1);
 await blocks.nth(1).getByRole('button',{name:'段落操作'}).click();
 await page.getByRole('menuitem',{name:'下方插入段落',exact:true}).click();
 await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='文档正文');
 await page.keyboard.type('new paragraph');
 await page.waitForFunction(()=>window.draft.markdown.includes('new paragraph'));
});
await check('continue typing after final image',async()=>{
 const editor=page.getByRole('textbox',{name:'文档正文',exact:true});
 await editor.click(); await page.keyboard.press('Control+End');
 await page.locator('.library-catalog-transition [data-asset-id="img1"]').dblclick();
 await page.waitForFunction(()=>window.draft?.markdown.includes('img1'));
 await page.keyboard.type('after image');
 await page.waitForFunction(()=>window.draft.markdown.includes('after image'));
 assert.match(await page.evaluate(()=>window.draft.markdown),/img1[\s\S]*after image/);
});
await check('reuse prompt stays in editor',async()=>{
 await page.locator('.library-catalog-transition [data-asset-id="img1"]').click({button:'right'});
 await page.getByRole('menuitem',{name:'复用生成提示词',exact:true}).click();
 await page.waitForFunction(()=>window.draft?.markdown.includes('复用的提示词'));
 assert.equal(await page.getByRole('dialog',{name:'文本编辑器',exact:true}).count(),1);
 assert.equal(await page.evaluate(()=>window.store.getState().boardOpen),false);
});
assert.deepEqual(failures,[]);
} finally {await browser.close();await server.close();}
