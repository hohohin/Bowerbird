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
    window.store.setState({cloudAuth:{logged_in:true,user_id:'tester'},cloudEntitlement:{user_id:'tester',is_test_account:true,balances:{daily:0,sub:0,topup:0},policy:{can_use_cloud:true,can_use_byo:true},generation_services:[]}});
    const invoke=window.__TAURI_INTERNALS__.invoke;
    window.comfyMode='unknown';window.comfyCalls=[];window.environmentCalls=[];window.environmentPhase='missing';
    const video={id:'h3-video',name:'H3 合成测试视频',store_path:'/synthetic-h3.mp4',ext:'mp4',width:672,height:1216,duration:8,source:'comfy-h3'};
    window.__TAURI_INTERNALS__.invoke=async (command,args)=>{
      if(command==='comfy_video_check') return '已连接 · 模拟工作流所需节点与模型可用';
      if(command==='comfy_video_environment') {
        window.environmentCalls.push(args);
        if(args.action==='install') window.environmentPhase='installing';
        if(args.action==='cancel') window.environmentPhase='cancelled';
        return {phase:window.environmentPhase,message:window.environmentPhase==='ready'?'本机环境已就绪 · 模型与节点可用':'模拟：尚未安装本机运行环境',endpoint:args.endpoint,directory:'D:\\Bowerbird-ComfyUI',canInstall:true,installed:false,downloadBytes:44048479273,requiredBytes:56933381161,completedBytes:1024000,totalBytes:44048479273};
      }
      if(command==='comfy_video'){
        window.comfyCalls.push({command,...args});
        const calls=JSON.parse(sessionStorage.getItem('comfy-calls')||'[]');calls.push(args);sessionStorage.setItem('comfy-calls',JSON.stringify(calls));
        if(args.action==='start')return {status:'queued',message:'已加入本机队列'};
        if(window.comfyMode==='disconnect') throw new Error('模拟连接中断');
        if(window.comfyMode==='queued')return {status:'queued',message:'已加入本机队列'};
        if(window.comfyMode==='done')return {status:'done',message:'视频已生成',asset:video};
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
  await page.getByRole('button',{name:'工具箱',exact:true}).click();
  await page.getByRole('menuitem',{name:/本地 H3 视频/}).click();
  assert.equal(await page.locator('.workflow-card.is-comfy-video').count(),0,'tool arms placement first');
  await page.mouse.click(890,180);
  const card=page.locator('.workflow-card.is-comfy-video');await card.waitFor();
  await card.getByRole('button',{name:'一键下载并安装',exact:true}).waitFor();
  assert.ok((await page.evaluate(()=>window.environmentCalls)).some(call=>call.action==='detect'),'placing a card automatically detects environment');
  assert.ok((await page.evaluate(()=>window.environmentCalls)).every(call=>call.action==='detect'),'detection never installs');
  await page.screenshot({path:'.tmp/comfy-video/setup-missing.png'});
  await card.getByRole('button',{name:'一键下载并安装',exact:true}).click();
  await card.getByLabel('环境下载进度',{exact:true}).waitFor();
  await card.getByRole('button',{name:'取消准备',exact:true}).click();
  await card.getByRole('button',{name:'继续安装',exact:true}).waitFor();
  await card.getByRole('button',{name:'继续安装',exact:true}).click();
  await card.getByLabel('环境下载进度',{exact:true}).waitFor();
  await page.evaluate(()=>{window.environmentPhase='ready';});
  await card.getByText('本机环境已就绪',{exact:true}).waitFor();
  assert.deepEqual(await card.getByLabel('H3 比例').locator('option').allTextContents(),['9:16','16:9','4:3']);
  assert.deepEqual(await card.getByLabel('H3 分辨率').locator('option').allTextContents(),['0.6','0.8','1.0']);
  await card.getByLabel('H3 时长').fill('11');
  await card.getByLabel('H3 比例').selectOption('4:3');
  await card.getByLabel('H3 分辨率').selectOption('0.6');
  await card.getByLabel('卡片指令',{exact:true}).fill('镜头平稳推进，主体自然转动');
  await page.locator('[data-canvas-node-id="old"]').hover();
  await page.getByRole('button',{name:'连接图片到工作流',exact:true}).first().click();
  await card.getByRole('button',{name:'输入：首帧',exact:true}).click();
  await page.evaluate(async()=>{const {setDragAssets}=await import('/src/lib/dragPayload.ts');setDragAssets(['b']);});
  await card.getByLabel('尾帧输入',{exact:true}).dispatchEvent('drop',{dataTransfer:await page.evaluateHandle(()=>new DataTransfer())});
  await page.evaluate(async()=>{const {setDragAssets}=await import('/src/lib/dragPayload.ts');setDragAssets(null);});
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes[0].inputs['last-frame']?.[0]?.assetId==='b');
  await card.getByText('高级连接设置',{exact:true}).click();
  await card.getByText('本机环境已就绪',{exact:true}).waitFor();
  await card.getByLabel('ComfyUI 地址').fill('http://127.0.0.1:8188');
  await card.getByText('本机环境已就绪',{exact:true}).waitFor();
  assert.equal((await page.evaluate(()=>window.comfyCalls)).length,0,'connection check never generates');
  await card.getByText('高级连接设置',{exact:true}).click();
  const layout=await card.evaluate(el=>({width:el.querySelector(".comfy-video-card").clientWidth,scroll:el.querySelector(".comfy-video-card").scrollWidth,top:el.getBoundingClientRect().top,controls:el.querySelector('.comfy-video-card').getBoundingClientRect().top,port:el.querySelector('[data-workflow-input="last-frame"]').getBoundingClientRect().bottom}));
  assert.ok(layout.scroll<=layout.width+2);assert.ok(layout.controls>layout.port);
  assert.ok(layout.controls-layout.top<150,'compact port section removes the large top blank');
  await page.screenshot({path:'.tmp/comfy-video/card-light.png'});
  await page.reload();await card.waitFor();await installMock();
  assert.equal(await card.getByLabel('H3 时长').inputValue(),'11');
  assert.equal(await card.getByLabel('H3 比例').inputValue(),'4:3');
  assert.equal(await card.getByLabel('H3 分辨率').inputValue(),'0.6');
  assert.equal((await snapshot()).nodes[0].inputs['last-frame'][0].assetId,'b');
  await card.getByRole('button',{name:'运行此卡片',exact:true}).click();
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.run?.status==='waiting');
  let calls=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('comfy-calls')));
  const submitted=calls.find(call=>call.action==='start');
  assert.equal(submitted.input.firstFrame,'existing');assert.equal(submitted.input.lastFrame,'b');assert.equal(submitted.input.seconds,11);
  assert.equal(submitted.input.ratio,'4:3');assert.equal(submitted.input.resolution,0.6);
  assert.equal(submitted.input.endpoint,'http://127.0.0.1:8188');assert.match(submitted.input.prompt,/镜头平稳/);
  await page.reload();await card.waitFor();await installMock();
  await page.evaluate(()=>{window.comfyMode='disconnect';});
  await card.getByRole('button',{name:'继续工作流'}).click();
  await card.getByText(/模拟连接中断/).waitFor();
  await page.evaluate(()=>{window.comfyMode='queued';});
  await card.getByRole('button',{name:'继续工作流'}).click();
  await card.getByText('已加入本机队列',{exact:true}).waitFor();
  await card.getByRole('button',{name:'停止工作流'}).click();
  await card.getByRole('button',{name:'取回上次视频'}).waitFor();
  assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.command==='cancel_codex_create').length),0,'stop never cancels unrelated generators');
  await page.evaluate(()=>{window.comfyMode='done';});
  await card.getByRole('button',{name:'取回上次视频'}).click();
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.run?.status==='done');
  assert.deepEqual((await snapshot()).nodes[0].outputs.image.assetIds,['h3-video']);
  assert.equal(await card.getByLabel('H3 生成视频').count(),1);
  calls=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('comfy-calls')));
  assert.equal(calls.filter(call=>call.action==='start').length,1,'recovery never resubmits');
  assert.ok(calls.every(call=>call.requestId===submitted.requestId));
  // Single-frame mode and a second explicit run get a new identity.
  await card.getByLabel('移除尾帧').click();
  await card.getByRole('button',{name:'运行此卡片',exact:true}).click();
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('comfy-calls')).filter(call=>call.action==='start').length===2);
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.run?.status==='done');
  const single=(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('comfy-calls')))).filter(call=>call.action==='start')[1];
  assert.equal(single.input.lastFrame,undefined);assert.notEqual(single.requestId,submitted.requestId);
  await page.screenshot({path:'.tmp/comfy-video/completed.png'});
  assert.deepEqual(errors,[]);
  console.log('H3 UI: placement, gates, frame wiring/drop, parameters, persistence, single output and durable recovery passed');
} catch(error) { console.error(errors);await page.screenshot({path:'.tmp/comfy-video/failure.png'});throw error; }
finally { await browser.close();await server.close(); }
