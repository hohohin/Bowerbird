import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

await mkdir('.tmp/comfy-video', { recursive: true });
const server = await createServer({ configFile:false, cacheDir:'.tmp/comfy-video/vite', server:{host:'127.0.0.1',port:1672,strictPort:true,hmr:false,watch:null} });
await server.listen();
const browser = await chromium.launch({channel:'chrome',headless:true});
const page = await browser.newPage({viewport:{width:1600,height:1100}});
page.setDefaultTimeout(15000);
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const snapshot=()=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document);
async function installMock() {
  await page.evaluate(() => {
    window.store.setState({cloudAuth:{logged_in:true,user_id:'tester'},cloudEntitlement:{user_id:'tester',tier:'pro',offline_state:'fresh',is_test_account:false,balances:{daily:0,sub:0,topup:0},policy:{can_use_cloud:true,can_use_byo:true},generation_services:[]}});
    const invoke=window.__TAURI_INTERNALS__.invoke;
    window.comfyMode='unknown';window.comfyCalls=[];window.environmentCalls=[];window.environmentPhase='missing';
    const video={id:'h3-video',name:'H3 合成测试视频',store_path:'/synthetic-h3.mp4',ext:'mp4',width:672,height:1216,duration:8,source:'comfy-h3'};
    window.__TAURI_INTERNALS__.invoke=async (command,args)=>{
      if(command==='plugin:dialog|open') return 'D:\\Local-Workflows';
      if(command==='comfy_video_check') return '已连接 · 模拟工作流所需节点与模型可用';
      if(command==='comfy_video_environment') {
        window.environmentCalls.push(args);
        if(args.action==='detect' && window.detectError) throw new Error('模拟环境检测失败');
        if(args.action==='install') window.environmentPhase='installing';
        if(args.action==='cancel') window.environmentPhase='cancelled';
        if(args.action==='select_existing') window.environmentPhase='stopped';
        if(args.action==='start_existing') window.environmentPhase='starting';
        if(args.action==='prepare') {
          if(window.environmentPhase==='missing') throw new Error('尚未安装本机环境，请先点击卡片中的“一键下载并安装”');
          if(window.environmentPhase==='stopped' || window.environmentPhase==='failed' && window.keepExisting) window.environmentPhase='starting';
        }
        if(args.action==='status' && window.environmentPhase==='starting' && !window.holdStartup) window.environmentPhase='ready';
        const existing=window.keepExisting || ['stopped','starting','unavailable'].includes(window.environmentPhase)?[{path:'D:\\Existing-Comfy-Desktop\\ComfyUI',name:'已有 ComfyUI',endpoint:'http://127.0.0.1:8199',canStart:!window.noPython,modelsFound:window.modelsMissing?4:5}]:[];
        return {phase:window.environmentPhase,existing,message:window.environmentPhase==='ready'?'本机环境已就绪 · 模型与节点可用':window.environmentPhase==='starting'?'正在自动启动测试环境':existing.length?'已找到已有环境，服务未启动':'模拟：尚未安装本机运行环境',endpoint:window.environmentPhase==='ready'?(window.detectedEndpoint||'http://127.0.0.1:18189'):args.endpoint,directory:'D:\\Bowerbird-ComfyUI',canInstall:!existing.length && !window.blockInstall,installed:!!window.managedInstalled,downloadBytes:44048479273,requiredBytes:56933381161,completedBytes:1024000,totalBytes:44048479273};
      }
      if(command==='comfy_video'){
        window.comfyCalls.push({command,...args});
        const calls=JSON.parse(sessionStorage.getItem('comfy-calls')||'[]');calls.push(args);sessionStorage.setItem('comfy-calls',JSON.stringify(calls));
        if(args.action==='cancel') {
          if(window.cancelMode==='error')throw new Error('模拟取消连接失败');
          return window.cancelMode==='done'?{status:'done',message:'视频已先于停止请求完成，可取回已有结果'}:{status:'cancelled',message:'本机生成已中断'};
        }
        if(args.action==='start') {
          if(window.holdSubmission)await new Promise(resolve=>{window.finishSubmission=resolve;});
          return {status:'queued',message:'已加入本机队列'};
        }
        if(window.comfyMode==='disconnect') throw new Error('模拟连接中断');
        if(window.comfyMode==='queued')return {status:'queued',message:'已加入本机队列'};
        if(window.comfyMode==='running')return {status:'running',message:'正在生成视频',progress:window.comfyProgress};
        if(window.comfyMode==='done')return {status:'done',message:'视频已生成',asset:video,elapsedMs:273960};
        return {status:'unknown',message:'原任务暂不可见；继续只查询原任务'};
      }
      if(command==='get_assets_by_ids')return [...await invoke(command,args),...(args.assetIds.includes(video.id)?[video]:[])];
      return invoke(command,args);
    };
  });
}
try {
  await page.goto('http://127.0.0.1:1672/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(()=>{const canvas=window.snapshot();canvas.nodes=canvas.nodes.filter(node=>node.id!=='far');sessionStorage.setItem('reference-fixture',JSON.stringify(canvas));});
  await page.reload();await page.locator('[data-canvas-node-id="old"]').waitFor();await installMock();
  await page.evaluate(()=>{window.environmentPhase='stopped';});
  await page.getByRole('button',{name:'工具箱',exact:true}).click();
  await page.getByRole('menuitem',{name:/本地 H3 视频/}).click();
  assert.equal(await page.locator('.workflow-card.is-comfy-video').count(),0,'tool arms placement first');
  await page.mouse.click(890,180);
  const card=page.locator('.workflow-card.is-comfy-video');await card.waitFor();
  assert.equal(await card.locator('.provider-quota[data-quota="local"]').innerText(), '本机算力 · 不扣额度');
  await card.screenshot({path:'.tmp/comfy-video/quota-local.png'});
  const dot=card.locator('.comfy-environment-dot');
  const panel=page.getByRole('dialog',{name:'本地部署工作流环境设置',exact:true});
  await page.waitForFunction(()=>window.environmentCalls?.some(call=>call.action==='detect'));
  assert.ok((await page.evaluate(()=>window.environmentCalls)).every(call=>call.action==='detect'),'placing a card only detects');
  assert.equal(await card.locator('.comfy-environment').count(),0,'no environment block in card body');
  assert.equal(await dot.evaluate(el=>el.nextElementSibling?.getAttribute('aria-label')),'复制卡片','dot is immediately left of copy');
  await card.locator('.comfy-environment-dot.is-ready').waitFor();
  assert.equal(await dot.locator('span').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(34, 197, 94)','stopped but complete environment is green');
  assert.match(await dot.getAttribute('title'),/运行卡片时会自动启动/);
  await dot.click();assert.equal(await panel.isVisible(),false,'stopped environment needs no setup panel');
  assert.ok((await page.evaluate(()=>window.environmentCalls)).every(call=>call.action==='detect'),'placing ready card never starts or installs');
  await page.screenshot({path:'.tmp/comfy-video/placed-stopped-ready.png'});
  await page.evaluate(()=>{window.environmentPhase='missing';window.dispatchEvent(new Event('focus'));});
  await card.locator('.comfy-environment-dot:not(.is-ready)').waitFor();
  await dot.click();await panel.waitFor();
  await page.waitForFunction(()=>!document.querySelector('.comfy-environment-panel button:last-child').disabled);
  assert.deepEqual(await panel.getByRole('button').allTextContents(),['安装位置','安装']);
  await page.screenshot({path:'.tmp/comfy-video/setup-missing.png'});
  await panel.getByRole('button',{name:'安装位置',exact:true}).click();
  await page.waitForFunction(()=>window.environmentCalls.some(call=>call.directory==='D:\\Local-Workflows'));
  assert.ok((await page.evaluate(()=>window.environmentCalls)).every(call=>call.action==='detect'),'choosing destination does not install');
  await panel.getByRole('button',{name:'安装',exact:true}).click();
  await panel.getByLabel('环境下载进度',{exact:true}).waitFor();
  assert.deepEqual(await panel.getByRole('button').allTextContents(),['安装位置','安装中…'],'no extra controls');
  assert.equal((await page.evaluate(()=>window.environmentCalls)).find(call=>call.action==='install').directory,'D:\\Local-Workflows');
  assert.equal(await panel.getByRole('button',{name:'安装中…',exact:true}).isDisabled(),true);
  assert.equal(await panel.getByRole('button',{name:'安装位置',exact:true}).isDisabled(),true);
  await page.keyboard.press('Escape');await panel.waitFor({state:'hidden'});
  assert.equal(await dot.evaluate(el=>document.activeElement===el),true,'Escape returns focus to dot');
  await dot.click();await panel.getByLabel('环境下载进度',{exact:true}).waitFor();
  assert.equal((await page.evaluate(()=>window.environmentCalls)).filter(call=>call.action==='install').length,1,'reopening panel does not install again');
  await page.evaluate(()=>{window.environmentPhase='failed';});
  await page.waitForFunction(()=>!document.querySelector('.comfy-environment-panel button:last-child').disabled);
  await panel.getByRole('button',{name:'重试安装',exact:true}).click();
  await panel.getByLabel('环境下载进度',{exact:true}).waitFor();
  await page.evaluate(()=>{window.environmentPhase='ready';});
  await card.locator('.comfy-environment-dot.is-ready').waitFor();await panel.waitFor({state:'hidden'});
  await dot.click();assert.equal(await panel.isVisible(),false,'green dot does not open setup');
  // Stopped installations with Python and all models are ready; incomplete ones remain red.
  await page.evaluate(()=>{window.environmentPhase='stopped';window.dispatchEvent(new Event('focus'));});
  await page.waitForFunction(()=>document.querySelector('.comfy-environment-dot')?.title.includes('运行卡片时会自动启动'));
  await dot.click();assert.equal(await panel.isVisible(),false);
  await page.evaluate(()=>{window.noPython=true;window.dispatchEvent(new Event('focus'));});
  await card.locator('.comfy-environment-dot:not(.is-ready)').waitFor();
  await dot.click();await panel.getByRole('button',{name:'无法启动',exact:true}).waitFor();
  assert.equal(await panel.getByRole('button',{name:'无法启动',exact:true}).isDisabled(),true);
  await page.evaluate(()=>{window.noPython=false;window.modelsMissing=true;window.dispatchEvent(new Event('focus'));});
  await panel.getByRole('button',{name:'启动',exact:true}).waitFor();
  assert.equal(await dot.evaluate(el=>el.classList.contains('is-ready')),false,'missing models are not ready');
  await page.evaluate(()=>{window.modelsMissing=false;window.environmentPhase='unavailable';window.dispatchEvent(new Event('focus'));});
  await panel.getByRole('button',{name:'重新检测',exact:true}).waitFor();
  await page.evaluate(()=>{window.environmentPhase='stopped';});
  await panel.getByRole('button',{name:'重新检测',exact:true}).click();
  await card.locator('.comfy-environment-dot.is-ready').waitFor();await panel.waitFor({state:'hidden'});
  await page.evaluate(()=>{window.detectError=true;window.dispatchEvent(new Event('focus'));});
  await card.locator('.comfy-environment-dot:not(.is-ready)').waitFor();await dot.click();
  await panel.getByText('Error: 模拟环境检测失败',{exact:true}).waitFor();
  await page.waitForFunction(()=>{const button=document.querySelector('.comfy-environment-panel button:last-child');return button?.textContent==='重新检测' && !button.disabled;});
  await page.evaluate(()=>{window.detectError=false;window.blockInstall=true;window.environmentPhase='missing';});
  await panel.getByRole('button',{name:'重新检测',exact:true}).click();
  await panel.getByRole('button',{name:'暂不可安装',exact:true}).waitFor();
  assert.equal(await panel.getByRole('button',{name:'暂不可安装',exact:true}).isDisabled(),true);
  await page.evaluate(()=>{window.blockInstall=false;window.environmentPhase='cancelled';window.dispatchEvent(new Event('focus'));});
  await panel.getByRole('button',{name:'继续安装',exact:true}).waitFor();
  assert.equal(await panel.getByRole('button',{name:'继续安装',exact:true}).isDisabled(),false);
  // Managed installations also require no separate start, while a recorded startup failure stays red.
  await page.evaluate(()=>{window.managedInstalled=true;window.environmentPhase='missing';window.dispatchEvent(new Event('focus'));});
  await card.locator('.comfy-environment-dot.is-ready').waitFor();await panel.waitFor({state:'hidden'});
  await page.evaluate(()=>{window.managedInstalled=false;window.keepExisting=true;window.environmentPhase='failed';window.dispatchEvent(new Event('focus'));});
  await card.locator('.comfy-environment-dot:not(.is-ready)').waitFor();await dot.click();
  await panel.getByRole('button',{name:'重试启动',exact:true}).waitFor();
  const installations=await page.evaluate(()=>window.environmentCalls.filter(call=>call.action==='install').length);
  await panel.getByRole('button',{name:'重试启动',exact:true}).click();
  await panel.waitFor({state:'hidden'});await card.locator('.comfy-environment-dot.is-ready').waitFor();
  assert.equal(await page.evaluate(()=>window.environmentCalls.filter(call=>call.action==='install').length),installations,'startup retry never downloads');
  await page.evaluate(()=>{window.keepExisting=false;window.environmentPhase='stopped';window.dispatchEvent(new Event('focus'));});
  await page.waitForFunction(()=>document.querySelector('.comfy-environment-dot')?.title.includes('运行卡片时会自动启动'));
  await page.screenshot({path:'.tmp/comfy-video/existing-stopped.png'});
  await card.getByLabel('H3 比例').click();
  assert.deepEqual(await card.getByRole('listbox',{name:'画面比例'}).getByRole('option').allTextContents(),['自动','1:1','3:4','4:3','16:9','9:16']);
  await page.screenshot({path:'.tmp/comfy-video/ratio-menu-light.png'});
  await page.keyboard.press('Escape');
  assert.equal(await card.getByRole('listbox').count(),0);
  for (const ratio of ['3:4','1:1','4:3','auto']) {
    await card.getByLabel('H3 比例').click();
    await card.getByRole('option',{name:ratio==='auto'?'自动':ratio,exact:true}).click();
    assert.equal((await snapshot()).nodes[0].comfyVideo.ratio,ratio);
  }
  await card.getByLabel('H3 比例').focus();
  await page.keyboard.press('Enter');
  await card.getByRole('option',{name:'3:4',exact:true}).focus();
  await page.keyboard.press('Enter');
  assert.equal((await snapshot()).nodes[0].comfyVideo.ratio,'3:4');
  await card.getByLabel('H3 比例').click();
  await card.getByRole('option',{name:'自动',exact:true}).click();
  assert.deepEqual(await card.getByLabel('H3 分辨率').locator('option').allTextContents(),['0.6','0.8','1.0']);
  await card.getByLabel('H3 时长').fill('11');
  await card.getByLabel('H3 分辨率').selectOption('0.6');
  await card.getByLabel('卡片指令',{exact:true}).fill('镜头平稳推进，主体自然转动');
  await page.locator('[data-canvas-node-id="old"]').hover();
  await page.getByRole('button',{name:'连接图片到工作流',exact:true}).first().click();
  await card.getByRole('button',{name:'输入：首帧',exact:true}).click();
  await page.evaluate(async()=>{const {setDragAssets}=await import('/src/lib/dragPayload.ts');setDragAssets(['b']);});
  await card.getByLabel('尾帧输入',{exact:true}).dispatchEvent('drop',{dataTransfer:await page.evaluateHandle(()=>new DataTransfer())});
  await page.evaluate(async()=>{const {setDragAssets}=await import('/src/lib/dragPayload.ts');setDragAssets(null);});
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes[0].inputs['last-frame']?.[0]?.assetId==='b');
  assert.equal((await page.evaluate(()=>window.comfyCalls)).length,0,'environment setup never generates');
  const layout=await card.evaluate(el=>{
    const rect=selector=>{const r=el.querySelector(selector).getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right};};
    return {cardWidth:parseFloat(getComputedStyle(el).width),promptMargin:parseFloat(getComputedStyle(el.querySelector('.comfy-video-prompt')).marginLeft),width:el.querySelector('.comfy-video-card').clientWidth,scroll:el.querySelector('.comfy-video-card').scrollWidth,
      header:rect('header'),prompt:rect('.comfy-video-prompt'),options:rect('.comfy-video-options'),frames:rect('.comfy-frame-slots'),
      inputs:[...el.querySelectorAll('[data-workflow-input]')].map(port=>({id:port.dataset.workflowInput,...(()=>{const r=port.getBoundingClientRect();return {top:r.top,bottom:r.bottom,right:r.right};})()})),output:rect('.workflow-port.is-output')};
  });
  assert.equal(layout.cardWidth,416);
  assert.equal(await card.getByText(/24 fps|1 个视频|约 .* 秒/).count(),0);
  assert.ok(Math.abs(layout.promptMargin-25.7)<0.1);
  assert.equal(await card.getByRole('button',{name:/移除[首尾]帧/}).count(),0);
  assert.ok(layout.scroll<=layout.width+2);
  assert.ok(layout.frames.top-layout.header.bottom<20,'frames begin directly below header');
  assert.ok(layout.prompt.top>=layout.frames.bottom && layout.options.top>=layout.prompt.bottom,'frames, prompt, parameters in requested order');
  assert.deepEqual(layout.inputs.map(port=>port.id),['first-frame','last-frame','text']);
  for(const port of layout.inputs) {
    assert.ok(port.top>=layout.prompt.top && port.bottom<=layout.prompt.bottom,'input ports sit alongside prompt');
    assert.ok(port.right<=layout.prompt.left,'port labels do not cover prompt');
  }
  assert.ok(layout.output.top>=layout.prompt.top && layout.output.bottom<=layout.prompt.bottom && layout.output.left>=layout.prompt.right);
  await page.screenshot({path:'.tmp/comfy-video/card-light.png'});
  await page.reload();await card.waitFor();await installMock();
  assert.equal(await card.getByLabel('H3 时长').inputValue(),'11');
  assert.match(await card.getByLabel('H3 比例').innerText(),/自动/);
  assert.equal((await snapshot()).nodes[0].comfyVideo.ratio,'auto');
  assert.equal(await card.getByLabel('H3 分辨率').inputValue(),'0.6');
  assert.equal((await snapshot()).nodes[0].inputs['last-frame'][0].assetId,'b');
  // Preparation errors occur before submission identity; they are not unknown video jobs.
  await card.getByRole('button',{name:'运行此卡片',exact:true}).click();
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.run?.status==='failed');
  assert.equal((await snapshot()).run.steps[(await snapshot()).nodes[0].id].jobId,undefined);
  assert.equal(await page.evaluate(()=>window.comfyCalls.length),0);
  // Stopping during automatic startup must never submit a video, even if startup later succeeds.
  await page.evaluate(()=>{window.environmentPhase='stopped';window.holdStartup=true;});
  await card.getByRole('button',{name:'运行此卡片',exact:true}).click();
  await card.getByText('正在自动启动测试环境',{exact:true}).waitFor();
  await card.getByRole('button',{name:'停止工作流'}).click();
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.run?.status==='stopped');
  await page.evaluate(()=>{window.holdStartup=false;});
  assert.equal(await page.evaluate(()=>window.comfyCalls.length),0);
  assert.equal(await card.getByRole('button',{name:'取回上次视频'}).count(),0);
  await page.evaluate(()=>{window.environmentPhase='stopped';});
  await card.getByRole('button',{name:'运行此卡片',exact:true}).click();
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.run?.status==='waiting');
  let calls=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('comfy-calls')));
  const submitted=calls.find(call=>call.action==='start');
  assert.equal(submitted.input.firstFrame,'existing');assert.equal(submitted.input.lastFrame,'b');assert.equal(submitted.input.seconds,11);
  assert.equal(submitted.input.ratio,'auto');assert.equal(submitted.input.resolution,0.6);
  assert.equal(submitted.input.endpoint,'http://127.0.0.1:18189','submission uses the automatically prepared service');assert.match(submitted.input.prompt,/镜头平稳/);
  assert.ok((await page.evaluate(()=>window.environmentCalls)).some(call=>call.action==='prepare'));
  assert.ok((await page.evaluate(()=>window.environmentCalls)).every(call=>call.action!=='install' && call.action!=='start_existing'),'run requires no standalone installation/start action');
  await page.reload();await card.waitFor();await installMock();
  await page.evaluate(()=>{window.comfyMode='disconnect';});
  await card.getByRole('button',{name:'继续工作流'}).click();
  await card.getByText(/模拟连接中断/).waitFor();
  await page.evaluate(()=>{window.comfyMode='queued';window.cancelMode='done';});
  await card.getByRole('button',{name:'继续工作流'}).click();
  await card.getByText('已加入本机队列',{exact:true}).waitFor();
  await card.getByRole('button',{name:'停止工作流'}).click();
  await card.getByRole('button',{name:'取回上次视频'}).waitFor();
  assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.command==='cancel_codex_create').length),0,'stop never cancels unrelated generators');
  await page.evaluate(()=>{window.comfyMode='done';window.failNodeSave=true;});
  await card.getByRole('button',{name:'取回上次视频'}).click();
  await card.getByText(/模拟草稿卡片保存失败/).waitFor();
  assert.equal((await snapshot()).run.status,'waiting','delivery failure is recoverable without generation');
  await page.evaluate(()=>{window.failNodeSave=false;});
  await card.getByRole('button',{name:'继续工作流'}).click();
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.run?.status==='done');
  await card.getByText('视频已生成 · 用时 4 分 34 秒',{exact:true}).waitFor();
  assert.deepEqual((await snapshot()).nodes[0].outputs.image.assetIds,['h3-video']);
  let resultId=(await snapshot()).nodes[0].resultNodeIds[0];
  await page.locator(`[data-canvas-node-id="${resultId}"]`).waitFor();
  await page.locator(`[data-workflow-result-link="${resultId}"].is-image`).waitFor();
  assert.equal(await card.locator('video').count(),0,'result is outside the workflow card');
  const firstResult=await page.evaluate(id=>window.snapshot().nodes.find(node=>node.id===id),resultId);
  assert.equal(firstResult.assetId,'h3-video');assert.equal(firstResult.kind,'asset');assert.equal(firstResult.role,'output');
  assert.ok(firstResult.x>=(await snapshot()).nodes[0].x+416);
  assert.ok(Math.abs((firstResult.width-2)/(firstResult.height-32)-672/1216)<1e-8);
  calls=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('comfy-calls')));
  assert.equal(calls.filter(call=>call.action==='start').length,1,'recovery never resubmits');
  assert.ok(calls.every(call=>call.requestId===submitted.requestId));
  assert.ok((await page.evaluate(()=>window.environmentCalls)).every(call=>call.action!=='prepare'),'recovery only queries the original job');
  // Single-frame mode and a second explicit run get a new identity.
  await card.getByRole('button',{name:'输入：尾帧（可选）',exact:true}).click({button:'right'});
  await page.evaluate(()=>{window.environmentPhase='ready';});
  await card.getByRole('button',{name:'运行此卡片',exact:true}).click();
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('comfy-calls')).filter(call=>call.action==='start').length===2);
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.run?.status==='done');
  const single=(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('comfy-calls')))).filter(call=>call.action==='start')[1];
  assert.equal(single.input.lastFrame,undefined);assert.notEqual(single.requestId,submitted.requestId);
  const secondResultId=(await snapshot()).nodes[0].resultNodeIds[0];
  assert.notEqual(secondResultId,resultId,'explicit new generation has its own output card');
  resultId=secondResultId;
  await page.locator(`[data-canvas-node-id="${resultId}"]`).waitFor();
  // Detection completes after the run unlocks: saving a service address must not invalidate its video.
  await page.evaluate(()=>{window.detectedEndpoint='http://127.0.0.1:8199';window.dispatchEvent(new Event('focus'));});
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes[0].comfyVideo.endpoint==='http://127.0.0.1:8199');
  assert.deepEqual((await snapshot()).nodes[0].outputs.image?.assetIds,['h3-video'],'automatic endpoint update preserves completed output');
  await page.locator(`[data-workflow-result-link="${resultId}"].is-image`).waitFor();
  assert.equal(await card.locator('video').count(),0);
  await page.screenshot({path:'.tmp/comfy-video/completed.png'});
  const submittedCount=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('comfy-calls')).filter(call=>call.action==='start').length);
  await page.evaluate(()=>window.save());
  await page.reload();await card.waitFor();await installMock();
  assert.deepEqual((await snapshot()).nodes[0].outputs.image.assetIds,['h3-video'],'completed output survives reload');
  assert.equal((await snapshot()).nodes[0].resultNodeIds[0],resultId);
  assert.equal(await page.evaluate(id=>window.snapshot().nodes.filter(node=>node.id===id).length,resultId),1,'reload never duplicates result');
  // Migrate a completed legacy inline result using its original asset and request identity.
  resultId='workflow-comfy:legacy-completed-request';
  await page.evaluate(async ()=>{
    const saved=JSON.parse(sessionStorage.getItem('workflow-p'));delete saved.document.nodes[0].resultNodeIds;
    const nodeId=saved.document.nodes[0].id;
    saved.document.run.steps[nodeId].jobId='legacy-completed-request';
    saved.document.runs.find(run=>run.id===saved.document.run.id).steps[nodeId].jobId='legacy-completed-request';
    sessionStorage.setItem('workflow-p',JSON.stringify(saved));
    const {CanvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const controller=new CanvasWorkflowController('p');await controller.load();
    if(controller.error)throw new Error(controller.error);
  });
  assert.equal((await snapshot()).nodes[0].resultNodeIds[0],resultId,'legacy result uses same deterministic identity');
  assert.equal(await page.evaluate(id=>window.snapshot().nodes.filter(node=>node.id===id).length,resultId),1);
  // Existing hidden results belong to the user; compatibility must not bring them back.
  await page.evaluate(async id=>{
    const saved=JSON.parse(sessionStorage.getItem('workflow-p'));delete saved.document.nodes[0].resultNodeIds;
    sessionStorage.setItem('workflow-p',JSON.stringify(saved));
    await window.__TAURI_INTERNALS__.invoke('project_canvas_node_remove',{nodeId:id});
    const {CanvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const controller=new CanvasWorkflowController('p');await controller.load();
    if(controller.error)throw new Error(controller.error);
  },resultId);
  assert.equal(await page.evaluate(id=>window.snapshot().nodes.find(node=>node.id===id).hiddenAt,resultId),20,'deleted result remains hidden');
  assert.equal(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('comfy-calls')).filter(call=>call.action==='start').length),submittedCount,'detect/reload never resubmits');
  // Real step counts, phase reset, failed cancellation and confirmed interruption.
  await page.reload();await card.waitFor();await installMock();
  await page.evaluate(()=>{window.environmentPhase='ready';window.comfyMode='running';window.comfyProgress={label:'生成视频',value:3,max:8};});
  await card.getByRole('button',{name:'运行此卡片',exact:true}).click();
  const progress=card.getByLabel('本地视频当前阶段进度',{exact:true});
  await page.waitForFunction(()=>document.querySelector('.comfy-progress-bar')?.getAttribute('aria-valuenow')==='37.5');
  assert.equal(await progress.getAttribute('aria-valuemax'),'100');
  assert.equal(await card.locator('.comfy-progress-fill').evaluate(el=>el.style.width),'37.5%');
  assert.equal(await card.locator('.comfy-progress-fill').evaluate(el=>getComputedStyle(el).animationName),'none');
  await card.locator('.comfy-progress-bar').getByText('38%',{exact:true}).waitFor();
  assert.equal(await card.getByText(/3\/8/).count(),0);
  await page.screenshot({path:'.tmp/comfy-video/real-progress.png'});
  await page.evaluate(()=>{window.comfyProgress={label:'保存视频',value:null,max:null};});
  await card.getByText('保存视频',{exact:true}).waitFor();
  assert.equal(await progress.getAttribute('aria-valuenow'),null,'new phase clears previous sampling percentage');
  assert.equal(await card.locator('.comfy-progress-fill').evaluate(el=>el.style.width),'0%','unknown progress stays empty without looping');
  await page.evaluate(()=>{window.cancelMode='error';});
  await card.getByRole('button',{name:'停止工作流'}).click();
  await card.getByText(/尚未确认停止/).waitFor();
  assert.equal((await snapshot()).run.status,'waiting','cancel failure cannot claim stopped');
  await page.evaluate(()=>{window.cancelMode='cancelled';});
  await card.getByRole('button',{name:'停止工作流'}).click();
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.run?.status==='stopped');
  assert.equal((await snapshot()).run.steps[(await snapshot()).nodes[0].id].comfyCancelled,true);
  assert.equal(await card.getByRole('button',{name:'取回上次视频'}).count(),0,'cancelled task cannot be retrieved');
  assert.equal(await progress.count(),0);
  const finalCalls=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('comfy-calls')));
  const finalStart=finalCalls.filter(call=>call.action==='start').at(-1);
  assert.ok(finalCalls.filter(call=>call.action==='cancel').slice(-2).every(call=>call.requestId===finalStart.requestId),'stop targets the exact current request');
  // Stop during POST waits for its response before cancelling; nothing can submit after cancellation.
  await page.evaluate(()=>{window.holdSubmission=true;});
  await card.getByRole('button',{name:'运行此卡片',exact:true}).click();
  await page.waitForFunction(()=>typeof window.finishSubmission==='function');
  await card.getByRole('button',{name:'停止工作流'}).click();
  assert.equal(await card.getByRole('button',{name:'停止工作流'}).isDisabled(),true);
  assert.equal(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('comfy-calls')).filter(call=>call.action==='cancel').length),finalCalls.filter(call=>call.action==='cancel').length);
  await page.evaluate(()=>window.finishSubmission());
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.run?.status==='stopped');
  assert.equal((await snapshot()).run.steps[(await snapshot()).nodes[0].id].comfyCancelled,true);
  await page.reload();await card.waitFor();await installMock();
  assert.equal(await card.getByRole('button',{name:'取回上次视频'}).count(),0,'confirmed cancellation survives reload');
  assert.deepEqual(errors,[]);
  console.log('H3 UI: header status dot, two-button setup, install/retry, keyboard dismissal, frame inputs, one-click run and durable recovery passed');
} catch(error) { console.error(errors);await page.screenshot({path:'.tmp/comfy-video/failure.png'});throw error; }
finally { await browser.close();await server.close(); }
