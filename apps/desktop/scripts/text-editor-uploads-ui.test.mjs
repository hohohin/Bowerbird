import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium} from '../../html-renderer/node_modules/playwright/index.mjs';
const server=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),cacheDir:'.tmp/text-editor-uploads-vite',server:{host:'127.0.0.1',port:0,strictPort:false,hmr:false,watch:null}});await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(15000);
const coverage=[];let collecting=false;
async function collect(){if(collecting)coverage.push(...(await page.coverage.stopJSCoverage()).filter(e=>e.url.includes('/src/')));collecting=false;}
async function beginCoverage(){await collect();if(process.env.BOWERBIRD_DEMO_COVERAGE){await page.coverage.startJSCoverage();collecting=true;}}
page.on('console',m=>{if(m.type()==='error')console.log('CONSOLE',m.text());});await page.exposeFunction('notice',m=>console.log('NOTICE',m));await page.addInitScript(()=>window.addEventListener('bowerbird://notify',e=>window.notice(e.detail)));const errors=[];page.on('pageerror',e=>errors.push(e.message));const editor=page.getByRole('textbox',{name:'文档正文',exact:true}),toolbar=page.getByRole('toolbar',{name:'文字格式',exact:true});
await page.route('**/fixture/reference.png*',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="red"/></svg>'}));
async function fresh(){await beginCoverage();await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/text-workspace-live/preview.html?markdown`,{timeout:60000});await editor.locator('[data-slate-node=element]').first().click();}
async function upload(name,file){const picker=page.waitForEvent('filechooser');await toolbar.locator(`[aria-label="插入${name}"]`).click();await(await picker).setFiles(file);}
async function reopen(){await page.getByRole('button',{name:'返回',exact:true}).click();await page.getByRole('button',{name:'放大编辑',exact:true}).click();await editor.waitFor();}
try{
await fresh();await upload('附件',{name:'notes.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4 fixture')});await editor.getByText('notes.pdf',{exact:true}).waitFor();await reopen();await editor.getByText('notes.pdf',{exact:true}).waitFor();assert.ok(await page.evaluate(()=>window.calls.some(c=>c.command==='resolve_document_attachment')));assert.doesNotMatch(await page.evaluate(()=>window.draft.markdown),/data:application/);console.log('PASS local attachment insertion and resolution on reopen');
await fresh();await upload('图片',{name:'example.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5u0AAAAASUVORK5CYII=','base64')});await editor.locator('img').waitFor();const last=editor.locator('.text-document-block').last();await last.click();await page.keyboard.type('After uploaded image');await page.waitForFunction(()=>window.draft?.markdown.includes('After uploaded image'));await reopen();assert.equal(await editor.locator('img').count(),1);assert.match(await editor.innerText(),/After uploaded image/);console.log('PASS image upload and editable trailing paragraph');
assert.deepEqual(errors,[]);
}finally{console.log('PAGE_ERRORS',errors);console.log('VISIBLE',await page.locator('body').innerText());console.log('UPLOAD_CALLS',await page.evaluate(()=>window.calls.filter(c=>/video_import|get_assets/.test(c.command))));if(process.env.BOWERBIRD_DEMO_COVERAGE){await mkdir('.tmp/text-editor-uploads',{recursive:true});await writeFile('.tmp/text-editor-uploads/coverage.json',JSON.stringify((await collect(),coverage)));}await browser.close();await server.close();}
