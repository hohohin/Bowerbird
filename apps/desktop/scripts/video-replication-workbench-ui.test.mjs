import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const directory='.tmp/video-replication/workbench';
await mkdir(directory,{recursive:true});
execFileSync(process.env.BOWERBIRD_FFMPEG_BINARY || resolve('../../.tmp/video-integration/tools/local/ffmpeg.exe'),
 ['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=red:s=320x180:r=25:d=1','-f','lavfi','-i','color=lime:s=320x180:r=25:d=1','-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0','-c:v','libx264','-pix_fmt','yuv420p',`${directory}/video.mp4`]);
const server=await createServer({configFile:false,root:process.cwd(),cacheDir:`${directory}/vite`,server:{host:'127.0.0.1',port:1697,strictPort:true,hmr:false,watch:null}});
await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const openTool=async()=>{await page.getByRole('button',{name:'工具箱',exact:true}).click();await page.getByRole('menuitem',{name:/视频复刻工具/}).click();};
try {
 await page.goto('http://127.0.0.1:1697/scripts/fixtures/canvas-reference/preview.html?strict');
 await page.locator('[data-canvas-node-id="old"]').waitFor();
 await page.evaluate(async()=>{
  const {useStore}=await import('/src/store.ts');
  const {api}=await import('/src/lib/api.ts');
  const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
  window.controller=canvasWorkflowController('p');
  window.imageSubmissions=[];
  useStore.setState({activeGenProvider:'codex',defaultProvider:'codex',cloudEntitlement:{balances:{daily:0,sub:0,topup:0},policy:{can_use_byo:true,can_use_cloud:true,max_parallel_jobs:10}}});
  api.codexCreateImage=async args=>{
   window.imageSubmissions.push(args);
   const base=window.snapshot().nodes[0];
   await api.projectCanvasNodeCreate({...base,id:`gen-prompt:${args.jobId}:${args.turnKey}:0`,kind:'prompt',assetId:null,role:null,hiddenAt:null,payloadJson:JSON.stringify({schema_version:1,job_id:args.jobId,turn_key:args.turnKey,text:args.prompt,status:'running',provider:args.provider})});
   useStore.getState().applyGenChunk({kind:'started',job_id:args.jobId});
   await new Promise(()=>{});
  };
  const reference={id:'ref',name:'分析参考.mp4',duration:2};
  const analysis={id:'analysis',projectId:'p',operation:'analyze',title:'分析记录',state:'analyzed',createdAt:new Date().toISOString(),referenceId:'ref',reference,analysis:'start: 0, end: 2\n展示产品',message:'分析完成'};
  window.replicationTasks=[analysis];
  const invoke=window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke=async(command,args)=>{
   if(command!=='video_replication')return invoke(command,args);
   window.calls.push({command,args});
   if(args.action==='list')return structuredClone(window.replicationTasks);
   if(args.action==='preferences')return {};
   if(args.action==='capabilities')return {services:['video-analysis','text-rewrite'].map(operation=>({operation,available:true,credits:3}))};
   if(args.action==='media')return '/.tmp/video-replication/workbench/video.mp4';
   if(args.action==='create'){
    const text='start: 0, end: 2\n清晨浴室产品特写\n\n## 首帧画面提示词\n白色瓶身，柔和自然光。';
    const task={...args.data,id:crypto.randomUUID(),projectId:'p',state:'rewritten',createdAt:new Date().toISOString(),rewrittenText:text,rewriteOriginalText:text};
    window.replicationTasks.unshift(task);return structuredClone(task);
   }
   if(args.action==='save-result'){
    const task=window.replicationTasks.find(t=>t.id===args.data.id);
    Object.assign(task,{rewrittenText:args.data.text,firstFramePrompt:args.data.firstFramePrompt,frameReference:args.data.frameReference});return structuredClone(task);
   }
   throw Error(`Unexpected replication action ${args.action}`);
  };
 });
 await openTool();
 assert.equal(await page.getByText('产品资料',{exact:true}).count(),0);
 await page.getByRole('button',{name:'记录',exact:true}).click();
 await page.getByRole('button',{name:/分析记录.*分析完成/}).click();
 await page.getByRole('button',{name:'开始改写',exact:true}).click();
 assert.equal(await page.getByLabel('参考文本',{exact:true}).inputValue(),'start: 0, end: 2\n展示产品');
 await page.getByLabel('改写方向',{exact:true}).fill('改成清晨浴室场景');
 await page.getByRole('button',{name:'分析视频',exact:true}).click();
 await page.getByRole('button',{name:'改写内容',exact:true}).click();
 assert.equal(await page.getByLabel('改写方向',{exact:true}).inputValue(),'改成清晨浴室场景');
 await page.getByRole('button',{name:'开始改写 · 3 积分',exact:true}).click();
 await page.getByLabel('首帧画面提示词',{exact:true}).waitFor();
 await page.waitForFunction(()=>document.querySelector('textarea[aria-label="首帧画面提示词"]')?.value==='白色瓶身，柔和自然光。');
 assert.equal(await page.getByLabel('首帧画面提示词',{exact:true}).inputValue(),'白色瓶身，柔和自然光。');
 assert.doesNotMatch(await page.getByLabel('改写结果（可编辑）').inputValue(),/首帧/);
 assert.equal(await page.evaluate(()=>window.calls.find(c=>c.args?.action==='create').args.data.rewriteDirection),'改成清晨浴室场景');
 await page.getByRole('button',{name:'查看 / 截帧',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.video-player video')?.readyState>=2);
 assert.equal(await page.locator('.video-player video').evaluate(v=>v.paused),true);
 const direction=page.getByLabel('改写方向',{exact:true});await direction.focus();await page.keyboard.press('End');await page.keyboard.press('Space');
 assert.equal(await page.locator('.video-player video').evaluate(v=>v.paused),true,'typing space outside embedded player must not play');
 const slider=page.getByRole('slider',{name:'视频时间轴'});await slider.focus();await page.keyboard.press('Home');
 for(let i=0;i<12;i++)await page.keyboard.press('ArrowRight');
 await page.waitForFunction(()=>{const v=document.querySelector('.video-player video');return v && !v.seeking && v.currentTime>1;});
 await page.getByRole('button',{name:'截取当前帧作参考',exact:true}).click();
 await page.getByAltText('首帧生成参考图').waitFor();
 const pixel=await page.getByAltText('首帧生成参考图').evaluate(async image=>{await image.decode();const c=document.createElement('canvas');c.width=image.naturalWidth;c.height=image.naturalHeight;const x=c.getContext('2d');x.drawImage(image,0,0);return {size:[c.width,c.height],rgba:[...x.getImageData(10,10,1,1).data]};});
 assert.deepEqual(pixel.size,[320,180]);assert.ok(pixel.rgba[1]>200 && pixel.rgba[0]<30,'captured green second scene, not cover');
 await page.getByLabel('首帧画面提示词',{exact:true}).fill('精修后的首帧画面：清晨浴室');
 await page.getByRole('button',{name:'保存修改',exact:true}).click();
 await page.getByText('已保存修改',{exact:true}).waitFor();
 await page.screenshot({path:`${directory}/rewrite-capture-light.png`});
 await page.getByRole('button',{name:'关闭',exact:true}).click();
 await openTool();await page.getByRole('button',{name:'记录',exact:true}).click();await page.getByRole('button',{name:/内容改写.*改写完成/}).click();
 await page.waitForFunction(()=>document.querySelector('textarea[aria-label="首帧画面提示词"]')?.value==='精修后的首帧画面：清晨浴室');
 assert.equal(await page.getByLabel('首帧画面提示词',{exact:true}).inputValue(),'精修后的首帧画面：清晨浴室');
 await page.getByAltText('首帧生成参考图').waitFor();
 await page.evaluate(()=>document.documentElement.dataset.theme='dark');await page.screenshot({path:`${directory}/rewrite-dark.png`});
 await page.setViewportSize({width:640,height:820});
 assert.equal(await page.locator('.app-modal').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
 await page.screenshot({path:`${directory}/rewrite-narrow.png`});await page.setViewportSize({width:1440,height:1000});
 await page.getByRole('button',{name:'生成首帧图片',exact:true}).click();
 await page.getByRole('dialog',{name:'视频复刻工具'}).waitFor({state:'detached'});
 await page.waitForFunction(()=>window.imageSubmissions.length===1);
 const request=await page.evaluate(()=>window.imageSubmissions[0]);
 assert.match(request.prompt,/精修后的首帧画面/);assert.match(request.prompt,/@图片1/);
 assert.equal(request.referenceImages.length,1);assert.match(request.referenceImages[0],/^data:image\/png/);
 const card=await page.evaluate(()=>window.controller.document.nodes.find(n=>n.kind==='generation'));
 assert.equal(card.generation.media,'image');assert.equal(card.ratio,'9:16');assert.equal(card.provider,'codex');
 assert.match(card.inputs.image[0].assetId,/^frame-/);assert.equal(card.promptReferences[0].input.assetId,card.inputs.image[0].assetId);assert.equal(card.promptReferences[0].slot,1);
 await page.screenshot({path:`${directory}/first-frame-canvas.png`});
 assert.deepEqual(errors,[]);
 console.log('PASS workbench draft switching, direction snapshot, prompt extraction, real MP4 paused playback, typing space, original-size scene capture, edit/reference persistence, dark/narrow UI, real canvas generation pipeline prompt + reference');
} catch(error){await page.screenshot({path:`${directory}/failure.png`});console.log(errors,await page.locator('textarea').evaluateAll(items=>items.map(el=>({label:el.labels?.[0]?.textContent,aria:el.getAttribute('aria-label'),value:el.value}))));throw error;}
finally{await browser.close();await server.close();}
