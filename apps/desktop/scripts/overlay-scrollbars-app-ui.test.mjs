import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

// Reuse closed native mocks, but boot the real production main.tsx instead of
// the fixture's alternate React root. Product modules are not transformed.
const server = await createServer({ cacheDir:'.tmp/overlay-scrollbars-app-vite', plugins: [{ name:'production-main-fixture', enforce:'pre', transform(code,id) {
  if (!id.replaceAll('\\','/').endsWith('/scripts/fixtures/canvas-reference/preview.tsx')) return null;
  const start=code.lastIndexOf('createRoot(document.getElementById("root")!)');
  assert.ok(start>0);
  return {code:code.slice(0,start)+'void import("../../../src/main");\n',map:null};
} }],server:{host:'127.0.0.1',port:17957,strictPort:true,hmr:false,watch:null} });
await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true,ignoreDefaultArgs:['--hide-scrollbars']});
const page=await browser.newPage({viewport:{width:1440,height:900}});
page.setDefaultTimeout(8000);
page.setDefaultNavigationTimeout(30000);
const errors=[],remote=[];page.on('pageerror',error=>errors.push(error.message));
await page.route('**/*',route=>{
  if(new URL(route.request().url()).hostname==='127.0.0.1')return route.continue();
  remote.push(route.request().url());return route.abort();
});
async function scrollingArea(scope,name) {
  await page.waitForFunction(({scope,name})=>{
    const nodes=[...document.querySelectorAll(scope)].filter(node=>node.checkVisibility()&&node.clientHeight>20&&node.scrollHeight>node.clientHeight+10);
    nodes.sort((a,b)=>b.clientWidth*b.clientHeight-a.clientWidth*a.clientHeight);
    if(!nodes[0])return false;nodes[0].dataset.reviewScroll=name;return true;
  },{scope,name});
  return page.locator(`[data-review-scroll="${name}"]`);
}
async function verifyArea(view,name) {
  const before=await view.evaluate((node,name)=>{
    window.reviewScrollRefs??={};window.reviewScrollRefs[name]=node;
    const style=getComputedStyle(node);
    return {x:node.offsetWidth-node.clientWidth-parseFloat(style.borderLeftWidth)-parseFloat(style.borderRightWidth),
      y:node.offsetHeight-node.clientHeight-parseFloat(style.borderTopWidth)-parseFloat(style.borderBottomWidth)};
  },name);
  assert.deepEqual(before,{x:0,y:0},`${name}: both native layout gutters are zero`);
  await view.evaluate(node=>{node.scrollTop=node.scrollTop>20?0:120;});
  await view.hover();
  await page.waitForFunction(name=>{
    const node=window.reviewScrollRefs[name];
    return [...document.querySelectorAll('.industrial-scrollbar')].some(rail=>rail.getAttribute('aria-controls')===node.id&&rail.dataset.axis==='y'&&rail.dataset.visible==='true');
  },name);
  await page.waitForTimeout(150);
  const id=await view.getAttribute('id');
  const rail=page.locator(`.industrial-scrollbar[data-axis="y"][aria-controls="${id}"]`);
  assert.equal(await rail.evaluate(node=>getComputedStyle(node).opacity),'0.5',`${name}: actual scroll reveals at 50%`);
  const thumb=await rail.locator('.industrial-scrollbar-thumb').boundingBox();
  assert.ok(Math.abs(thumb.width-4)<0.2,`${name}: 4px thumb`);
  assert.ok(await view.evaluate((node,name)=>window.reviewScrollRefs[name]===node,name),`${name}: source DOM identity preserved`);
  await page.screenshot({path:`.tmp/overlay-scrollbars-production/${name}.png`});
}
try {
  await mkdir('.tmp/overlay-scrollbars-production',{recursive:true});
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/library-generation-live/preview.html?source-library&detail-route&canvas-library`);
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.classList.contains('industrial-overlay-scrollbars')),'real main mounts global manager');
  await page.locator('.canvas-workspace .canvas-composer-host .ProseMirror').fill(Array.from({length:30},(_,index)=>`画板镜头 ${index+1}：午后自然光，保留纸张纹理。`).join('\n'));
  await verifyArea(await scrollingArea('.canvas-workspace .composer-editor-scroll .collection-scroll-viewport','canvas-input'),'canvas-input');
  await page.getByRole('button',{name:'返回主页',exact:true}).click();
  await page.getByRole('region',{name:'素材库创作',exact:true}).waitFor();
  await verifyArea(await scrollingArea('.library-home .catalog-scroller','home-library'),'home-library');
  assert.equal(await page.locator('.collection-scroll-rail').count(),0);
  assert.equal(await page.locator('.notification-bell-button').count(),1,'one official bell');

  await page.getByRole('combobox',{name:'选择项目',exact:true}).click();
  await verifyArea(await scrollingArea('.library-project-menu','project-menu'),'project-menu');
  await page.getByRole('option',{name:'秋日海报 2',exact:true}).click();
  const editor=page.locator('.library-composer .ProseMirror');
  await editor.fill(Array.from({length:30},(_,index)=>`第 ${index+1} 个镜头：午后自然光，保留纸张纹理。`).join('\n'));
  await verifyArea(await scrollingArea('.library-composer .composer-editor-scroll .collection-scroll-viewport','composer-input'),'composer-input');
  assert.equal(await editor.locator('.industrial-scrollbar').count(),0,'rich editor content DOM contains no injected controls');

  await page.evaluate(()=>{
    const jobs=Object.fromEntries(Array.from({length:12},(_,index)=>{const id=`review-${index}`;return [id,{id,projectId:'p',threadId:`review-thread-${index}`,createdAt:Date.now()-index*1000,running:false,lastPrompt:`山野海报 ${index+1}`,turns:[{id:1,turnKey:`review-turn-${index}`,prompt:`山野海报 ${index+1}`,images:['synthetic.webp'],startedAt:Date.now()-index*1000}]}];}));
    window.store.setState({genJobs:jobs});
  });
  await page.locator('.notification-bell-button').click();
  await verifyArea(await scrollingArea('.notification-bell-history','notification-history'),'notification-history');
  await page.getByRole('dialog',{name:'通知历史',exact:true}).getByRole('button',{name:'关闭通知面板',exact:true}).click();

  await page.setViewportSize({width:1000,height:560});
  await page.locator('.topbar-account-trigger').click();
  const settings=page.getByRole('dialog',{name:'设置',exact:true});
  await settings.getByRole('button',{name:'系统设置',exact:true}).click();
  await verifyArea(await scrollingArea('.settings-dialog .overflow-y-auto, .settings-dialog .app-modal-body','settings-system'),'settings-system');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(950);
  assert.equal(await page.locator('.settings-dialog').count(),0,'close controls remain usable after scrolling');
  assert.deepEqual(errors,[]);
  assert.deepEqual(remote,[]);
  console.log('PASS: real main/App canvas input, home library, project menu, composer input, notification history and settings have zero native gutters; shared DOM/ref identity and pointer actions preserved');
} catch(error) {
  console.log('UI errors',errors);
  console.log((await page.locator('body').innerText()).slice(-2200));
  throw error;
} finally {await browser.close();await server.close();}
