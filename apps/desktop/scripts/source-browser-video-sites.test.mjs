import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from '../../html-renderer/node_modules/playwright/index.mjs';
import {startBrowserDrag,finishBrowserDrag} from './fixtures/explorer/native-drag.mjs';

const script=await readFile(process.env.BOWERBIRD_SOURCE_VIDEO_PATH || 'src-tauri/src/commands/source_browser_video.js','utf8');
const browser=await chromium.launch({channel:'chrome',headless:true});
const failures=[];
const drag=(await readFile('src-tauri/src/commands/source_browser_drag.js','utf8')).replace('__BOWERBIRD_DRAG_BRIDGE__','bowerbird-explorer://fixture');
async function check(name,run){try{await run();console.log('PASS '+name);}catch(error){failures.push(name);console.error('FAIL '+name+': '+error.message);}}
async function fixture(url){
  const page=await browser.newPage();
  await page.addInitScript(script);
  await page.addInitScript(drag);
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<video id="target"></video>'}));
  await page.goto(url);
  await page.evaluate(()=>{target.src=URL.createObjectURL(new MediaSource());});
  return page;
}
async function resolve(page){return page.evaluate(async()=>{
  window.__bbSourceVideo.remember(target,target.src,location.href);
  return window.__bbSourceVideo.resolve(target.src,location.href);
});}
const xhsRecord={id:'note-a',note_card:{type:'video',video:{media:{stream:{h264:[{master_url:'https://cdn.example/right.mp4'}]}}}}};
const pinRecord={id:'123456789',videos:{video_list:{V_720P:{url:'https://cdn.example/right.mp4'}}}};
const pinGraphRecord=JSON.parse(await readFile('scripts/fixtures/explorer/pinterest-video-graphql.json','utf8'));
try{
  await check('Pinterest first-load Relay responses expose the complete MP4 beside legacy HLS',async()=>{
    const page=await fixture('https://www.pinterest.com/pin/123456789/');
    try{
      await page.evaluate(record=>{
        const response=pin=>({response:{data:{v3GetPinQueryv2:{data:pin}}}});
        const partial=structuredClone(record);partial.storyPinData.pages[0].blocks[0].videoDataV2.videoList720P=null;
        window.__PWS_INITIAL_PROPS__={initialReduxState:{pins:{'123456789':{id:'123456789',videos:{video_list:{V_HLS:{url:'https://cdn.example/right.m3u8'}}}}}}};
        window.__PWS_RELAY_SSR_REQUESTS__={summary:response(partial),complete:response(record),unrelated:response({...record,entityId:'987654321'})};
      },pinGraphRecord);
      assert.equal(await resolve(page),'https://cdn.example/right.mp4');
      await page.evaluate(()=>{const r=window.__PWS_RELAY_SSR_REQUESTS__;r.complete.response.data.v3GetPinQueryv2.data.entityId='987654321';});
      assert.equal(await resolve(page),'https://cdn.example/right.m3u8','unrelated Relay entities cannot supply this video');
    }finally{await page.close();}
  });
  await check('Pinterest GraphQL SPA response identifies the Pin entity and story video variants',async()=>{
    const page=await fixture('https://www.pinterest.com/');
    try{
      await page.route('**/_/graphql/',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({data:{v3GetPinQueryv2:{data:pinGraphRecord}}})}));
      await page.evaluate(async()=>{await(await fetch('/_/graphql/')).json();history.pushState({},'','/pin/123456789/');});
      assert.equal(await resolve(page),'https://cdn.example/right.mp4');
      await page.evaluate(()=>history.pushState({},'','/pin/987654321/'));
      await assert.rejects(resolve(page),/尚未找到/,'the GraphQL entity must belong to the current Pin');
    }finally{await page.close();}
  });
  await check('Pinterest GraphQL direct video and multi-video identity stay bounded',async()=>{
    const page=await fixture('https://www.pinterest.com/pin/123456789/');
    try{
      await page.evaluate(record=>{
        const video=record.storyPinData.pages[0].blocks[0].videoDataV2;
        window.__PWS_DATA__={pins:{[record.entityId]:{...record,storyPinData:null,videos:video}}};
      },pinGraphRecord);
      assert.equal(await resolve(page),'https://cdn.example/right.mp4');
      await page.evaluate(record=>{
        const other={videoDataV2:{videoListMobile:{vHLSV3MOBILE:{url:'https://cdn.example/other.m3u8',thumbnail:'https://cdn.example/other.jpg'}}}};
        record.storyPinData.pages[0].blocks.push(other);window.__PWS_DATA__={pins:{[record.entityId]:record}};
      },pinGraphRecord);
      await assert.rejects(resolve(page),/多个视频/);
      await page.evaluate(()=>{target.poster='https://cdn.example/other.jpg';});
      assert.equal(await resolve(page),'https://cdn.example/other.m3u8');
      await page.evaluate(()=>{window.__PWS_DATA__.pins['123456789'].entityId='987654321';});
      await assert.rejects(resolve(page),/尚未找到/,'the index cannot override an explicit different GraphQL entity');
    }finally{await page.close();}
  });
  for(const [site,origin,start,end,record] of [
    ['xhs','https://www.xiaohongshu.com','/explore','/explore/note-a',xhsRecord],
    ['pin','https://www.pinterest.com','/','/pin/123456789/',pinRecord],
  ]){
    await check(site+': compressed JSON XHR survives SPA navigation and unrelated responses',async()=>{
      const page=await fixture(origin+start);
      try{
        // Decoded body + compressed wire headers, just as the renderer sees it.
        await page.route('**/api/feed',route=>route.fulfill({headers:{'content-type':'application/json','content-encoding':'gzip','content-length':'40'},body:JSON.stringify({data:{items:[record]}})}));
        await page.route('**/analytics',route=>route.fulfill({contentType:'application/json',body:'{"ok":true}'}));
        await page.evaluate(async end=>{
          await new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('GET','/api/feed');xhr.responseType='json';xhr.onload=resolve;xhr.onerror=reject;xhr.send();});
          history.pushState({},'',end);
          for(let i=0;i<16;i++)await (await fetch('/analytics')).json();
        },end);
        assert.equal(await resolve(page),'https://cdn.example/right.mp4');
        await page.evaluate(()=>history.pushState({},'','/other'));
        assert.match(await page.evaluate(async end=>{try{return await window.__bbSourceVideo.resolve(target.src,location.origin+end);}catch(e){return e.message;}},end),/切换/);
      }finally{await page.close();}
    });
    await check(site+': response finishing after navigation still belongs to its explicit media ID',async()=>{
      const page=await fixture(origin+start);
      try{
        await page.route('**/api/feed',async route=>{await new Promise(r=>setTimeout(r,80));await route.fulfill({contentType:'application/json',body:JSON.stringify({data:{items:[record]}})});});
        await page.evaluate(async end=>{const request=fetch('/api/feed');history.pushState({},'',end);await (await request).json();},end);
        assert.equal(await resolve(page),'https://cdn.example/right.mp4');
      }finally{await page.close();}
    });
  }
  await check('missing length JSON and snake case note wrapper',async()=>{
    const page=await fixture('https://www.xiaohongshu.com/search_result/note-a');
    try{
      await page.route('**/api/feed',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({data:{items:[xhsRecord]}})}));
      await page.evaluate(async()=>{await new Promise(resolve=>{const xhr=new XMLHttpRequest();xhr.open('GET','/api/feed');xhr.responseType='json';xhr.onload=resolve;xhr.send();});});
      assert.equal(await resolve(page),'https://cdn.example/right.mp4');
    }finally{await page.close();}
  });
  await check('partial feed metadata preserves the current note full source',async()=>{
    const page=await fixture('https://www.xiaohongshu.com/explore/note-a');
    try{
      await page.evaluate(record=>{window.__INITIAL_STATE__={note:{noteDetailMap:{'note-a':{note:record.note_card}}}};},xhsRecord);
      await page.route('**/api/feed',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({id:'note-a',note_card:{video:{capa:{duration:10}}}})}));
      await page.evaluate(async()=>{await(await fetch('/api/feed')).json();});
      assert.equal(await resolve(page),'https://cdn.example/right.mp4');
    }finally{await page.close();}
  });
  for(const site of ['xhs','pin'])await check(site+': indexed video survives a large reactive application state',async()=>{
    const page=await fixture(site==='xhs'?'https://www.xiaohongshu.com/explore/note-a':'https://www.pinterest.com/pin/123456789/');
    try{
      await page.evaluate(({site,xhsRecord,pinRecord})=>{
        const noise=Object.fromEntries(Array.from({length:100},(_,i)=>['r'+i,{dep:{subs:Array.from({length:100},()=>({sub:{active:true}}))}}]));
        const ref=value=>({__v_isRef:true,dep:noise,value});
        if(site==='xhs')window.__INITIAL_STATE__={global:noise,note:ref({noteDetailMap:ref({'note-a':{note:xhsRecord.note_card}})})};
        else window.__PWS_DATA__={context:noise,props:{initialReduxState:{pins:{[pinRecord.id]:pinRecord}}}};
      },{site,xhsRecord,pinRecord});
      assert.equal(await resolve(page),'https://cdn.example/right.mp4');
    }finally{await page.close();}
  });
  await check('Xiaohongshu live API codec groups use EF keys, not codec names',async()=>{
    const page=await fixture('https://www.xiaohongshu.com/explore/note-a');
    try{
      await page.evaluate(()=>{
        window.__INITIAL_STATE__={note:{noteDetailMap:{'note-a':{note:{noteId:'note-a',video:{media:{stream:{
          EF7:[],EF4:[{videoCodec:'EF4',masterUrl:'https://cdn.example/right.mp4'}],EF5:[{videoCodec:'EF5',masterUrl:'https://cdn.example/hevc.mp4'}],EF6:[],
        }}}}}}}};
      });
      assert.equal(await resolve(page),'https://cdn.example/right.mp4');
    }finally{await page.close();}
  });
  await check('Pinterest sibling permalink identifies only the dragged card',async()=>{
    const page=await fixture('https://www.pinterest.com/search/pins/?q=origami');
    try{
      await page.evaluate(record=>{
        document.body.innerHTML='<style>video{width:320px;height:180px;background:#333}#drop{position:absolute;left:500px;top:0;width:300px;height:300px}</style><div data-test-id="pinWrapper"><a href="/pin/origami--123456789/">link</a><div><video id="target"></video></div></div><div data-test-id="pinWrapper"><a href="/pin/987654321/">other</a></div><div id="drop"></div>';
        target.src=URL.createObjectURL(new MediaSource());
        window.__PWS_DATA__={pins:{[record.id]:record}};
        drop.addEventListener('dragover',event=>event.preventDefault());
        drop.addEventListener('drop',event=>{event.preventDefault();window.payload=JSON.parse(event.dataTransfer.getData('application/x-bowerbird-explorer'));});
      },pinRecord);
      const {session,data}=await startBrowserDrag(page,100,90);
      await finishBrowserDrag(session,data,550,90);
      assert.equal(await page.evaluate(async()=>{
        return window.__bbSourceVideo.resolve(window.payload.imageUrl,window.payload.pageUrl);
      }),'https://cdn.example/right.mp4');
      assert.equal(await page.evaluate(()=>window.payload.pageUrl),'https://www.pinterest.com/pin/origami--123456789/');
    }finally{await page.close();}
  });
  await check('unrelated note and oversized JSON never supply this video',async()=>{
    const page=await fixture('https://www.xiaohongshu.com/explore/note-a');
    try{
      await page.evaluate(record=>{window.__INITIAL_STATE__={note:{noteDetailMap:{'note-a':{note:{...record.note_card,noteId:'note-b'}}}}};},xhsRecord);
      await assert.rejects(resolve(page),/尚未找到/,'an indexed entry cannot override a conflicting explicit note ID');
      await page.route('**/api/feed',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({data:{items:[{...xhsRecord,id:'note-b'}]}})}));
      await page.evaluate(async()=>{await(await fetch('/api/feed')).json();});
      await assert.rejects(resolve(page),/尚未找到/);
      await page.route('**/api/feed',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({record:xhsRecord,padding:'x'.repeat(1024*1024)})}));
      await page.evaluate(async()=>{await new Promise(resolve=>{const xhr=new XMLHttpRequest();xhr.open('GET','/api/feed');xhr.responseType='json';xhr.onload=resolve;xhr.send();});});
      await assert.rejects(resolve(page),/尚未找到/);
      const payload={record:xhsRecord,padding:''};
      payload.padding='x'.repeat(1024*1024-JSON.stringify(payload).length);
      await page.route('**/api/feed',route=>route.fulfill({contentType:'application/json',body:JSON.stringify(payload)}));
      await page.evaluate(async()=>{await new Promise(resolve=>{const xhr=new XMLHttpRequest();xhr.open('GET','/api/feed');xhr.responseType='json';xhr.onload=resolve;xhr.send();});});
      assert.equal(await resolve(page),'https://cdn.example/right.mp4','the decoded JSON size limit is inclusive');
    }finally{await page.close();}
  });
}finally{await browser.close();}
assert.deepEqual(failures,[],'site video regression failures');
