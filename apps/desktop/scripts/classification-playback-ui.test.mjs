import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({server:{host:"127.0.0.1",port:1467,strictPort:true,hmr:false,watch:null}});
await server.listen();
const browser = await chromium.launch({channel:"chrome",headless:true});
try {
  const page = await browser.newPage({viewport:{width:1000,height:920}});
  const errors=[]; page.on("pageerror",e=>errors.push(e.message));
  await page.route("**/*",route=>new URL(route.request().url()).hostname==="127.0.0.1"?route.continue():route.abort());
  await page.goto("http://127.0.0.1:1467/scripts/fixtures/local-classification/preview.html?project");
  await page.getByRole("button",{name:"进行分类",exact:true}).click();
  const playback=page.getByRole("region",{name:"分类动态"});
  await playback.getByText("正在分类",{exact:true}).waitFor();
  assert.equal(await playback.evaluate(el=>!!el.closest('[role="dialog"] .app-modal-body')),true);
  assert.equal(await page.locator('[aria-label="当前处理素材"]').count(),1);
  assert.equal(await playback.locator(".classification-playback-stack").evaluate(el=>getComputedStyle(el).animationName),"none");
  const dockBounds = await playback.locator(".classification-playback-stack .classification-playback-picture").boundingBox();
  const mutationsBefore = await page.evaluate(()=>window.calls.filter(c=>/start|stop|save|example|update/.test(c.command)).length);
  assert.equal(await playback.getByText('分类结果持续浮现',{exact:true}).count(),0);
  assert.equal(await playback.getByLabel('分类流水线',{exact:true}).count(),0);
  await page.evaluate(()=>{
    window.nextAsset={...window.previewAsset,id:'next-preview',name:'下一张.jpg'};
    Object.assign(window.classificationStatus,{jev_done:1,cloud_running:1,recent_cloud_handoffs:[window.previewAsset],current_asset:window.nextAsset});
    window.emitClassification();
  });
  const handoff=playback.locator('[data-kind="handoff"]');
  await handoff.waitFor();
  assert.equal(await playback.locator('.is-rise').count(),0,'Cloud handoff never rises');
  assert.equal(await playback.getByRole('progressbar').getAttribute('aria-valuenow'),'0','handoff is not completion');
  const slide=await handoff.evaluate(el=>{
    const animation=el.getAnimations()[0],original=animation.currentTime;
    animation.currentTime=0; const a=el.getBoundingClientRect();
    animation.currentTime=900; const b=el.getBoundingClientRect(),opacity=Number(getComputedStyle(el).opacity);
    animation.currentTime=original; return {dx:b.x-a.x,dy:b.y-a.y,opacity};
  });
  assert.ok(slide.dx>100 && Math.abs(slide.dy)<1 && slide.opacity<.3,'handoff moves right and fades without rising');
  await page.evaluate(()=>window.emitClassification());
  assert.equal(await handoff.count(),1,'repeated snapshots never duplicate handoff');
  await page.evaluate(()=>{
    window.maxVisible=0;
    new MutationObserver(()=>window.maxVisible=Math.max(window.maxVisible,document.querySelectorAll('.classification-playback-slot').length))
      .observe(document.body,{childList:true,subtree:true});
    const colors=['#32634d','#2b4f7e','#ad6c42','#665c8c','#6a754c'];
    window.result = i => ({sequence:i,asset:{...window.previewAsset,id:i===1?window.previewAsset.id:`image-${i}`,name:i===1?window.previewAsset.name:`素材 ${i}.jpg`,thumb_path:"data:image/svg+xml,"+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="180" height="220"><rect width="180" height="220" fill="#eeeadd"/><circle cx="90" cy="95" r="62" fill="${colors[(i-1)%5]}"/><path d="M25 170L90 40L155 170" fill="#b9d09b"/><text x="20" y="204" font-family="sans-serif" font-size="22" fill="#234c37">STUDY 0${i}</text></svg>`)},tags:i===2?["界面"]:i===3?[]:["海报","字体排版","图文卡片","信息图"],error:i===3?"请求失败":null});
    window.nextAsset={...window.previewAsset,id:"next-preview",name:"下一张.jpg"};
    Object.assign(window.classificationStatus,{done:5,total:6,current_asset:window.nextAsset,message:"正在处理",recent_results:[1,2,3,4,5].map(window.result),diagnostics:[
      {id:"image-1",name:"限流测试.jpg",elapsed_ms:62300,finished:false,steps:[{stage:"prepare",at_ms:0,detail:"准备图片"},{stage:"request",at_ms:100,detail:"Jev 匹配 · 第 1 次请求"},{stage:"response",at_ms:900,detail:"HTTP 429"},{stage:"backoff",at_ms:901,detail:"HTTP 429 分钟限流；等待 61 秒后重试"},{stage:"request",at_ms:61901,detail:"Jev 匹配 · 第 2 次请求；等待响应头（网络 + 服务端）"}]},
      {id:"image-2",name:"Cloud 排队测试.jpg",elapsed_ms:1800,finished:false,steps:[{stage:"queued",at_ms:0,detail:"等待本地 Cloud 并发槽（最多 4 张）"}]}
    ]});
    window.emitClassification();
  });
  // Backend counters advance immediately, without waiting for any animation.
  await page.waitForFunction(()=>document.querySelector('[aria-label="分类进度"]').getAttribute('aria-valuenow')==='5');
  await page.waitForFunction(()=>document.querySelectorAll('.classification-playback-slot').length===5);
  const launchBounds = await playback.locator('[data-sequence="1"]').evaluate(el => {
    const motion = el.getAnimations()[0]; const original = motion.currentTime;
    motion.currentTime = 0;
    const {x,y,width,height}=el.querySelector('.classification-playback-picture').getBoundingClientRect();
    motion.currentTime = original;
    return {x,y,width,height};
  });
  for (const key of ['x','y','width','height']) assert.ok(Math.abs(launchBounds[key]-dockBounds[key])<2, `result launches from dock: ${key}`);
  await playback.getByRole('img',{name:'正在处理：下一张.jpg',exact:true}).waitFor();
  assert.equal(await playback.locator('.classification-playback-tag').first().evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(246, 204, 69)');
  await page.waitForTimeout(1500);
  await playback.getByText("界面",{exact:true}).waitFor();
  assert.equal(await playback.locator('[data-sequence="3"]').count(),0,"untagged final results exit instead of rising");
  assert.equal(await playback.locator(".classification-playback-tag").first().evaluate(el=>getComputedStyle(el).animationName),"classification-tag-stamp");
  const pictureStyle=await playback.locator('.is-rise .classification-playback-picture').first().evaluate(el=>{
    const s=getComputedStyle(el);return {background:s.backgroundColor,border:s.borderTopWidth,shadow:s.boxShadow};
  });
  assert.deepEqual(pictureStyle,{background:'rgba(0, 0, 0, 0)',border:'0px',shadow:'none'},'floating images have no card frame');
  await mkdir(".tmp/classification-playback",{recursive:true});
  await page.screenshot({path:".tmp/classification-playback/dark.png"});
  await page.evaluate(()=>document.documentElement.dataset.theme="light");
  await page.screenshot({path:".tmp/classification-playback/light.png"});
  await page.evaluate(()=>{const s=window.classificationStatus;s.done=6;s.total=12;s.recent_results.push(window.result(6));window.emitClassification();});
  await playback.locator('[data-sequence="6"]').waitFor();
  assert.equal(await playback.locator('[data-sequence="1"]').count(),1,"sixth completion no longer evicts the first");
  const trajectory = await playback.locator('[data-sequence="6"]').evaluate(el => {
    const motion = el.getAnimations()[0];
    const original = motion.currentTime;
    const duration = motion.effect.getTiming().duration;
    motion.currentTime = duration * .15;
    const first = { y: el.getBoundingClientRect().y, opacity: Number(getComputedStyle(el).opacity) };
    motion.currentTime = duration * .8;
    const last = { y: el.getBoundingClientRect().y, opacity: Number(getComputedStyle(el).opacity) };
    motion.currentTime = original;
    return { first, last };
  });
  assert.ok(trajectory.last.y < trajectory.first.y - 120, "results slowly travel upward");
  assert.ok(trajectory.last.opacity < trajectory.first.opacity, "results fade along their journey");
  await page.evaluate(()=>{const s=window.classificationStatus;s.done=12;s.current_asset=window.nextAsset;s.recent_results.push(...[7,8,9,10,11,12].map(window.result));window.emitClassification();});
  await playback.locator('[data-sequence="12"]').waitFor();
  assert.equal(await playback.locator('article').count(),10);
  assert.equal(await playback.getByRole('img').count(),11,"ten results plus the current dock stay within eleven pictures");
  assert.equal(await page.evaluate(()=>window.maxVisible),10);
  const lanes=await playback.locator('article').evaluateAll(items=>items.reduce((counts,el)=>{const lane=el.dataset.lane;counts[lane]=(counts[lane]??0)+1;return counts;},{}));
  assert.equal(Object.keys(lanes).length,7);
  assert.ok(Math.max(...Object.values(lanes))<=2,"no horizontal launch lane is overloaded");
  await page.waitForTimeout(900);
  assert.equal(await playback.locator('.classification-playback-current-copy').evaluate(el=>{
    const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
  }),true,"burst results never cover the current progress text");
  await page.screenshot({path:".tmp/classification-playback/floating-burst.png"});
  await page.locator('.classification-diagnostics > summary').click();
  await page.getByText("限流测试.jpg",{exact:true}).click();
  await page.getByText("Cloud 限流等待 · HTTP 429 分钟限流；等待 61 秒后重试",{exact:true}).waitFor();
  await page.getByText("61.0 秒",{exact:true}).waitFor();
  const downloadEvent=page.waitForEvent('download');
  await page.getByRole('button',{name:'导出诊断'}).click();
  assert.equal((await downloadEvent).suggestedFilename(),'classification-diagnostics.json');
  await page.screenshot({path:".tmp/classification-playback/diagnostics.png"});
  await page.locator('.classification-diagnostics > summary').click();
  await page.evaluate(()=>{const s=window.classificationStatus;s.busy=false;s.current_asset=null;s.message="处理完成";window.emitClassification();});
  await page.waitForFunction(()=>document.querySelectorAll('.classification-playback-slot').length===0,{},{timeout:14000});
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>/start|stop|save|example|update/.test(c.command)).length),mutationsBefore,"animation and diagnostics never send classification control commands");
  await page.getByRole("button",{name:"关闭",exact:true}).click();
  await page.getByRole("button",{name:"打开自动分类",exact:true}).click();
  await page.waitForTimeout(600);
  assert.equal(await playback.locator('article').count(),0,"reopening never replays completed results");
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>/start|stop|save|example|update/.test(c.command)).length),mutationsBefore,"closing doesn't stop classification");
  await page.getByRole("button",{name:"进行分类",exact:true}).click();
  await page.evaluate(()=>{Object.assign(window.classificationStatus,{project_id:"another-project",done:1,recent_results:[window.result(1)]});window.emitClassification();});
  await page.waitForTimeout(600);
  assert.equal(await page.locator('.classification-playback-slot').count(),0,"other scopes do not animate");
  await page.emulateMedia({reducedMotion:"reduce"});
  await page.setViewportSize({width:390,height:900});
  await page.evaluate(()=>{Object.assign(window.classificationStatus,{project_id:"project-test",done:0,recent_results:[]});window.emitClassification();});
  await page.waitForTimeout(100);
  await page.evaluate(()=>{Object.assign(window.classificationStatus,{project_id:"project-test",done:5,total:5,recent_results:[1,2,3,4,5].map(window.result),busy:false,message:"处理完成",last_error:"测试：服务未就绪"});window.emitClassification();});
  await page.waitForFunction(()=>document.querySelectorAll('.classification-playback-slot').length===5);
  assert.equal(await playback.locator('.classification-playback-tag').first().evaluate(el=>getComputedStyle(el).animationName),'none');
  await playback.getByRole('alert').waitFor();
  await page.screenshot({path:".tmp/classification-playback/narrow.png"});
  const bounds=await playback.boundingBox();
  assert.ok(bounds.x>=0 && bounds.x+bounds.width<=390);
  assert.deepEqual(errors,[]);
  console.log("PASS: Cloud handoff slides right once without completing/rising, untagged results exit, bare images, removed helper text, yellow tags, static processing dock, exact dock-to-float origin, immediate floating results, upward fade, eleven-picture cap, balanced X lanes, lifetime cleanup, zero control IPC, diagnostic timing/export, scope, reopen, reduced motion, narrow layout");
} finally { await browser.close(); await server.close(); }
