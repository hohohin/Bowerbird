import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
const root=resolve(`.tmp/video-replication/native-${Date.now()}`);
await mkdir(root,{recursive:true});
const server=createServer((request,response)=>{
  response.setHeader('Content-Type','text/html; charset=utf-8');
  response.end(`<script>window._ROUTER_DATA={aweme_detail:{aweme_id:'9999999999999999',video:{play_addr:{url_list:['https://v1.douyinvod.com/wrong']}}}};setTimeout(()=>{window._ROUTER_DATA={aweme_detail:{aweme_id:'1234567890123456',desc:'目标作品',video:{duration:5000,play_addr:{url_list:['https://v1.douyinvod.com/target']}}}}},1100)</script>`);
});
await new Promise(resolve=>server.listen(1660,'127.0.0.1',resolve));
try {
  const child=spawn(resolve('src-tauri/target/debug/examples/replication_browser_smoke.exe'),[],{windowsHide:true,env:{...process.env,BOWERBIRD_REPLICATION_TEST_ROOT:root},stdio:'pipe'});
  let log='';child.stderr.on('data',chunk=>log+=chunk);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});
  assert.equal(code,0,log);
  const result=JSON.parse(await readFile(resolve(root,'result.json'),'utf8'));
  assert.equal(result.videoId,'1234567890123456');assert.equal(result.name,'目标作品');
  assert.deepEqual(result.urls,['https://v1.douyinvod.com/target']);
  console.log('PASS hidden WebView2 extraction, target identity and blocked custom-navigation result transport');
} finally {await new Promise(resolve=>server.close(resolve));}
