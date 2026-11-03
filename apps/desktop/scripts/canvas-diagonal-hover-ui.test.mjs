import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium} from '../../html-renderer/node_modules/playwright/index.mjs';
const server=await createServer({cacheDir:'.tmp/diagonal-hover/vite',server:{host:'127.0.0.1',port:17959,strictPort:true,hmr:false,watch:null}}); await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1280,height:900}}); page.setDefaultTimeout(10000);
try {
 await page.goto('http://127.0.0.1:17959/scripts/fixtures/canvas-reference/preview.html');
 const node=page.locator('[data-canvas-node-id="old"]'), img=node.locator(':scope > img'); await img.waitFor();
 await node.hover();
 const mark=node.locator('.media-hover-mark'); await mark.waitFor();
 const samples=await mark.evaluate(el=>{
  const animations=el.getAnimations({subtree:true});
  return [270,308,346,383,420].map(t=>{animations.forEach(a=>{a.pause();a.currentTime=t});return getComputedStyle(el,'::before').opacity;});
 });
 assert.deepEqual(samples,['0.15','1','0.15','1','1']);
 for(const scale of [0.5,1,2]) {
  await node.locator('xpath=ancestor::*[contains(@class,"canvas-plane")][1]').evaluate((el,s)=>el.style.transform=`scale(${s})`,scale);
  await page.waitForTimeout(40);
  const geometry=await mark.evaluate(el=>{const r=el.getBoundingClientRect(),img=el.parentElement.querySelector('img'),i=img.getBoundingClientRect();const fit=Math.min(i.width/img.naturalWidth,i.height/img.naturalHeight);return {width:r.width,height:r.height,w:img.naturalWidth*fit,h:img.naturalHeight*fit,dot:parseFloat(getComputedStyle(el,'::before').width)*(i.width/img.offsetWidth)};});
  assert.ok(Math.abs(geometry.width-geometry.w)<1 && Math.abs(geometry.height-geometry.h)<1,JSON.stringify(geometry));
  assert.ok(Math.abs(geometry.dot-4.8)<.1,JSON.stringify(geometry));
 }
 await page.emulateMedia({reducedMotion:'reduce'});
 assert.equal(await mark.locator('path').first().evaluate(el=>getComputedStyle(el).animationName),'none');
 assert.equal(await mark.evaluate(el=>getComputedStyle(el,'::before').animationName),'none');
 await page.mouse.move(10,10); await mark.waitFor({state:'detached'});
 console.log('PASS canvas shared diagonal hover: timing, painted bounds, zoom-independent points, reduced motion and exit');
}finally{await browser.close();await server.close();}
