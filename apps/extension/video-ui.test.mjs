import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "../html-renderer/node_modules/playwright/index.mjs";
const clip=await readFile(new URL("../desktop/src-tauri/tests/fixtures/media/fragmented.mp4",import.meta.url));
const icon=`data:image/png;base64,${(await readFile(new URL("icons/48x48.png",import.meta.url))).toString("base64")}`;
const scripts=await Promise.all(["candidate-utils.js","collection-utils.js","video-utils.js","content.js"].map(name=>readFile(new URL(name,import.meta.url),"utf8")));
await mkdir(new URL("../../.tmp/video-extension/",import.meta.url),{recursive:true});
const browser=await chromium.launch({channel:"chrome",headless:true});
const page=await browser.newPage({viewport:{width:900,height:720}});
const errors=[];page.on("pageerror",error=>errors.push(error.message));
await page.route("**/*",route=>{
  const url=route.request().url();
  if(url.endsWith(".mp4"))return route.fulfill({contentType:"video/mp4",body:clip});
  const xhs=url.includes("xiaohongshu");
  return route.fulfill({contentType:"text/html; charset=utf-8",body:xhs ? `<!doctype html><title>XHS fixture</title><script>window.__INITIAL_STATE__=${JSON.stringify({note:{noteDetailMap:{note123:{note:{type:"video",title:"笔记视频",video:{media:{stream:{h264:[{masterUrl:"https://cdn.fixture.test/xhs.mp4"}]}}}}}}}})}</script>`
    : '<!doctype html><title>Video fixture</title><video id="remote" title="演示视频" width="320" height="180"><source src="/clip.mp4" type="video/mp4"></video><video id="blob" title="页面文件视频" width="320" height="180"></video><meta property="og:video" content="https://fixture.test/extra.mp4"><script type="application/ld+json">{"@type":"VideoObject","contentUrl":"https://fixture.test/clip.mp4"}</script>'});
});
async function setup(url="https://fixture.test/page") {
  await page.goto(url);
  await page.evaluate(async icon=>{
    window.fixture={messages:[],uploads:[],fetches:[],support:true,pending:false};
    const fetch=window.fetch.bind(window);
    if(document.getElementById("blob")) {
      const blob=await (await fetch("/clip.mp4")).blob();
      document.getElementById("blob").src=URL.createObjectURL(blob);
    }
    window.fetch=(url,options)=>{window.fixture.fetches.push(url);return fetch(url,options);};
    window.chrome={runtime:{getURL:()=>icon,sendMessage:(message,callback)=>{
      window.fixture.messages.push(message);
      if(window.fixture.pending)window.fixture.reply=callback;else callback({ok:true,media_kind:message.type==="save_video"?"video":undefined});
    }}};
    window.WebSocket=class {
      constructor(){queueMicrotask(()=>this.onopen?.());}
      send(value){
        if(typeof value==="string") {
          this.metadata=JSON.parse(value);
          if(this.metadata.type==="ping")queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({ok:true,pong:true,...(window.fixture.support?{capabilities:{video_blob:true,video_max_bytes:209715200}}:{})})}));
        } else {
          window.fixture.uploads.push({...this.metadata,size:value.byteLength});
          queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({ok:true,asset_id:"video",media_kind:"video"})}));
        }
      }
      close(){this.onclose?.();}
    };
  },icon);
  for(const content of scripts)await page.addScriptTag({content});
}
const videoButton=page.getByRole("button",{name:"采集网页视频",exact:true});
const picker=page.getByRole("dialog",{name:"选择视频"});
const toast=page.locator("#__bowerbird_toast");
try {
  await setup();
  await videoButton.focus();await page.keyboard.press("Enter");
  await picker.waitFor();
  assert.equal(await picker.getByRole("button",{name:"采集视频",exact:true}).count(),3);
  assert.equal(await page.evaluate(()=>window.fixture.messages.length+window.fixture.uploads.length),0,'opening picker must not download videos');
  assert.match(await picker.innerText(),/演示视频/);
  await picker.getByRole("button",{name:"采集视频",exact:true}).first().click();
  await page.waitForFunction(()=>document.getElementById("__bowerbird_toast")?.textContent==="视频已保存到素材库");
  assert.equal(await page.evaluate(()=>window.fixture.messages[0].type),"save_video");
  assert.equal(await page.evaluate(()=>window.fixture.messages[0].pageUrl),"https://fixture.test/page");
  await page.evaluate(()=>{window.fixture.pending=true;document.getElementById("remote").dispatchEvent(new MouseEvent("click",{bubbles:true,altKey:true}));});
  await picker.getByRole("button",{name:"采集视频",exact:true}).click();
  await page.waitForFunction(()=>typeof window.fixture.reply==="function");
  assert.equal(await videoButton.isDisabled(),true);
  assert.equal(await videoButton.innerText(),"采集中");
  assert.match(await toast.innerText(),/请保持网页打开/);
  const pendingCount=await page.evaluate(()=>window.fixture.messages.length);
  await page.getByRole("button",{name:"采集网页图片",exact:true}).evaluate(el=>el.dispatchEvent(new MouseEvent("click",{bubbles:true})));
  await page.evaluate(()=>{window.fixture.reply({ok:false,saved:true,asset_id:"saved",media_kind:"video",code:"preview_unavailable"});window.fixture.pending=false;});
  await page.waitForFunction(()=>document.getElementById("__bowerbird_toast")?.textContent.includes("已保存，预览暂不可用"));
  assert.equal(await page.evaluate(()=>window.fixture.messages.length),pendingCount,'busy entry and preview failure never resubmit a saved video');
  await page.locator("#blob").evaluate(el=>el.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true,altKey:true})));
  await picker.getByRole("button",{name:"采集视频",exact:true}).click();
  await page.waitForFunction(()=>window.fixture.uploads.length===1);
  assert.deepEqual(await page.evaluate(()=>[window.fixture.uploads[0].media_kind,window.fixture.uploads[0].byte_length===window.fixture.uploads[0].size,window.fixture.uploads[0].page_url]),["video",true,"https://fixture.test/page"]);
  await page.waitForFunction(()=>!document.querySelector('[aria-label="采集网页视频"]').disabled);
  await page.evaluate(()=>{window.fixture.support=false;document.getElementById("blob").dispatchEvent(new MouseEvent("click",{bubbles:true,altKey:true}));});
  const before=await page.evaluate(()=>window.fixture.fetches.length);
  await picker.getByRole("button",{name:"采集视频",exact:true}).click();
  await page.waitForFunction(()=>document.getElementById("__bowerbird_toast")?.textContent.includes("更新并重启"));
  assert.equal(await page.evaluate(()=>window.fixture.fetches.length),before,'old desktop must be rejected before reading the large blob');
  await page.evaluate(()=>{
    window.fixture.support=true;
    const video=document.createElement("video");video.id="stream";video.src="https://fixture.test/stream.m3u8";document.body.append(video);
    video.dispatchEvent(new MouseEvent("click",{bubbles:true,altKey:true}));
  });
  await picker.getByRole("button",{name:"采集视频",exact:true}).click();
  await page.waitForFunction(()=>document.getElementById("__bowerbird_toast")?.textContent.includes("分段播放"));
  await page.evaluate(()=>{const video=document.getElementById("stream");video.src=URL.createObjectURL(new MediaSource());video.dispatchEvent(new MouseEvent("click",{bubbles:true,altKey:true}));});
  await picker.getByRole("button",{name:"采集视频",exact:true}).click();
  await page.waitForFunction(()=>document.getElementById("__bowerbird_toast")?.textContent.includes("分段播放"));
  await page.getByRole("button",{name:"采集网页图片",exact:true}).evaluate(el=>{
    const dataTransfer=new DataTransfer();dataTransfer.setData("text/html",'<video src="https://fixture.test/drop.mp4"></video>');
    el.dispatchEvent(new DragEvent("drop",{bubbles:true,cancelable:true,dataTransfer}));
  });
  await picker.waitFor();
  assert.equal(await picker.getByRole("button",{name:"采集视频",exact:true}).count(),1);
  await page.setViewportSize({width:420,height:720});
  await page.screenshot({path:new URL("../../.tmp/video-extension/picker.png",import.meta.url).pathname.slice(1)});
  await setup("https://www.xiaohongshu.com/explore/note123");
  await videoButton.click();await picker.waitFor();
  await picker.getByText("笔记视频",{exact:true}).waitFor();
  await picker.getByRole("button",{name:"采集视频",exact:true}).click();
  await page.waitForFunction(()=>window.fixture.messages.length===1);
  assert.equal(await page.evaluate(()=>window.fixture.messages[0].url),"https://cdn.fixture.test/xhs.mp4");
  assert.equal(await page.evaluate(()=>window.fixture.messages[0].pageUrl),"https://www.xiaohongshu.com/explore/note123");
  assert.deepEqual(errors,[]);
  console.log("PASS: video picker, explicit single download, VIDEO/source/metadata/XHS, real blob bytes, old desktop, MediaSource/HLS, Alt/drop, busy and saved-preview failure");
} finally {await browser.close();}
