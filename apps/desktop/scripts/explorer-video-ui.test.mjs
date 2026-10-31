import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
import { startBrowserDrag, finishBrowserDrag } from './fixtures/explorer/native-drag.mjs';

const server=await createServer({cacheDir:'.tmp/explorer-video/vite',server:{host:'127.0.0.1',port:1768,strictPort:true,hmr:false,watch:null}});
await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1800,height:1000},reducedMotion:'reduce'});
const clip=await readFile('src-tauri/tests/fixtures/media/fragmented.mp4');
const poster='<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="blue"/></svg>';
const mediaRequests=[];
await context.route('https://video.fixture/**',route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('.mp4')){mediaRequests.push(route.request().resourceType());return route.fulfill({contentType:'video/mp4',body:clip});}
  if(path.endsWith('.png'))return route.fulfill({contentType:'image/svg+xml',body:poster});
  return route.fulfill({contentType:'text/html',body:'<video muted preload="metadata" src="/clip.mp4" poster="/poster.png" style="width:320px;height:180px"></video><div id="drop" style="position:absolute;left:450px;top:0;width:300px;height:300px"></div>'});
});
const source=await context.newPage(),page=await context.newPage();
page.setDefaultTimeout(10000);
const errors=[];page.on('pageerror',error=>errors.push(error.message));
await source.addInitScript(await readFile('../extension/candidate-utils.js','utf8'));
await source.addInitScript(await readFile('src/lib/explorerDragVisual.js','utf8'));
await source.addInitScript(await readFile('src-tauri/src/commands/source_browser_drag.js','utf8'));
async function payload(){
  const {session,data}=await startBrowserDrag(source,100,90);
  await finishBrowserDrag(session,data,550,90);
  const value=JSON.parse(data.items.find(item=>item.mimeType==='application/x-bowerbird-explorer').data);
  assert.equal(value.mediaKind,'video');return data;
}
async function drop(selector){
  const data=await payload();
  const point=await page.locator(selector).evaluate(element=>{
    const rect=element.getBoundingClientRect(),clientX=Math.floor(rect.left+rect.width*.5),clientY=Math.floor(rect.top+rect.height*.45);
    const plane=document.querySelector('.canvas-plane'),matrix=plane?new DOMMatrix(getComputedStyle(plane).transform):null;
    return {clientX,clientY,...(matrix?{x:(clientX-rect.left-matrix.e)/matrix.a,y:(clientY-rect.top-matrix.f)/matrix.d}:{})};
  });
  const session=await context.newCDPSession(page);
  for(const type of ['dragEnter','dragOver','drop'])await session.send('Input.dispatchDragEvent',{type,data,x:point.clientX,y:point.clientY});
  await session.detach();return point;
}
const captures=()=>page.evaluate(()=>window.calls.filter(call=>call.command==='capture_source_browser_image'));
const nodes=()=>page.evaluate(()=>window.snapshot().nodes.filter(node=>node.assetId==='collected'));
const settled=()=>page.locator('.explore-capture-status').waitFor({state:'detached'});
const atPoint=(node,point)=>{
  assert.ok(Math.abs(node.x+node.width/2-point.x)<.01);assert.ok(Math.abs(node.y+node.height/2-point.y)<.01);assert.equal(node.projectId,'p');
};
try {
  await mkdir('.tmp/explorer-video',{recursive:true});
  await source.goto('https://video.fixture/page');await source.waitForFunction(()=>document.querySelector('video').readyState>=1);
  const dimensions=await source.locator('video').evaluate(video=>({width:video.videoWidth,height:video.videoHeight,duration:video.duration}));
  await page.goto('http://127.0.0.1:1768/scripts/fixtures/canvas-reference/preview.html?explorer');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(dimensions=>{
    const invoke=window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke=async(command,args)=>{
      const result=await invoke(command,args);
      if(command==='capture_source_browser_image')return Object.assign(result,{...dimensions,ext:'mp4',name:'拖入视频',source_url:args.pageUrl,store_path:'https://video.fixture/clip.mp4',thumb_path:'https://video.fixture/poster.png'});
      return result;
    };
  },dimensions);
  const first=await drop('[data-canvas-stage]');
  await page.waitForFunction(()=>window.calls.some(call=>call.command==='capture_source_browser_image'));await settled();
  assert.equal((await captures())[0].args.mediaKind,'video','capture must receive the actual video type');
  assert.equal((await captures())[0].args.imageUrl,'https://video.fixture/clip.mp4','poster must never be saved instead of video');
  assert.equal(await page.evaluate(()=>window.calls.filter(call=>['claim_source_browser_analysis','finish_source_browser_analysis','release_source_browser_analysis'].includes(call.command)).length),0,'videos never enter image classification');
  let saved=await nodes();assert.equal(saved.length,1);atPoint(saved[0],first);
  assert.equal(JSON.parse(saved[0].payloadJson).snapshot.width,dimensions.width);
  assert.equal(JSON.parse(saved[0].payloadJson).snapshot.height,dimensions.height);
  assert.ok(Math.abs((saved[0].height-32)/(saved[0].width-2)-dimensions.height/dimensions.width)<.01,'video aspect ratio determines canvas geometry');
  await page.evaluate(()=>{window.holdCapture=true;});
  const second=await drop('[data-canvas-stage]');await page.waitForFunction(()=>window.releaseCapture);
  await page.getByRole('button',{name:'放大',exact:true}).click();
  await page.evaluate(()=>{window.holdCapture=false;window.releaseCapture();window.releaseCapture=null;});await settled();
  saved=await nodes();assert.equal(saved.length,2);atPoint(saved[1],second);assert.notEqual(saved[0].id,saved[1].id);
  await page.evaluate(()=>{window.holdCapture=true;});
  const third=await drop('[data-canvas-stage]');await page.waitForFunction(()=>window.releaseCapture);
  await page.evaluate(()=>window.store.setState({activeProjectId:'q',projectRouteRevision:1}));
  await page.locator('[data-canvas-node-id="old"]').waitFor({state:'detached'});
  await page.evaluate(()=>{window.holdCapture=false;window.releaseCapture();window.releaseCapture=null;});await settled();
  saved=await nodes();assert.equal(saved.length,3);atPoint(saved[2],third);
  assert.equal(await page.locator(`[data-canvas-node-id="${saved[2].id}"]`).count(),0,'late video remains in the original project');
  assert.equal((await captures())[2].args.projectId,'p');
  await page.screenshot({path:'.tmp/explorer-video/project-isolation.png'});
  await page.goto('http://127.0.0.1:1768/scripts/fixtures/explorer/preview.html');
  await page.getByRole('button',{name:'探索',exact:true}).click();
  await page.evaluate(dimensions=>{
    const invoke=window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke=async(command,args)=>{
      const result=await invoke(command,args);
      if(command==='capture_source_browser_image')Object.assign(result,{...dimensions,ext:'mp4',store_path:'https://video.fixture/clip.mp4',thumb_path:'https://video.fixture/poster.png'});
      return result;
    };
  },dimensions);
  await drop('[aria-label="探索采集素材"]');await settled();
  assert.equal((await captures()).length,1,'dropping into the library captures immediately without a picker');
  assert.equal((await captures())[0].args.mediaKind,'video');
  assert.equal((await captures())[0].args.projectId,null);
  assert.equal(await page.getByRole('dialog').count(),0);
  assert.equal(await page.evaluate(()=>window.calls.some(call=>call.command==='claim_source_browser_analysis')),false);
  assert.equal(await page.evaluate(()=>window.store.getState().assets[0].ext),'mp4');
  await source.evaluate(async()=>{
    const access=await navigator.requestMediaKeySystemAccess('org.w3.clearkey',[{initDataTypes:['cenc'],videoCapabilities:[{contentType:'video/mp4; codecs="avc1.42E01E"'}]}]);
    await document.querySelector('video').setMediaKeys(await access.createMediaKeys());
  });
  await drop('[aria-label="探索采集素材"]');
  await page.getByText('该视频受播放保护，暂不支持采集',{exact:true}).waitFor();
  assert.equal((await captures()).length,1,'protected video is rejected before capture');
  assert.equal(await page.evaluate(()=>window.calls.some(call=>call.command==='claim_source_browser_analysis')),false);
  assert.equal(mediaRequests.includes('image'),false,'neither source nor workspace loads the video URL as a poster image');
  assert.deepEqual(errors,[]);
  console.log('PASS source-generated video drag -> real explorer library/canvas; no image analysis, video geometry, frozen zoom/project, separate instances, no picker or poster ingestion');
}finally{await browser.close();await server.close();}
