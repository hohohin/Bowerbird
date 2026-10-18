import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
const root=resolve(`.tmp/video-replication/native-${Date.now()}`);
// Live acquisition is opt-in: pass one user-supplied HTTPS Douyin URL.
const liveUrl=process.argv[2];
await mkdir(root,{recursive:true});
const server=createServer(async (request,response)=>{
  if(request.url==='/video.mp4') {
    try { const bytes=await readFile(resolve(root,'video.mp4'));response.writeHead(200,{'Content-Type':'video/mp4','Content-Length':bytes.length});response.end(bytes); }
    catch { response.writeHead(404);response.end(); } return;
  }
  response.setHeader('Content-Type','text/html; charset=utf-8');
  if(request.url==='/player') {response.end('<video src="/video.mp4" muted controls></video>');return;}
  response.end(`<script>window._ROUTER_DATA={aweme_detail:{aweme_id:'9999999999999999',video:{play_addr:{url_list:['https://v1.douyinvod.com/wrong']}}}};setTimeout(()=>{window._ROUTER_DATA={aweme_detail:{aweme_id:'1234567890123456',desc:'目标作品',video:{duration:5000,play_addr:{url_list:['https://v1.douyinvod.com/target']}}}}},1100)</script>`);
});
await new Promise(resolve=>server.listen(1660,'127.0.0.1',resolve));
try {
  const env={...process.env,BOWERBIRD_REPLICATION_TEST_ROOT:root};
  delete env.BOWERBIRD_REPLICATION_TEST_URL;
  if(liveUrl) env.BOWERBIRD_REPLICATION_TEST_URL=liveUrl;
  const child=spawn(resolve('src-tauri/target/debug/examples/replication_browser_smoke.exe'),[],{windowsHide:true,env,stdio:'pipe'});
  let log='';child.stderr.on('data',chunk=>log+=chunk);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});
  assert.equal(code,0,log);
  const result=JSON.parse(await readFile(resolve(root,'result.json'),'utf8'));
  if(liveUrl) {
    const download=JSON.parse(await readFile(resolve(root,'download.json'),'utf8'));
    assert.equal(download.success,true);assert.ok(download.bytes>0);
    const media=JSON.parse(await readFile(resolve(root,'media-state.json'),'utf8'));
    assert.ok(media.length>0,'live page should contain a player');
    assert.ok(media.every(v=>v.paused && v.time===0),'acquisition page must not play in the background');
    const {chromium}=await import('../../html-renderer/node_modules/playwright/index.mjs');
    const browser=await chromium.launch({channel:'chrome',headless:true});
    try {
      const page=await browser.newPage();await page.goto('http://127.0.0.1:1660/player');
      await page.waitForFunction(()=>{const v=document.querySelector('video');return v.readyState>=2&&v.videoWidth>0&&v.duration>0&&v.duration<=120;});
      const meta=await page.locator('video').evaluate(async v=>{await v.play();return {duration:v.duration,width:v.videoWidth,height:v.videoHeight};});
      await page.waitForFunction(()=>document.querySelector('video').currentTime>0.2);
      assert.ok(Math.abs(meta.duration-result.duration)<0.25);
      console.log('PASS live native acquisition and playback',JSON.stringify({videoId:result.videoId,bytes:download.bytes,...meta}));
    } finally {await browser.close();}
  } else {
  assert.equal(result.videoId,'1234567890123456');assert.equal(result.name,'目标作品');
  assert.deepEqual(result.urls,['https://v1.douyinvod.com/target']);
  console.log('PASS hidden WebView2 extraction, target identity and blocked custom-navigation result transport');
  }
} finally {await new Promise(resolve=>server.close(resolve));}
