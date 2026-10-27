import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/library-subtle-motion/vite', server: {host:'127.0.0.1',port:17912,strictPort:true,hmr:false,watch:null} });
await server.listen();
const browser = await chromium.launch({channel:'chrome',headless:true});
const page = await browser.newPage({viewport:{width:1280,height:840}});
const errors=[]; page.on('pageerror', e=>errors.push(e.message));
await page.addInitScript(() => {
  window.entered=[];
  document.addEventListener('animationstart', e=>{if(e.animationName==='library-material-enter')window.entered.push(e.target.closest('[data-asset-id]')?.dataset.assetId)});
});
try {
  await mkdir('.tmp/library-subtle-motion',{recursive:true});
  for(const scene of ['home','project']) {
    await page.emulateMedia({reducedMotion:'no-preference',forcedColors:'none'});
    await page.goto(`http://127.0.0.1:17912/scripts/fixtures/${scene==='home'?'project-drop/preview.html?layout':'canvas-reference/preview.html?source-library'}`);
    if(scene==='project') {
      await page.waitForFunction(()=>document.querySelector('.canvas-workspace')?.getAttribute('aria-busy')==='false');
      await page.locator('.canvas-stage').focus(); await page.keyboard.press('Tab');
    }
    await page.locator('.categorized-library').waitFor();
    await page.evaluate(async()=>{
      window.mode=(await import('/src/lib/localFileMode.ts')).useLocalFileMode;
      const previous=window.__TAURI_INTERNALS__.invoke;
      const assets=Array.from({length:45},(_,i)=>({id:`motion-${i}`,name:`素材 ${i}.png`,ext:'png',source:'imported',store_path:`/motion-${i}.png`,thumb_path:'/src-tauri/resources/samples/preset-01.webp',width:300,height:220}));
      window.__TAURI_INTERNALS__.invoke=async(command,args={})=>{
        if(command==='material_catalog')return {tags:[{id:'motion',name:'设计参考',count:45,projectCount:45,description:''}],collections:[],prompts:[],tag_asset_ids:{motion:assets.map(a=>a.id)}};
        if(command==='material_catalog_assets')return assets;
        if(command==='file_colors')return [];
        if(command==='external_files_browse')return {path:'/pictures',parent:null,total:assets.length,entries:assets.map(a=>({path:a.store_path,name:a.name,directory:false,preview:a.thumb_path}))};
        return previous(command,args);
      };
      window.mode.getState().openBrowser();
    });
    await page.evaluate(()=>window.mode.getState().closeBrowser());
    const root=page.locator('.categorized-library');
    const card=root.locator('[data-asset-id="motion-0"]');
    await card.waitFor(); await page.waitForTimeout(700);
    assert.ok(await page.evaluate(()=>window.entered.includes('motion-0')),'visible cards enter');
    assert.equal(await page.evaluate(()=>window.entered.includes('motion-44')),false,'offscreen cards wait');
    assert.equal(await root.locator('.library-ambient-light').evaluate(el=>getComputedStyle(el).display),'none');
    assert.equal(await root.locator('.library-tactical-backdrop').evaluate(el=>getComputedStyle(el).pointerEvents),'none');
    assert.equal(await root.locator('.library-tactical-backdrop').evaluate(el=>getComputedStyle(el,'::before').animationName),'none','cross matrix stays static');
    assert.equal(await root.locator('.library-tactical-backdrop').evaluate(el=>getComputedStyle(el,'::before').maskSize),'96px 88px');
    const original=await card.evaluate(el=>({transform:el.style.transform,width:el.offsetWidth,height:el.offsetHeight}));
    await card.hover(); await page.waitForTimeout(220);
    assert.equal(await card.evaluate(el=>getComputedStyle(el).translate),'0px -5px');
    assert.deepEqual(await card.evaluate(el=>({transform:el.style.transform,width:el.offsetWidth,height:el.offsetHeight})),original,'hover preserves masonry geometry');
    const transfer=await page.evaluateHandle(()=>new DataTransfer());
    await card.dispatchEvent('dragstart',{dataTransfer:transfer});
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-asset-id="motion-0"]')).translate==='none');
    assert.equal(await card.evaluate(el=>getComputedStyle(el).translate),'none','drag removes hover offset');
    await card.dispatchEvent('dragend',{dataTransfer:transfer});await transfer.dispose();
    if(scene==='project') {await page.locator('.canvas-stage').focus();await page.keyboard.press('Tab');await page.waitForTimeout(350);}
    await root.locator('.library-view-switch button[aria-selected="true"]').hover();
    assert.equal(await root.locator('.library-view-switch').evaluate(el=>getComputedStyle(el,'::after').content),'none','glass sweep is removed');
    assert.equal(await root.locator('.library-view-switch-thumb').evaluate(el=>getComputedStyle(el).animationName),'library-tactical-control-contact');
    assert.equal(await root.locator('.library-view-switch-thumb').evaluate(el=>getComputedStyle(el).animationDuration),'0.16s');
    await page.mouse.move(5,5);
    await page.evaluate(()=>{window.firstMotionCard=document.querySelector('[data-asset-id="motion-0"]');window.entered=[];window.store.getState().setThumbnailWidth('library',180)});
    await page.waitForTimeout(700);
    assert.equal(await page.evaluate(()=>window.firstMotionCard===document.querySelector('[data-asset-id="motion-0"]')),true);
    assert.equal(await page.evaluate(()=>window.entered.includes('motion-0')),false,'resize does not replay existing cards');
    await root.locator('.catalog-scroller').evaluate(el=>el.scrollTop=el.scrollHeight);
    await page.waitForTimeout(700);
    assert.ok(await page.evaluate(()=>window.entered.includes('motion-44')),'scroll reveals new cards');
    await root.locator('.catalog-scroller').evaluate(el=>el.scrollTop=0);
    await page.waitForTimeout(150);
    await card.hover();
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'))});
    assert.equal(await root.getAttribute('data-library-motion-paused'),'true');
    assert.equal(await card.evaluate(el=>getComputedStyle(el,'::after').animationName),'none');
    assert.deepEqual(await card.evaluate(el=>getComputedStyle(el,'::after').backgroundPosition.split(',').map(point=>point.trim()).sort()),['0% 0%','0% 100%','100% 0%','100% 100%'],'hidden page leaves one marker at each corner');
    await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'))});
    assert.equal(await root.getAttribute('data-library-motion-paused'),'false');
    assert.ok(await card.evaluate(el=>getComputedStyle(el,'::after').animationName.includes('library-tactical-card-clockwise')));
    await page.mouse.move(5,5);
    if(scene==='project') { await page.setViewportSize({width:900,height:650}); await page.getByRole('separator',{name:'调整素材库宽度',exact:true}).focus();await page.keyboard.press('Home');await page.waitForTimeout(350); }
    for(const theme of ['light','dark']) {await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.waitForTimeout(250);await page.screenshot({path:`.tmp/library-subtle-motion/${scene}-${theme}.png`});}
    await page.emulateMedia({reducedMotion:'reduce'}); await card.hover();
    assert.equal(await root.locator('.library-ambient-light').evaluate(el=>getComputedStyle(el).display),'none');
    assert.equal(await card.evaluate(el=>getComputedStyle(el).translate),'none');
    await root.locator('.library-view-switch').hover();
    assert.equal(await root.locator('.library-view-switch-thumb').evaluate(el=>getComputedStyle(el).animationName),'none');
    await page.emulateMedia({reducedMotion:'no-preference',forcedColors:'active'});
    assert.equal(await root.locator('.library-tactical-backdrop').evaluate(el=>getComputedStyle(el).display),'none');
    await page.emulateMedia({reducedMotion:'no-preference',forcedColors:'none'});
    await page.evaluate(()=>window.mode.getState().openBrowser());
    const files=page.locator('.local-file-workspace');
    await files.locator('.folder-media-card').first().waitFor(); await page.waitForTimeout(700);
    const addressStyle = await page.locator('.folder-address').evaluate(el=>({radius:getComputedStyle(el).borderRadius,border:getComputedStyle(el).borderTopColor}));
    assert.equal(addressStyle.radius, scene === 'home' ? '0px' : '8px', 'home uses Tactical navigation; the canvas retains its restored rounded toolbar');
    if (scene === 'home') assert.equal(addressStyle.border, 'rgba(0, 0, 0, 0)');
    else assert.notEqual(addressStyle.border, 'rgba(0, 0, 0, 0)');
    assert.ok(await page.locator('.folder-navigation button').evaluateAll((elements, radius)=>elements.every(el=>getComputedStyle(el).borderRadius===radius), scene === 'home' ? '0px' : '7px'), 'navigation buttons follow their toolbar surface');
    assert.equal(await files.locator('.library-tactical-backdrop').count(),1);
    assert.equal(await files.locator('.library-tactical-backdrop').evaluate(el=>getComputedStyle(el,'::before').animationName),'none');
    await files.locator('.folder-media-card').first().hover();await page.waitForTimeout(220);
    assert.equal(await files.locator('.folder-media-card').first().evaluate(el=>getComputedStyle(el).translate),'0px -5px');
    await page.screenshot({path:`.tmp/library-subtle-motion/${scene}-files.png`});
    await page.setViewportSize({width:1280,height:840});
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: viewport-only entry, stable masonry and card identity, drag offset reset, static cross matrix, control flash and hidden-page final state, light/dark and narrow drawer, reduced motion and forced colors');
} catch(error) {await page.screenshot({path:'.tmp/library-subtle-motion/failure.png'});throw error;}
finally {await browser.close();await server.close();}
