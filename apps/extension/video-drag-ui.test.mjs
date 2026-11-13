import assert from "node:assert/strict";
import { dropData } from "./trusted-drag-fixture.mjs";
import { readFile } from "node:fs/promises";
import { chromium } from "../html-renderer/node_modules/playwright/index.mjs";

const clip=await readFile(new URL("../desktop/src-tauri/tests/fixtures/media/fragmented.mp4",import.meta.url));
const scripts=await Promise.all(["candidate-utils.js","collection-utils.js","video-utils.js","content.js"].map(name=>readFile(new URL(name,import.meta.url),"utf8")));
const browser=await chromium.launch({channel:"chrome",headless:true});
try {
  const page=await browser.newPage({viewport:{width:900,height:720}});
  const errors=[];page.on("pageerror",error=>errors.push(error.message));
  await page.route("**/*",route=>route.fulfill(route.request().url().endsWith(".mp4")
    ? {contentType:"video/mp4",body:clip}
    : {contentType:"text/html; charset=utf-8",body:'<!doctype html><video id="video" controls width="320" height="180" src="/clip.mp4"></video><img id="image" src="/image.svg" width="100" height="100">'}));
  await page.goto("https://fixture.test/page");
  await page.evaluate(()=>{
    window.fixture={messages:[],pending:false,dragStarts:0,clicks:[]};
    document.addEventListener("dragstart",()=>window.fixture.dragStarts++);
    document.getElementById("video").addEventListener("click",e=>window.fixture.clicks.push(e.defaultPrevented));
    window.chrome={runtime:{getURL:()=>"",sendMessage:(message,callback)=>{
      if (message.type === "button_position_get") { callback({position:null}); return; }
      if (message.type === "button_position_set") { callback({ok:true}); return; }
      if (message.type === "collect_access" || message.type === "collect_heartbeat") {
          callback({ok:true,protocols:["bowerbird-v1","fixture"]}); return;
        }
        window.fixture.messages.push(message);
      if(window.fixture.pending)window.fixture.reply=callback;
      else callback({ok:true,media_kind:message.type==="save_video"?"video":undefined});
    }}};
    window.WebSocket=class {constructor(){queueMicrotask(()=>this.onopen?.());}send(){queueMicrotask(()=>this.onmessage?.({data:'{"ok":true,"pong":true}'}));}close(){this.onclose?.();}};
  });
  for(const content of scripts)await page.addScriptTag({content});
  const target=page.getByRole("button",{name:"Bowerbird 采集菜单",exact:true});
  const video=page.locator("#video");
  const rect=await video.boundingBox();const drop=await target.boundingBox();
  assert.equal(await video.getAttribute("draggable"),null);
  await page.mouse.move(rect.x+100,rect.y+40);await page.mouse.down();
  assert.equal(await video.evaluate(el=>el.draggable),true,'a default VIDEO must become draggable on a primary press outside controls');
  await page.mouse.up();
  assert.equal(await video.getAttribute("draggable"),null,'ordinary click restores the original attribute');
  assert.deepEqual(await page.evaluate(()=>window.fixture.clicks),[false],'ordinary video click is not prevented');
  await page.mouse.move(rect.x+100,rect.y+rect.height-10);await page.mouse.down();
  assert.equal(await video.getAttribute("draggable"),null,'native control strip must keep its existing behavior');
  await page.mouse.up();
  await page.mouse.move(rect.x+100,rect.y+40);await page.mouse.down();
  await page.mouse.move(rect.x+120,rect.y+55,{steps:4});
  await page.mouse.move(drop.x+24,drop.y+24,{steps:15});await page.mouse.up();
  await page.waitForFunction(()=>window.fixture.messages.length===1);
  assert.equal(await page.evaluate(()=>window.fixture.dragStarts),1,'the user gesture must start an actual native drag');
  assert.deepEqual(await page.evaluate(()=>[window.fixture.messages[0].type,window.fixture.messages[0].url]),["save_video","https://fixture.test/clip.mp4"]);
  assert.equal(await page.locator("#__bowerbird_videos").count(),0,'native drop needs no picker');
  assert.equal(await video.getAttribute("draggable"),null,'dragend restores the original attribute');
  await video.evaluate(el=>el.setAttribute("draggable","false"));
  await page.mouse.move(rect.x+100,rect.y+40);await page.mouse.down();
  await video.evaluate(el=>el.dispatchEvent(new PointerEvent("pointercancel",{bubbles:true})));
  assert.equal(await video.getAttribute("draggable"),"false",'a cancelled gesture restores an explicit draggable=false');
  await page.mouse.up();
  await video.evaluate(el=>el.removeAttribute("draggable"));
  await page.evaluate(async()=>{if(document.fullscreenElement)await document.exitFullscreen();});

  await page.evaluate(()=>{window.fixture.pending=true;});
  await dropData(page,target,{"text/uri-list":"https://fixture.test/link.mp4"});
  await page.waitForFunction(()=>typeof window.fixture.reply==="function");
  assert.equal(await page.evaluate(()=>window.fixture.messages.length),2,'the main entry also collects a dropped video link directly');
  await dropData(page,target,{"text/html":'<img src="https://fixture.test/image.svg">'});
  assert.equal(await page.evaluate(()=>window.fixture.messages.length),2,'busy guard blocks image or video re-entry');
  await page.evaluate(()=>{window.fixture.pending=false;window.fixture.reply({ok:true,media_kind:"video"});});
  await page.waitForFunction(()=>!document.querySelector('[aria-label="Bowerbird 采集菜单"]').disabled);
  await target.dispatchEvent("drop",{});
  assert.equal(await page.evaluate(()=>window.fixture.messages.length),2,'a scripted drop cannot submit a second capture');
  await dropData(page,target,{
    "text/html":'<a href="https://fixture.test/outer.mp4"><img src="https://fixture.test/image.svg"></a><video><source src="https://fixture.test/unrelated.mp4"></video>',
    "text/uri-list":"https://fixture.test/outer.mp4"
  });
  await page.waitForFunction(()=>!document.querySelector('[aria-label="Bowerbird 采集菜单"]').disabled);
  assert.equal(await page.evaluate(()=>window.fixture.messages.length),3,'unrelated video sources must never join the image batch');
  assert.deepEqual(await page.evaluate(()=>[window.fixture.messages[2].type,window.fixture.messages[2].url]),["save_image","https://fixture.test/image.svg"],'dragged HTML images win over unrelated videos and outer video links');
  assert.deepEqual(errors,[]);
  console.log("PASS: native VIDEO drag, temporary draggable restore, controls/click, direct link drop, no duplicate, busy guard and image precedence");
} finally {await browser.close();}
