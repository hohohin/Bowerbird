import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium} from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({cacheDir:'.tmp/folder-view-parity/vite',server:{host:'127.0.0.1',port:0,strictPort:false,hmr:false,watch:null}}); await server.listen();
const browser = await chromium.launch({channel:'chrome',headless:true});
const page = await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
page.setDefaultTimeout(10000);
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const card=id=>page.locator(`[data-connection-entry="${id}"] .folder-media-card`);
const menu=name=>page.getByRole('menuitem',{name,exact:true});
async function more() { const button=page.getByRole('button',{name:'更多素材库控件',exact:true});if(await button.count() && await button.getAttribute('aria-expanded')!=='true') await button.click(); }
try {
 await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/connected-collections/preview.html`); await page.getByRole('tab',{name:'文件夹',exact:true}).click(); await card('root-0').waitFor();
 await more(); for(const label of ['不看生成图','颜色筛选','刷新文件夹']) assert.equal(await page.getByRole('button',{name:label,exact:true}).isVisible(),true);
 await card('root-0').click({button:'right'});
 for(const label of ['打开图片详情','选择','重命名','图片标注','分层编辑','添加到文件夹','移动到文件夹','打开所在文件夹','用系统程序打开','复制图片','复制文件路径','管理外部引用 · 原文件保留','删除']) assert.equal(await menu(label).count(),1,label);
 await menu('选择').click(); const bar=page.getByRole('group',{name:'分类素材所选操作'});
 assert.equal(await bar.getByRole('button',{name:'全选',exact:true}).count(),1);assert.equal(await bar.getByRole('button',{name:'添加到新项目',exact:true}).count(),1);
 await bar.getByRole('button',{name:'全选',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.catalog-selection')?.textContent.includes('130 项'));
 await bar.getByRole('button',{name:'取消选择',exact:true}).click();
 const resize=page.getByRole('separator',{name:'调整文件夹侧栏宽度'});await resize.focus();await resize.press('ArrowRight');const remembered=await resize.getAttribute('aria-valuenow');
 await page.reload();await page.getByRole('tab',{name:'文件夹',exact:true}).click(); await card('root-0').waitFor();assert.equal(await resize.getAttribute('aria-valuenow'),remembered);
 await page.evaluate(()=>{const template=window.entries[0];const make=(id,time,color)=>({...template,id,asset_id:id,name:id+'.png',color,asset:{...template.asset,id,name:id+'.png',generation_session_id:'conversation',created_at:time}});window.entries=[make('g-old',1,'red'),make('g-new',2,'blue'),{...window.entries[1],color:'red'}];window.changed();});
 await card('g-new').waitFor();assert.equal(await card('g-old').count(),0);const group=page.locator('.catalog-generation-group');assert.equal(await group.locator('.generation-group-count').innerText(),'2/2');
 await group.getByRole('button',{name:'上一张生成素材'}).click();await card('g-old').waitFor();await card('g-old').click({button:'right'});
 assert.equal(await page.evaluate(()=>window.store.getState().contextMenu.assetId),'g-old');
 await menu('选择').click();await bar.getByRole('button',{name:'全选',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.catalog-selection')?.textContent.includes('2 项'));
 assert.equal(await card('g-old').getAttribute('aria-pressed'),'true');await bar.getByRole('button',{name:'取消选择',exact:true}).click();
 await more();await page.getByRole('button',{name:'不看生成图',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.catalog-generation-group'));
 assert.equal(await card('root-1').count(),1);await more();await page.getByRole('button',{name:'不看生成图',exact:true}).click();await card('g-new').waitFor();
 await more();await page.getByRole('button',{name:'颜色筛选',exact:true}).click();await page.getByRole('button',{name:'红',exact:true}).click();await card('g-old').waitFor();assert.equal(await card('g-new').count(),0);await page.keyboard.press('Escape');
 assert.ok(await page.evaluate(()=>window.requests.some(r=>r.command==='folder_connections'&&r.args.filter.color==='red'&&r.args.filter.grouped)));
 // Controls are overlays: show/hide does not alter directory or gallery geometry.
 await mkdir('.tmp/folder-view-parity',{recursive:true});
 for(const width of [1440,600,360]) {await page.setViewportSize({width,height:900});for(const theme of ['dark','light']) {await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.waitForTimeout(200);
 const geometry=await page.locator('.connected-collections').evaluate(root=>{const h=root.querySelector('.file-view-heading');const read=()=>['.catalog-sidebar','.catalog-gallery','.catalog-scroller'].map(s=>{const r=root.querySelector(s).getBoundingClientRect();return [r.top,r.height]});const before=read();h.style.display='none';const after=read();h.style.display='';return {before,after};});assert.deepEqual(geometry.before,geometry.after);await page.screenshot({path:`.tmp/folder-view-parity/${width}-${theme}.png`});}}
 // Embedded editor keeps menus and child dialogs inside its own workspace.
 await page.setViewportSize({width:1440,height:900});
 await page.route('**/fixture/reference.png*',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#99aabb"/></svg>'}));
 await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/text-workspace-live/preview.html`);
 const editor=page.getByRole('textbox',{name:'文档正文',exact:true});await editor.waitFor();
 await page.getByRole('tab',{name:'文件夹',exact:true}).click();const embedded=page.locator('.text-workspace [data-connection-entry="entry-img1"] .folder-media-card');await embedded.waitFor();
 await embedded.click({button:'right'});await menu('重命名').waitFor();
 assert.equal(await page.locator('.text-workspace .asset-context-menu').count(),1);
 assert.equal(await page.evaluate(()=>window.store.getState().contextMenu),null,'embedded folder menu does not modify the background menu');
 await menu('重命名').click();const rename=page.getByRole('dialog',{name:'重命名原文件',exact:true});await rename.waitFor();await page.keyboard.press('Escape');assert.equal(await rename.count(),0);assert.equal(await editor.count(),1);
 await embedded.click({button:'right'});await menu('选择').click();assert.equal(await page.locator('.text-workspace .catalog-selection').count(),1);assert.deepEqual(await page.evaluate(()=>[...window.store.getState().selectedIds]),['img1','background-selected']);
 assert.deepEqual(errors,[]);console.log('PASS folder controls, common menu, selection, remembered width, grouped current-member actions, filters, floating geometry and embedded editor menu isolation');
} catch(error) { console.error({url:page.url(),errors,text:(await page.locator('body').innerText()).slice(0,1800),requests:await page.evaluate(()=>window.requests?.slice(-6))}); throw error; } finally {await browser.close();await server.close();}
