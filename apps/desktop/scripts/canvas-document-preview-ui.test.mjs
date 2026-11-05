import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium} from '../../html-renderer/node_modules/playwright/index.mjs';
const server=await createServer({server:{host:'127.0.0.1',port:0,strictPort:false,hmr:false,watch:null}});await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1500,height:1000}});
try{
 await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/canvas-document/preview.html`);
 await page.locator('[data-canvas-node-id="old"]').waitFor();
 await page.evaluate(()=>{const snapshot=window.snapshot();snapshot.nodes=[{...snapshot.nodes[0],id:'doc',kind:'note',x:80,y:80,width:400,height:420,payloadJson:JSON.stringify({schema_version:1,note_type:'document',title:'剧本',text:'第一行内容\n\n第二行内容\n第三行不展示',cells:[],member_ids:[]})}];snapshot.edges=[];snapshot.groups=[];snapshot.groupItems=[];sessionStorage.setItem('reference-fixture',JSON.stringify(snapshot));});
 await page.reload();const card=page.locator('.is-document-card');await card.waitFor();
 assert.equal(await card.locator('.canvas-document-preview').innerText(),'第一行内容\n第二行内容');
 assert.equal(await card.evaluate(el=>el.style.height),'112px');
 await card.locator('.canvas-document-preview').dblclick();
 const editor=page.getByRole('textbox',{name:'文档正文',exact:true});await editor.waitFor();assert.match(await editor.innerText(),/第三行不展示/);
 await page.getByRole('button',{name:'返回',exact:true}).click();
 await card.locator('.canvas-document-heading').dblclick();await editor.waitFor();
 await page.getByRole('button',{name:'返回',exact:true}).click();
 await page.evaluate(()=>{const snapshot=window.snapshot();const value=JSON.parse(snapshot.nodes[0].payloadJson);value.text='';snapshot.nodes[0].payloadJson=JSON.stringify(value);sessionStorage.setItem('reference-fixture',JSON.stringify(snapshot));});
 await page.reload();
 await page.waitForFunction(()=>document.querySelector('.is-document-card')?.style.height==='56px');
 assert.equal(await card.locator('.canvas-document-heading > span').innerText(),'空白文档');assert.equal(await card.locator('.canvas-document-preview').count(),0);
 await page.reload();await card.locator('.canvas-document-heading').dblclick();await editor.waitFor();assert.equal(await editor.locator('[data-slate-string]').count(),0);
 console.log('PASS two-line preview, preview/title double-click, complete editor content, empty document and reload');
}finally{await browser.close();await server.close();}
