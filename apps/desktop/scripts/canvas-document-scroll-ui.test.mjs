import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium} from '../../html-renderer/node_modules/playwright/index.mjs';
const server=await createServer({server:{host:'127.0.0.1',port:0,strictPort:false,hmr:false,watch:null}});await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1500,height:1000}});
try{
 await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/canvas-document/preview.html`);
 await page.locator('[data-canvas-node-id="old"]').waitFor();
 await page.evaluate(()=>{const snapshot=window.snapshot();snapshot.nodes=[{...snapshot.nodes[0],id:'doc',kind:'note',x:80,y:80,width:400,height:112,payloadJson:JSON.stringify({schema_version:1,note_type:'document',title:'剧本',text:'# 第一行内容\n\n**第二行内容**\n\n第三行也展示\n\n- [阅读正文](https://example.invalid/source)\n\n<div>富文本正文</div>',cells:[],member_ids:[]})}];snapshot.edges=[];snapshot.groups=[];snapshot.groupItems=[];sessionStorage.setItem('reference-fixture',JSON.stringify(snapshot));});
 await page.reload();const card=page.locator('.is-document-card');await card.waitFor();
 await page.waitForFunction(()=>document.querySelector('.is-document-card .text-file-excerpt')?.textContent.includes('富文本正文'));
 const excerpt=await card.locator('.text-file-excerpt').innerText();
 for(const text of ['第一行内容','第二行内容','第三行也展示','阅读正文','富文本正文']) assert.ok(excerpt.includes(text));
 for(const source of ['# ','**','](','<div>','https://']) assert.ok(!excerpt.includes(source));
 assert.equal(await card.locator('.document-card-preview').count(),1,'same reading surface as library');
 const ratio=await card.evaluate(el=>parseFloat(el.style.width)/parseFloat(el.style.height));assert.ok(Math.abs(ratio-.75)<.001);
 const handle=card.locator('[data-canvas-connect-side="output"]');
 const box=await card.boundingBox(),port=await handle.boundingBox();assert.ok(Math.abs(port.y+port.height/2-box.y-box.height/2)<2,'port follows the portrait card center');
 await mkdir('.tmp/canvas-document-preview',{recursive:true});
 for(const theme of ['dark','light']) {await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.screenshot({path:`.tmp/canvas-document-preview/${theme}.png`});}
 await page.evaluate(()=>{const snapshot=window.snapshot();const value=JSON.parse(snapshot.nodes[0].payloadJson);value.text=Array.from({length:160},(_,i)=>`第${i}段：这是一篇可滚动预览的长文档。`).join('\n\n');snapshot.nodes[0].payloadJson=JSON.stringify(value);sessionStorage.setItem('reference-fixture',JSON.stringify(snapshot));});
 await page.reload();const body=page.locator('.is-document-card .text-file-excerpt');await body.getByText('第159段',{exact:false}).waitFor();
 const plane=page.locator('.canvas-plane');const transform=await plane.evaluate(el=>el.style.transform);await body.hover();await page.mouse.wheel(0,600);await page.waitForFunction(()=>document.querySelector('.is-document-card .text-file-excerpt').scrollTop>0);assert.equal(await plane.evaluate(el=>el.style.transform),transform);
 await body.evaluate(el=>el.scrollTop=el.scrollHeight);await page.mouse.wheel(0,500);await page.waitForTimeout(100);assert.equal(await plane.evaluate(el=>el.style.transform),transform);
 await page.mouse.wheel(0,-400);await page.waitForFunction(()=>{const e=document.querySelector('.is-document-card .text-file-excerpt');return e.scrollTop<e.scrollHeight-e.clientHeight-100;});
 await body.dblclick();await page.getByRole('textbox',{name:'文档正文',exact:true}).waitFor();console.log('PASS long document hover scroll, boundary isolation, reverse scroll and double-click editing');
}finally{await browser.close();await server.close();}
