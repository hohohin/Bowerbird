// A usable Lens page must not wait for an unrelated image's full-page load.
// Real native commands and WebView2, synthetic routes and isolated library/profile.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from '../../html-renderer/node_modules/playwright/index.mjs';

const directory=path.resolve('.tmp/pinterest-loading-native-'+Date.now());
await mkdir(directory,{recursive:true});
const executable=path.resolve(process.argv[2]||'src-tauri/target/debug/examples/pinterest_search_smoke.exe');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Qy4AAAAASUVORK5CYII=','base64');
const html=`<!doctype html><html><head><title>Lens ready, image pending</title></head><body>
<script id="__PWS_DATA__" type="application/json">{"context":{"is_authenticated":true}}</script>
<button aria-label="Lens" onclick="showUploader()">Lens</button><div id="uploader"></div>
<script>
window.received=[];window.loadFired=false;
window.addEventListener('load',()=>window.loadFired=true);
window.showUploader=()=>{
 document.querySelector('#uploader').innerHTML='<input id="lens-file-upload" data-test-id="lens-file-upload" type="file" accept="image/*">';
 document.querySelector('#lens-file-upload').addEventListener('change',async event=>{
  const file=event.target.files[0];if(!file)return;
  window.received.push({name:file.name,type:file.type,bytes:Array.from(new Uint8Array(await file.arrayBuffer()))});
  history.pushState({},'', '/lens-search/?synthetic=loading');
 });
};
</script><img id="pending-image" alt="Unrelated pending image" src="/never-finishes.png"></body></html>`;
const server=createServer((_,res)=>{res.setHeader('content-type','text/html');res.end('<body>isolated native fixture</body>');});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(1557,'127.0.0.1',resolve);});
let child,browser,sourceBrowser,main,source,diagnostic='';
const releases=[];const unexpected=[];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function poll(check,message,timeout=12000){
  const until=Date.now()+timeout;
  while(Date.now()<until){
    if(child?.exitCode!=null)throw new Error('native fixture exited '+child.exitCode+': '+diagnostic);
    const value=await check().catch(()=>null);if(value)return value;await pause(100);
  }
  throw new Error(message);
}
async function snapshot(){
  return {page:await source.evaluate(()=>({url:location.href,readyState:document.readyState,loadFired:window.loadFired,
    lensReady:!!document.querySelector('button[aria-label="Lens"]')&&typeof window.showUploader==='function',
    pendingImageComplete:document.querySelector('#pending-image')?.complete,received:window.received?.length})),
    events:await main.evaluate(()=>window.searchEvents)};
}
try{
  child=spawn(executable,[],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,BOWERBIRD_PINTEREST_TEST_ROOT:directory,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:''}});
  child.stderr.on('data',value=>diagnostic+=value);
  browser=await poll(()=>chromium.connectOverCDP('http://127.0.0.1:9567',{timeout:1000}),'main CDP unavailable');
  main=await poll(async()=>browser.contexts()[0].pages().find(page=>page.url().startsWith('http://127.0.0.1:1557')),'main page unavailable');
  await main.waitForFunction(()=>window.__TAURI_INTERNALS__?.invoke,{},{timeout:10000});
  await main.evaluate(async()=>{
    window.searchEvents=[];
    const handler=window.__TAURI_INTERNALS__.transformCallback(event=>window.searchEvents.push(event.payload));
    await window.__TAURI_INTERNALS__.invoke('plugin:event|listen',{event:'source-browser://pinterest-search',target:{kind:'Any'},handler});
    await window.__TAURI_INTERNALS__.invoke('open_source_browser',{url:'http://127.0.0.1:1557/source',bounds:{x:250,y:100,width:800,height:600}});
  });
  sourceBrowser=await poll(()=>chromium.connectOverCDP('http://127.0.0.1:9568',{timeout:1000}),'source CDP unavailable');
  source=await poll(async()=>sourceBrowser.contexts()[0].pages().find(page=>page.url().includes('/source')),'source page unavailable');
  await source.context().route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.hostname==='www.pinterest.com'){
      if(url.pathname==='/never-finishes.png'){
        await new Promise(resolve=>releases.push(resolve));
        return route.fulfill({contentType:'image/png',body:png}).catch(()=>{});
      }
      return route.fulfill({contentType:'text/html',body:html});
    }
    if(url.hostname==='127.0.0.1')return route.continue();
    unexpected.push(url.href);return route.abort();
  });
  const assetId=await main.evaluate(()=>window.__TAURI_INTERNALS__.invoke('smoke_asset'));
  const requestId='lens-ready-before-load';
  await main.evaluate(args=>window.__TAURI_INTERNALS__.invoke('start_pinterest_image_search',args),{assetId,requestId});
  await poll(async()=>releases.length&&await source.locator('button[aria-label="Lens"]').isVisible(),'synthetic Lens never became ready');
  const initial=await snapshot();
  assert.equal(initial.page.lensReady,true);
  assert.equal(initial.page.loadFired,false);
  assert.equal(initial.page.pendingImageComplete,false);
  const submitted=()=>main.evaluate(requestId=>window.searchEvents.some(event=>event.requestId===requestId&&event.status==='submitted'),requestId);
  let failure;
  try{await poll(submitted,'Lens was ready but native search stayed preparing while the image blocked load',7000);}catch(error){failure=error;}
  const beforeRelease=await snapshot();
  if(failure){
    // A diagnostic control proves the blocked load is the cause, not bad Lens markup.
    releases.splice(0).forEach(release=>release());
    let afterRelease;
    try{await poll(submitted,'search did not finish after the unrelated resource was released',7000);afterRelease=await snapshot();}
    catch(error){afterRelease={error:error.message,...await snapshot()};}
    const evidence={ok:false,executable,directory,initial,beforeRelease,afterRelease,unexpected};
    await writeFile(path.join(directory,'result.json'),JSON.stringify(evidence,null,2));
    console.error(JSON.stringify(evidence));
    throw failure;
  }
  assert.equal(beforeRelease.page.loadFired,false,'the result must arrive before full-page load');
  assert.equal(beforeRelease.page.pendingImageComplete,false);
  assert.equal(beforeRelease.page.received,1);
  assert.match(beforeRelease.page.url,/\/lens-search\//);
  const file=await source.evaluate(()=>window.received[0]);
  assert.equal(file.type,'image/png');assert.deepEqual(file.bytes.slice(0,8),[137,80,78,71,13,10,26,10]);
  assert.deepEqual(unexpected,[]);
  const evidence={ok:true,executable,directory,initial,beforeRelease,unexpected};
  await writeFile(path.join(directory,'result.json'),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence));
}finally{
  releases.splice(0).forEach(release=>release());
  if(child&&child.exitCode==null&&main){
    const exited=new Promise(resolve=>child.once('exit',resolve));
    await main.evaluate(()=>window.__TAURI_INTERNALS__.invoke('smoke_exit')).catch(()=>{});
    await Promise.race([exited,pause(2000)]);
  }
  if(child&&child.exitCode==null)await new Promise(resolve=>spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}).on('exit',resolve));
  await browser?.close().catch(()=>{});await sourceBrowser?.close().catch(()=>{});
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
