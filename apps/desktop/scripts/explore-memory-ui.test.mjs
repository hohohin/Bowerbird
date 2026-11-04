import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium} from '../../html-renderer/node_modules/playwright/index.mjs';

const server=await createServer({cacheDir:'.tmp/explore-memory-vite',server:{host:'127.0.0.1',port:17962,strictPort:true,hmr:false,watch:null}});
await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
const errors=[];
const fixture=server.resolvedUrls.local[0]+'scripts/fixtures/canvas-reference/preview.html?source-library&detail-route&strict';
const key='bowerbird.explorer.lastUrl';
const saved='https://www.pinterest.com/search/pins/?q=ceramics';
const visited='https://www.xiaohongshu.com/explore/fixture-note?xsec_token=fixture';
async function boot(context){
 const page=await context.newPage();page.setDefaultTimeout(7000);
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 await page.goto(fixture);await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
 assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='open_source_browser').length),0,'starting the application does not automatically open exploration');
 return page;
}
async function open(page,expected){
 await page.getByRole('button',{name:'探索',exact:true}).click();
 await page.waitForFunction(()=>window.calls.some(c=>c.command==='open_source_browser'));
 assert.equal(await page.evaluate(()=>window.calls.find(c=>c.command==='open_source_browser').args.url),expected,'exploration opens the remembered page');
}
try{
 const context=await browser.newContext({viewport:{width:1280,height:850}});
 const page=await boot(context);
 await page.evaluate(({key,saved})=>localStorage.setItem(key,saved),{key,saved});
 await open(page,saved);
 await page.evaluate(url=>window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'source-browser://location',payload:url}),visited);
 await page.waitForFunction(({key,visited})=>localStorage.getItem(key)===visited,{key,visited});
 const counts=()=>page.evaluate(()=>window.calls.filter(c=>['open_source_browser','navigate_source_browser','reload_source_browser'].includes(c.command)).length);
 const before=await counts();
 // A paused UI with an active guide must not reset the live page when toggled.
 await page.evaluate(async()=>{
  const {useOnboarding}=await import('/src/lib/onboardingStore.ts');
  useOnboarding.setState({panel:'closed',guide:{version:2,status:'active',role:'designer',completedRoles:[],sessions:{designer:{step:3,projectId:'p',runId:'fixture',tasks:{},ready:false,baselineText:'',stepStartedAt:Date.now()}}}});
 });
 await page.getByRole('button',{name:'收起浏览器',exact:true}).click();
 await page.getByRole('button',{name:'探索',exact:true}).click();
 await page.waitForTimeout(150);
 assert.equal(await counts(),before,'reopening keeps the native document, including during onboarding');
 assert.equal(await page.getByRole('textbox',{name:'网页地址'}).inputValue(),visited);
 const state=await context.storageState();await context.close();
 const restarted=await browser.newContext({storageState:state,viewport:{width:1280,height:850}});
 const restored=await boot(restarted);await open(restored,visited);
 await restarted.close();
 for(const stored of [null,'javascript:alert(1)','https://user:password@example.com/']){
  const clean=await browser.newContext({viewport:{width:1280,height:850}});const fresh=await boot(clean);
  if(stored)await fresh.evaluate(({key,stored})=>localStorage.setItem(key,stored),{key,stored});
  await open(fresh,'https://www.xiaohongshu.com/explore');await clean.close();
 }
 assert.deepEqual(errors,[]);
 console.log('PASS remembered address, native navigation, live reopen, onboarding, restart and invalid-memory fallback');
}finally{await browser.close();await server.close();}
