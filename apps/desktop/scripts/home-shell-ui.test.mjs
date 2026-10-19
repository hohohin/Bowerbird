import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server=await createServer({server:{host:'127.0.0.1',port:1697,strictPort:true,hmr:false,watch:null}});
await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1280,height:840}});
page.setDefaultTimeout(10000);
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
try {
 await mkdir('.tmp/home-shell',{recursive:true});
 await page.goto('http://127.0.0.1:1697/scripts/fixtures/canvas-reference/preview.html?source-library&detail-route');
 await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
 assert.equal(await page.locator('.app-sidebar,.app-sidebar-host,.app-sidebar-reveal,.task-center-entry').count(),0);
 assert.equal(await page.getByRole('button',{name:'返回素材库',exact:true}).count(),0);
 await page.getByRole('button',{name:'返回主页',exact:true}).waitFor();
 const account=page.locator('.topbar-account-trigger');
 await account.click();
 const menu=page.getByRole('menu',{name:'账号与设置'});
 await menu.waitFor();
 const anchor=await account.boundingBox(), popup=await menu.boundingBox();
 assert.ok(popup.y>=anchor.y+anchor.height && popup.x+popup.width<=1280,'account menu opens down and inside viewport');
 await page.getByRole('menuitem',{name:'登录 Bowerbird 账号',exact:true}).waitFor();
 await page.keyboard.press('Escape');
 assert.equal(await account.evaluate(el=>el===document.activeElement),true);
 await page.evaluate(()=>window.store.setState({cloudAuth:{logged_in:true,display_name:'测试用户',cloud_available:true},cloudEntitlement:{tier:'pro',policy:{can_use_byo:true,can_use_cloud:true},balances:{daily:0,sub:0,topup:0},recent_transactions:[],generation_services:[],prompt_configs:[]}}));
 await account.click();await page.getByRole('menuitem',{name:'升级账号',exact:true}).waitFor();
 await page.getByRole('menuitem',{name:/^设置/}).click();
 await page.getByRole('dialog').waitFor();
 await page.getByRole('button',{name:'系统设置',exact:true}).waitFor();
 await page.keyboard.press('Escape');
 await page.getByRole('dialog').waitFor({state:'hidden'});
 await page.screenshot({path:'.tmp/home-shell/canvas.png'});
 await page.getByRole('button',{name:'返回主页',exact:true}).click();
 await page.locator('.library-home .folder-media-card').first().waitFor();
 assert.equal(await page.locator('.app-sidebar,.task-center-entry').count(),0);
 for(const theme of ['light','dark']) {
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  for(const width of [1280,900]) {
   await page.setViewportSize({width,height:840});await page.waitForTimeout(650);
   const bounds=await page.locator('.library-home .folder-scroller').evaluate(el=>{
    const grid=el.querySelector('.folder-masonry'), cards=[...grid.children].map(c=>c.getBoundingClientRect()), first=cards[0], r=el.getBoundingClientRect(), g=grid.getBoundingClientRect(), css=getComputedStyle(el);
    return {left:first.left-r.left,top:first.top-r.top,bottom:parseFloat(css.paddingBottom)+g.bottom-Math.max(...cards.map(c=>c.bottom)),insetRight:g.right-first.right,columns:Number(grid.dataset.columns),cardWidth:first.width,available:g.width,overflow:el.scrollWidth>el.clientWidth+1};
   });
   assert.ok(Math.abs(bounds.left-(width>640?9.6:7.2))<.2,JSON.stringify(bounds));
   assert.ok(Math.abs(bounds.top-8)<.2,JSON.stringify(bounds));
   assert.ok(Math.abs(bounds.bottom-48)<.2,JSON.stringify(bounds));
   assert.ok(Math.abs(bounds.available-bounds.cardWidth*bounds.columns-8*(bounds.columns-1)-8)<1,'cards retain 8px internal gaps and 4px layout insets');
   assert.equal(bounds.overflow,false);
   await account.click();await menu.waitFor();
   const menuRect=await menu.boundingBox();assert.ok(menuRect.x>=0 && menuRect.x+menuRect.width<=width);
   await page.screenshot({path:`.tmp/home-shell/home-${theme}-${width}.png`});
   await page.keyboard.press('Escape');
  }
 }
 await page.evaluate(()=>window.store.setState({mode:'manage',selectedIds:new Set(window.store.getState().assets.map(a=>a.id))}));
 assert.equal(await page.getByRole('button',{name:'移入新文件夹',exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:'移入已有',exact:true}).count(),0);
 await page.goto('http://127.0.0.1:1697/scripts/fixtures/asset-multi-menu/preview.html');
 await page.waitForFunction(()=>window.fixtureStore);
 await page.evaluate(()=>{window.resetSelection();window.fixtureStore.getState().openContextMenu(100,100,'a1');});
 await page.getByRole('menu',{name:'已选 3 张素材的操作'}).waitFor();
 assert.equal(await page.getByRole('menuitem',{name:'用选中的内容新建集合',exact:true}).count(),0);
 assert.equal(await page.getByRole('menuitem',{name:'移入已有集合',exact:true}).count(),0);
 await page.getByRole('menuitem',{name:'加入项目',exact:true}).waitFor();
 assert.deepEqual(errors,[]);
 console.log('PASS home outer spacing halved, internal gaps unchanged, project sidebar/status absent, home return, account menu/settings and light/dark narrow layouts');
} catch(error) { console.error(errors); console.error((await page.locator('body').innerText()).slice(0,1800)); throw error; } finally {await browser.close();await server.close();}
