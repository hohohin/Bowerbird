import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
const source=(await readFile(new URL('../src-tauri/src/commands/video_replication/douyin_capture.js',import.meta.url),'utf8')).replace('__EXPECTED_ID__','"1234567890123456"');
function setup() {
  const ticks=[];const location={href:'https://www.douyin.com/video/1234567890123456',pathname:'/video/1234567890123456'};
  const window={fetch:async()=>({url:'https://www.douyin.com/aweme/v1/web/aweme/detail/',clone:()=>({text:async()=>JSON.stringify(window.payload)})})};window.top=window;
  function XHR(){} XHR.prototype.open=function(){};
  const context={window,location,navigator:{userAgent:'test'},document:{getElementById:()=>null},XMLHttpRequest:XHR,URL,setInterval:fn=>(ticks.push(fn),1),clearInterval:()=>{}};
  runInNewContext(source,context);
  return {window,location,tick:()=>ticks.forEach(fn=>fn())};
}
test('observer ignores feed videos, preserves original URLs, and reports protected content',()=>{
  const state=setup();
  const detail={aweme_id:'9999999999999999',video:{duration:5000,play_addr:{url_list:['https://v1.douyinvod.com/video?mark=1']}}};
  state.window._ROUTER_DATA={detail};state.tick();assert.match(state.location.href,/^https:/);
  detail.aweme_id='1234567890123456';state.tick();
  const result=JSON.parse(new URL(state.location.href).searchParams.get('payload'));
  assert.deepEqual(result.urls,['https://v1.douyinvod.com/video?mark=1']);assert.equal(result.duration,5);
  assert.equal(state.window.__bbDouyinResult.videoId,result.videoId);
  const blocked=setup();blocked.window._ROUTER_DATA={...detail,images:[{}]};blocked.tick();
  assert.equal(JSON.parse(new URL(blocked.location.href).searchParams.get('payload')).blocked,'image');
});
test('observer reads the target detail response without generating any extra request',async()=>{
  const state=setup();state.window.payload={aweme_detail:{aweme_id:'1234567890123456',video:{drm_type:1}}};
  await state.window.fetch('unchanged');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(JSON.parse(new URL(state.location.href).searchParams.get('payload')).blocked,'protected');
});

test('native response delivery still works after the page replaces fetch',()=>{
  const state=setup();state.window.fetch=async()=>({});
  state.window.__bbDouyinInspect({aweme_detail:{aweme_id:'9999999999999999',video:{play_addr:{url_list:['https://v1.douyinvod.com/wrong']}}}});
  assert.equal(state.window.__bbDouyinResult,undefined);
  state.window.__bbDouyinInspect({aweme_detail:{aweme_id:'1234567890123456',video:{duration:10100,play_addr:{url_list:['https://v1.douyinvod.com/original']}}}});
  assert.equal(state.window.__bbDouyinResult.videoId,'1234567890123456');
  assert.equal(state.window.__bbDouyinResult.duration,10.1);
});
