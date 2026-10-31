import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
import { startBrowserDrag, finishBrowserDrag } from './fixtures/explorer/native-drag.mjs';
import { parseExplorerImage, EXPLORER_MIME } from '../src/lib/explorer.ts';

const clip=await readFile('src-tauri/tests/fixtures/media/fragmented.mp4');
const injection=(await readFile('src-tauri/src/commands/source_browser_drag.js','utf8')).replace('__BOWERBIRD_DRAG_BRIDGE__','bowerbird-explorer://fixture');
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
  for(const kind of ['video','source','overlay','poster-overlay','independent-image','css-disabled','blob','blob-with-source','hls','protected']) {
    const page=await browser.newPage({viewport:{width:900,height:650}});
    await page.addInitScript(()=>{window.notices=[];window.open=url=>{window.notices.push(url);return null;};});
    await page.addInitScript(await readFile('../extension/candidate-utils.js','utf8'));
    await page.addInitScript(await readFile('src/lib/explorerDragVisual.js','utf8'));
    await page.addInitScript(injection);
    await page.route('https://video.fixture/**',route=>{
      const path=new URL(route.request().url()).pathname;
      if(path.endsWith('.mp4'))return route.fulfill({contentType:'video/mp4',body:clip});
      if(path.endsWith('.png'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="blue"/></svg>'});
      if(path.endsWith('.m3u8'))return route.fulfill({contentType:'application/vnd.apple.mpegurl',body:'#EXTM3U'});
      return route.fulfill({contentType:'text/html',body:`<style>#card{position:relative;width:320px;height:180px}video,#mask{width:320px;height:180px}#mask{position:absolute;inset:0}#drop{position:absolute;left:450px;top:0;width:300px;height:300px}${kind==='css-disabled'?'video{-webkit-user-drag:none}':''}</style><div id="card"><video muted preload="metadata" poster="/poster.png" ${kind==='source'?'':`src="/${kind==='hls'?'stream.m3u8':'clip.mp4'}"`}>${['source','blob-with-source'].includes(kind)?'<source src="/clip.mp4" type="video/mp4">':''}</video>${kind==='overlay'?'<a id="mask" href="/watch/1"></a>':kind==='poster-overlay'?'<img id="mask" src="/poster.png">':''}</div>${kind==='independent-image'?'<div id="independent"><img src="/independent.png" style="position:absolute;left:0;top:0;width:160px;height:160px;z-index:2"></div>':''}<div id="drop"></div>`});
    });
    await page.goto('https://video.fixture/page');
    if(kind.startsWith('blob')) await page.evaluate(()=>{document.querySelector('video').src=URL.createObjectURL(new MediaSource());});
    if(!kind.startsWith('blob') && kind!=='hls') await page.waitForFunction(()=>document.querySelector('video').readyState>=1);
    if(kind==='protected') await page.evaluate(async()=>{
      const access=await navigator.requestMediaKeySystemAccess('org.w3.clearkey',[{initDataTypes:['cenc'],videoCapabilities:[{contentType:'video/mp4; codecs="avc1.42E01E"'}]}]);
      await document.querySelector('video').setMediaKeys(await access.createMediaKeys());
    });
    await page.evaluate(()=>{
      const drop=document.getElementById('drop');
      drop.addEventListener('dragover',event=>event.preventDefault());
      drop.addEventListener('drop',event=>{event.preventDefault();window.dropped={payload:event.dataTransfer.getData('application/x-bowerbird-explorer'),text:event.dataTransfer.getData('text/plain')};});
    });
    const {session,data}=await startBrowserDrag(page,100,90);
    await finishBrowserDrag(session,data,550,90);
    const result=await page.evaluate(()=>({dropped:window.dropped,notices:window.notices}));
    assert.ok(result.dropped?.payload,`${kind}: native video drag must carry the capture protocol`);
    const payload=JSON.parse(result.dropped.payload);
    if(kind==='independent-image') {
      assert.equal(payload.mediaKind,undefined,'an independent foreground image must not become the background video');
      assert.equal(payload.imageUrl,'https://video.fixture/independent.png');
      console.log(`${kind}: foreground image remains an image`);await page.close();continue;
    }
    assert.equal(payload.mediaKind,'video',`${kind}: poster never becomes the captured image`);
    assert.equal(payload.posterUrl,'https://video.fixture/poster.png');
    assert.equal(payload.blocked,kind==='protected'?'protected_video':undefined);
    assert.equal(payload.pageUrl,kind==='overlay'?'https://video.fixture/watch/1':'https://video.fixture/page');
    assert.match(payload.imageUrl,kind==='blob'?/^blob:https:\/\/video\.fixture\//:kind==='hls'?/\/stream\.m3u8$/:/\/clip\.mp4$/);
    assert.deepEqual(parseExplorerImage({getData:type=>type===EXPLORER_MIME?result.dropped.payload:''}),payload);
    assert.equal(result.dropped.text,'bowerbird-explorer:'+result.dropped.payload);
    const start=result.notices.find(url=>url.includes('/start?'));assert.ok(start);
    assert.equal(JSON.parse(new URL(start).searchParams.get('data')).mediaKind,'video');
    console.log(`${kind}: real VIDEO drag, media URL, poster-only visual, source page and notice passed`);
    await page.close();
  }
}finally{await browser.close();}
