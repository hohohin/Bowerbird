import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const directory='.tmp/video-replication/tasks';
await mkdir(directory,{recursive:true});
execFileSync(process.env.BOWERBIRD_FFMPEG_BINARY || resolve('../../.tmp/video-integration/tools/local/ffmpeg.exe'),
 ['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=red:s=320x180:r=25:d=1','-f','lavfi','-i','color=lime:s=320x180:r=25:d=1','-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0','-c:v','libx264','-pix_fmt','yuv420p',directory+'/video.mp4']);
execFileSync(process.env.BOWERBIRD_FFMPEG_BINARY || resolve('../../.tmp/video-integration/tools/local/ffmpeg.exe'), ['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=red:s=270x480:r=25:d=1','-c:v','libx264','-pix_fmt','yuv420p',directory+'/portrait.mp4']);
execFileSync(process.env.BOWERBIRD_FFMPEG_BINARY || resolve('../../.tmp/video-integration/tools/local/ffmpeg.exe'), ['-hide_banner','-loglevel','error','-y','-i',directory+'/video.mp4','-frames:v','1',directory+'/first-frame.jpg']);
const server=await createServer({configFile:false,root:process.cwd(),cacheDir:directory+'/vite',server:{host:'127.0.0.1',port:1697,strictPort:true,hmr:false,watch:null}});
await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1500,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const openTool=async()=>{await page.getByRole('button',{name:'工具箱',exact:true}).click();await page.getByRole('menuitem',{name:/视频复刻工具/}).click();await page.getByRole('dialog',{name:'复刻任务',exact:true}).waitFor();};
async function installMock() {
 await page.evaluate(async()=>{
  const {useStore}=await import('/src/store.ts');
  const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
  window.controller=canvasWorkflowController('p');
  useStore.setState({activeGenProvider:'codex',defaultProvider:'codex',codexHealth:{ok:true,reason:''},cloudAuth:{cloud_available:true,logged_in:true},cloudEntitlement:{tier:'pro',policy:{can_use_byo:true},balances:{daily:0,sub:100,topup:0}}});
  window.capabilityMode='enabled';window.saveFailure=false;
  window.caseData=JSON.parse(sessionStorage.getItem('cases')||'{}');
  window.jobs=JSON.parse(sessionStorage.getItem('jobs')||'[]');
  window.acquisitions=JSON.parse(sessionStorage.getItem('acquisitions')||'[]');
  const mediaPath='/.tmp/video-replication/tasks/video.mp4';
  const reference={id:'reference',name:'参考广告.mp4',duration:2};
  const persist=()=>{sessionStorage.setItem('cases',JSON.stringify(window.caseData));sessionStorage.setItem('jobs',JSON.stringify(window.jobs));sessionStorage.setItem('acquisitions',JSON.stringify(window.acquisitions));};
  const invoke=window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke=async(command,args)=>{
   if(command==='video_poster')return 'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="red"/></svg>');
   if(command!=='video_replication')return invoke(command,args);
   window.calls.push({command,args});
   const {action,data}=args;
   if(action==='case-list')return Object.values(window.caseData).map(value=>{
    const acquisition=window.acquisitions.find(a=>a.caseId===value.id);
    const ref=value.referenceId || acquisition?.reference?.id;
    return {...value,...(ref?{referenceId:ref,reference:{...reference,id:ref},mediaPath}:{}),
      analysisJob:window.jobs.find(j=>j.caseId===value.id && j.operation==='analyze'),
      rewriteJob:window.jobs.find(j=>j.caseId===value.id && j.operation==='rewrite')};
   });
   if(action==='case-save'){
    if(window.saveFailure)throw Error('模拟磁盘保存失败');
    const {analysisJob,rewriteJob,reference,mediaPath,...saved}=structuredClone(data);
    window.caseData[data.id]=saved;persist();return structuredClone(saved);
   }
   if(action==='reference-poster')return '/.tmp/video-replication/tasks/first-frame.jpg';
   if(action==='preferences')return {};
   if(action==='capabilities'){
    if(window.capabilityMode==='error')throw Error('Cloud 连接中断');
    if(window.capabilityMode==='malformed')return {services:[]};
    return {services:['video-analysis','text-rewrite'].map(operation=>({operation,available:window.capabilityMode!=='disabled',credits:3}))};
   }
   if(action==='douyin-list')return structuredClone(window.acquisitions.filter(a=>a.caseId===data.caseId));
   if(action==='douyin-create'){const task={id:crypto.randomUUID(),caseId:data.caseId,state:'needs_login',message:'请打开抖音窗口继续获取',shareText:data.text};window.acquisitions.unshift(task);persist();return structuredClone(task);}
   if(action==='douyin-login'){const task=window.acquisitions.find(a=>a.id===data.id);Object.assign(task,{state:'ready',reference});persist();return structuredClone(task);}
   if(action==='sources')return [{id:'asset-video',name:'素材库视频.mp4',duration:2}];
   if(action==='reference')return {...reference,id:crypto.randomUUID()};
   if(action==='media')return mediaPath;
   if(action==='create'){
    const text='start: 0, end: 6.2\n清晨浴室产品特写\n\n## 首帧画面提示词\n白色瓶身，柔和自然光。';
    const job={...data,id:crypto.randomUUID(),projectId:'p',createdAt:new Date().toISOString(),state:data.operation==='analyze'?'analyzed':'rewritten',
      ...(data.operation==='analyze'?{analysis:data.analysisProvider==='codex'?'start: 0, end: 6.2\n展示产品':JSON.stringify({analysisText:'start: 0, end: 6.2\n展示产品',transcript:'欢迎了解这款产品。',transcriptStatus:'transcribed'}),transcript:data.analysisProvider==='codex'?'':'欢迎了解这款产品。',transcriptStatus:data.analysisProvider==='codex'?'unavailable':'transcribed'}:{rewrittenText:text,rewriteOriginalText:text})};
    window.jobs.unshift(job);persist();return structuredClone(job);
   }
   throw Error('Unexpected replication action '+action);
  };
 });
}
try {
 await page.goto('http://127.0.0.1:1697/scripts/fixtures/canvas-reference/preview.html?strict');
 await page.locator('[data-canvas-node-id="old"]').waitFor();await installMock();
 await openTool();await page.getByRole('button',{name:'新建任务',exact:true}).click();
 await page.getByRole('button',{name:/豆包.*选择视频分析模型/}).click();await page.screenshot({path:directory+'/analysis-providers.png'});await page.keyboard.press('Escape');
 assert.equal(await page.getByRole('navigation',{name:'复刻步骤'}).getByRole('button').count(),4);
 assert.equal(await page.getByRole('navigation',{name:'复刻步骤'}).getByRole('button').nth(1).isDisabled(),true);
 const share='分享 https://v.douyin.com/example/';
 await page.getByLabel('抖音分享内容').fill(share);
 // Closing before the debounce must flush the link, even across a full remount.
 await page.getByRole('button',{name:'关闭',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});
 await page.reload();await page.locator('[data-canvas-node-id="old"]').waitFor();await installMock();
 await openTool();assert.equal(await page.locator('.vr-task-tile').count(),1);
 assert.match(await page.locator('.vr-task-tile').innerText(),/待获取视频/);
 await page.locator('.vr-task-tile').click();assert.equal(await page.getByLabel('抖音分享内容').inputValue(),share);
 await page.getByRole('button',{name:'获取抖音视频',exact:true}).click();
 const login=page.getByRole('button',{name:'打开抖音窗口',exact:true});await login.waitFor();
 assert.match(await login.getAttribute('class'),/is-primary/);assert.equal(await page.getByRole('button',{name:'重新获取',exact:true}).count(),0);
 await page.getByRole('button',{name:'关闭',exact:true}).click();await openTool();await page.locator('.vr-task-tile').click();
 await page.getByRole('button',{name:'打开抖音窗口',exact:true}).click();
 await page.getByLabel('分析文本',{exact:true}).waitFor();
 await page.waitForFunction(()=>document.querySelector('.video-player video')?.readyState>=2);
 assert.equal(await page.evaluate(()=>window.jobs.length),0,'acquisition never submits a paid model');
 const video=page.locator('.video-player video');
 const assertRatio=async()=>{
  const size=await video.evaluate(v=>({ratio:v.videoWidth/v.videoHeight,screen:v.parentElement.getBoundingClientRect().toJSON(),box:v.getBoundingClientRect().toJSON()}));
  assert.ok(Math.abs(size.box.width/size.box.height-size.ratio)<0.01,'video uses its native aspect ratio');
  assert.ok(Math.abs(size.screen.width-size.box.width)<1 && Math.abs(size.screen.height-size.box.height)<1,'screen has no extra side bars');
 };
 await assertRatio();
 await video.evaluate(v=>{v.src='/.tmp/video-replication/tasks/portrait.mp4';v.load();});
 await page.waitForFunction(()=>document.querySelector('.video-player video')?.videoHeight===480);
 await assertRatio();await page.screenshot({path:directory+'/portrait.png'});
 await page.setViewportSize({width:640,height:820});await assertRatio();
 await page.setViewportSize({width:1500,height:1000});
 await video.evaluate(v=>{v.src='/.tmp/video-replication/tasks/video.mp4';v.load();});
 await page.waitForFunction(()=>document.querySelector('.video-player video')?.videoWidth===320);
 await assertRatio();
 await video.evaluate(v=>window.playerIdentity=v);
 await page.evaluate(()=>{window.capabilityMode='error';window.dispatchEvent(new Event('focus'));});
 await page.getByRole('button',{name:'重新读取 Cloud 状态'}).waitFor();
 assert.equal(await page.getByRole('button',{name:'分析视频',exact:true}).isDisabled(),true);
 await page.evaluate(()=>window.capabilityMode='enabled');await page.getByRole('button',{name:'重新读取 Cloud 状态'}).click();
 await page.getByRole('button',{name:'分析视频 · 3 积分',exact:true}).click();
 await page.getByRole('button',{name:'进行改写',exact:true}).waitFor();
 assert.equal(await page.getByLabel('语音转写',{exact:true}).inputValue(),'欢迎了解这款产品。');await page.getByLabel('语音转写',{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:directory+'/analysis-transcript.png'});
 await page.getByLabel('分析文本',{exact:true}).fill('start: 0, end: 6.2\n用户修订分镜');
 await page.getByRole('button',{name:'进行改写',exact:true}).click();
 assert.equal(await page.getByLabel('参考文本',{exact:true}).count(),0,'step 3 has no duplicate reference editor');
 assert.equal(await video.evaluate(v=>v===window.playerIdentity),true,'step navigation keeps same player');
 await page.getByLabel('改写方向',{exact:true}).fill('改为清晨浴室');
 await page.getByLabel('改写方向',{exact:true}).focus();await page.keyboard.press('Space');
 assert.equal(await video.evaluate(v=>v.paused),true,'typing never toggles player');
 const slider=page.getByRole('slider',{name:'视频时间轴'});await slider.focus();await page.keyboard.press('Home');
 for(let i=0;i<12;i++)await page.keyboard.press('ArrowRight');
 await page.waitForFunction(()=>{const v=document.querySelector('.video-player video');return v && !v.seeking && v.currentTime>1;});
 await page.getByRole('button',{name:'添加该帧为参考图',exact:true}).click();await page.getByAltText('首帧生成参考图').waitFor();
 const pixel=await page.getByAltText('首帧生成参考图').evaluate(async image=>{await image.decode();const c=document.createElement('canvas');c.width=image.naturalWidth;c.height=image.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);return {size:[c.width,c.height],rgba:[...ctx.getImageData(10,10,1,1).data]};});
 assert.deepEqual(pixel.size,[320,180]);assert.ok(pixel.rgba[1]>200 && pixel.rgba[0]<30);
 await page.getByRole('button',{name:'添加该帧到画板',exact:true}).click();await page.getByRole('button',{name:'已添加到画板',exact:true}).waitFor();
 await page.getByRole('button',{name:'开始改写 · 3 积分',exact:true}).click();
 await page.getByLabel('首帧画面提示词',{exact:true}).waitFor();
 const rewrite=await page.evaluate(()=>window.calls.find(c=>c.args?.action==='create' && c.args.data.operation==='rewrite').args.data);
 assert.equal(rewrite.inputText,'start: 0, end: 6.2\n用户修订分镜\n\n【语音转写】\n欢迎了解这款产品。');assert.equal(rewrite.rewriteDirection.trim(),'改为清晨浴室');
 assert.equal(await page.getByLabel('首帧画面提示词',{exact:true}).inputValue(),'白色瓶身，柔和自然光。');
 assert.equal(await video.evaluate(v=>v===window.playerIdentity && v.currentTime>1),true);
 await page.getByLabel('首帧画面提示词',{exact:true}).fill('精修后的首帧画面：清晨浴室');
 await page.evaluate(()=>window.saveFailure=true);
 await page.getByRole('button',{name:'全部任务',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'模拟磁盘保存失败'}).waitFor();
 assert.equal(await page.getByRole('navigation',{name:'复刻步骤'}).count(),1,'save failure keeps editor open');
 await page.evaluate(()=>window.saveFailure=false);await page.getByRole('button',{name:'全部任务',exact:true}).click();
 assert.equal(await page.locator('.vr-task-tile').count(),1,'analysis and rewrite stay in one task');
 const cover=page.locator('.vr-task-cover img');await cover.waitFor();
 const coverPixel=await cover.evaluate(async img=>{await img.decode();const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);return [...ctx.getImageData(10,10,1,1).data];});
 assert.ok(coverPixel[0]>200 && coverPixel[1]<40,'manager shows actual red first frame, not play placeholder');
 await page.waitForTimeout(350);await page.screenshot({path:directory+'/manager.png'});await page.locator('.vr-task-tile').click();
 assert.equal(await page.getByLabel('首帧画面提示词',{exact:true}).inputValue(),'精修后的首帧画面：清晨浴室');
 await page.getByAltText('首帧生成参考图').waitFor();await page.waitForTimeout(350);await page.screenshot({path:directory+'/step4-light.png'});
 await page.evaluate(()=>document.documentElement.dataset.theme='dark');await page.waitForTimeout(250);
 assert.equal(await page.getByLabel('改写结果',{exact:true}).evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(23, 21, 21)');
 await page.screenshot({path:directory+'/step4-dark.png'});
 await page.setViewportSize({width:640,height:820});
 assert.equal(await page.locator('.app-modal').evaluate(el=>el.scrollWidth<=el.clientWidth),true);await page.screenshot({path:directory+'/step4-narrow.png'});
 await page.setViewportSize({width:1500,height:1000});
 await page.getByRole('button',{name:'生成工作流',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});
 const result=await page.evaluate(async()=>{
  const {workflowOrder}=await import('/src/lib/canvasWorkflow.ts');
  const nodes=window.controller.document.nodes.filter(n=>n.id.startsWith('replication-'));
  return {nodes,notes:window.snapshot().nodes.filter(n=>n.id.startsWith('replication-')),order:workflowOrder(nodes,nodes.find(n=>n.generation?.media==='image').id)};
 });
 assert.equal(result.nodes.length,4);assert.equal(result.notes.length,2);
 const image=result.nodes.find(n=>n.generation?.media==='image'),movie=result.nodes.find(n=>n.generation?.media==='video');
 assert.match(image.prompt,/精修后的首帧画面/);assert.match(image.inputs.image[0].assetId,/^frame-/);
 assert.equal(movie.generation.videoOptions.kind,'image2video');assert.equal(movie.generation.videoOptions.duration,7);
 assert.match(movie.prompt,/清晨浴室产品特写/);
 assert.equal(result.order.length,4,'all four nodes participate in connected execution');
 for(const writer of result.nodes.filter(n=>n.kind==='text')){assert.equal(writer.textTarget.appendAxis,'column');assert.equal(writer.textTarget.image,true);}
 const writer=result.nodes.find(n=>n.id===movie.inputs.image[0].nodeId);
 assert.equal(writer.inputs.image[0].nodeId,image.id,'image -> content column -> video');
 assert.equal(await page.evaluate(()=>window.calls.filter(c=>/create_image|create_video/.test(c.command)).length),0,'workflow creation does not submit models');
 await page.waitForTimeout(350);
 assert.equal(await page.locator('path[data-workflow-target^="replication-"]').count(),3,'all three links render, including the content-to-video link');
 await page.screenshot({path:directory+'/workflow.png'});
 // Reopening and handoff again focuses the same workflow, without duplicate cards.
 await openTool();await page.locator('.vr-task-tile').click();await page.getByRole('button',{name:'生成工作流',exact:true}).click();
 await page.getByRole('dialog').waitFor({state:'detached'});
 assert.equal(await page.evaluate(()=>window.controller.document.nodes.filter(n=>n.id.startsWith('replication-')).length),4);
 // Exercise the real content-column writer and the next card's prompt compiler.
 const delivery=await page.evaluate(async()=>{
  const {compileGenerationPrompt,workflowInputValues}=await import('/src/lib/canvasWorkflow.ts');
  const controller=window.controller;
  const image=controller.document.nodes.find(n=>n.generation?.media==='image');
  const video=controller.document.nodes.find(n=>n.generation?.media==='video');
  const writer=controller.document.nodes.find(n=>n.id===video.inputs.image[0].nodeId);
  const assetId=image.inputs.image[0].assetId;
  await controller.edit(controller.document.nodes.map(n=>n.id===image.id?{...n,outputs:{image:{type:'image',assetIds:[assetId]}}}:n));
  await controller.start(writer.id,true);
  const compiled=compileGenerationPrompt(video,workflowInputValues(controller.document.nodes,video,()=>null));
  return {compiled,assetId,note:JSON.parse(window.snapshot().nodes.find(n=>n.id===writer.textTarget.nodeId).payloadJson)};
 });
 assert.ok(delivery.note.cells.some(row=>row.some(cell=>cell.image_refs?.some(ref=>ref.asset_id===delivery.assetId))),'writer delivers a real image into the content column');
 assert.deepEqual(delivery.compiled.assetIds,[delivery.assetId]);assert.match(delivery.compiled.prompt,/清晨浴室产品特写/);
 await openTool();await page.locator('.vr-task-tile').click();
 await page.getByLabel('首帧画面提示词',{exact:true}).fill('第二版：暮色浴室');
 await page.getByRole('button',{name:'生成工作流',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});
 assert.equal(await page.evaluate(()=>window.controller.document.nodes.filter(n=>n.id.startsWith('replication-')).length),8,'edited results create a new workflow rather than silently retaining the old prompt');
 await openTool();await page.locator('.vr-task-tile').click();
 const sceneScript='# 镜头1\n## 首帧画面\n古装女性捧着神牛礼盒，身处现代办公室。\n## 拍摄手法\n固定机位。\n## 时长\n约10秒';
 await page.getByLabel('改写结果',{exact:true}).fill(sceneScript);
 await page.getByLabel('首帧画面提示词',{exact:true}).fill('');
 const createsBeforeRecovery=await page.evaluate(()=>window.calls.filter(c=>c.args?.action==='create').length);
 await page.getByRole('button',{name:'全部任务',exact:true}).click();await page.locator('.vr-task-tile').click();
 assert.equal(await page.getByLabel('首帧画面提示词',{exact:true}).inputValue(),'古装女性捧着神牛礼盒，身处现代办公室。');
 assert.equal(await page.getByLabel('改写结果',{exact:true}).inputValue(),sceneScript,'scene extraction preserves video script');
 assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.args?.action==='create').length),createsBeforeRecovery,'reopening does not call a model');
 await page.getByRole('button',{name:'全部任务',exact:true}).click();await page.getByRole('button',{name:'新建任务',exact:true}).click();
 await page.getByRole('button',{name:'素材库',exact:true}).click();await page.getByRole('button',{name:'全部任务',exact:true}).click();
 await page.getByRole('button',{name:'新建任务',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'素材库',exact:true}).getAttribute('aria-pressed'),'true','source choice remembered');
 await page.getByRole('button',{name:/豆包.*选择视频分析模型/}).click();
 await page.getByRole('button',{name:'本机 Codex',exact:true}).click();
 await page.getByRole('button',{name:'素材库视频.mp4',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.video-player video')?.readyState>=2);
 await page.evaluate(()=>{window.capabilityMode='error';window.dispatchEvent(new Event('focus'));});
 const local=page.getByRole('button',{name:'分析视频 · 自有订阅',exact:true});
 assert.equal(await local.isEnabled(),true,'local analysis does not depend on Cloud price');
 await local.click();await page.getByRole('button',{name:'进行改写',exact:true}).waitFor();
 assert.equal(await page.getByLabel('语音转写',{exact:true}).inputValue(),'');
 assert.match(await page.getByLabel('语音转写',{exact:true}).getAttribute('placeholder'),/本机 Codex/);
 assert.equal(await page.evaluate(()=>window.jobs[0].analysisProvider),'codex');
 await page.getByRole('button',{name:'全部任务',exact:true}).click();
 await page.locator('.vr-task-tile').first().click();
 await page.getByRole('button',{name:'重新分析 · 自有订阅',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'重新分析 · 自有订阅',exact:true}).count(),1,'provider survives reopening');
 assert.deepEqual(errors,[]);
 console.log('PASS task persistence/reload, source memory, verification recovery, video gates, Cloud retry, stable player, exact frame/reference/canvas import, draft failure recovery, four connected cards, no auto-run, idempotent handoff, dark/narrow');
} catch(e){await page.screenshot({path:directory+'/failure.png'});throw e;}
finally{await browser.close();await server.close();}
