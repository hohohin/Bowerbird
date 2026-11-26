import { enableCanvasToolbarPro, selectCanvasTool } from './fixtures/canvas-reference/place-card.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const output = resolve('.tmp/voice-card-ui');
await mkdir(output, {recursive:true});
const wav = Buffer.alloc(44 + 8000 * 4 * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length-8,4); wav.write('WAVEfmt ',8); wav.writeUInt32LE(16,16);
wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22); wav.writeUInt32LE(8000,24); wav.writeUInt32LE(16000,28);
wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34); wav.write('data',36); wav.writeUInt32LE(wav.length-44,40);
for(let i=0;i<32000;i++) wav.writeInt16LE(Math.round(2400*Math.sin(i*.18)),44+i*2);
await writeFile(resolve(output,'reference.wav'),wav);
const server=await createServer({cacheDir:resolve(output,'vite'),server:{host:'127.0.0.1',port:17996,strictPort:true,hmr:false,watch:null}});
await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1600,height:1100}});
page.setDefaultTimeout(10000);
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
  await page.addInitScript(()=>{
    let ipc;
    const source={id:'clip',name:'参考录音',ext:'wav',store_path:'/.tmp/voice-card-ui/reference.wav',duration:4,created_at:1};
    const read=()=>JSON.parse(sessionStorage.getItem('voice-fixture')||'{"voices":[],"jobs":[],"assets":[]}');
    const save=s=>sessionStorage.setItem('voice-fixture',JSON.stringify(s));
    Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,get:()=>ipc,set:original=>{
      ipc={...original,invoke:async(command,args)=>{
        const s=read();
        if(command==='project_canvas_node_create' && window.failVoiceDelivery) { window.failVoiceDelivery=false;throw new Error('模拟画板写入失败'); }
        if(command==='voice_environment'){
          (window.voiceEnvironmentCalls??=[]).push(args.action);
          if(args.action==='check' && window.delayNextVoiceCheck) {
            window.delayNextVoiceCheck=false;
            return await new Promise(resolve=>{window.releaseVoiceCheck=resolve;});
          }
          if(args.action==='install') sessionStorage.setItem('voice-ready','yes');
          const ready=!!sessionStorage.getItem('voice-ready') && !window.voiceLibraryMissing;
          return {phase:ready?'ready':'missing',message:ready?'环境已就绪':'需要安装配音环境',can_install:!ready,total_bytes:1,completed_bytes:0};
        }
        if(command==='voice_snapshot') return {...s,config:{python:'',model:''}};
        if(command==='voice_configure'){window.connectedVoiceConfig=args.config;return;}
        if(command==='plugin:dialog|open') return 'C:/sample.wav';
        if(command==='import_files'){s.assets=[source];save(s);return [source];}
        if(command==='get_assets_by_ids')return [...await original.invoke(command,args),...s.assets.filter(a=>args.assetIds.includes(a.id))];
        if(command==='audio_waveform')return {sourceVersion:'fixture',duration:4,sampleRate:8000,channels:1,peaks:[[-.5,.5]],framesPerPeak:32000,totalFrames:32000};
        if(command==='voice_save'){const voice={id:'saved',name:args.name,asset_id:args.assetId,reference:source.store_path,duration:4};s.voices.push(voice);save(s);return voice;}
        if(command==='voice_start'){
          const id='job-'+(s.jobs.length+1), asset={...source,id:'audio-'+id};
          s.assets.push(asset);s.jobs.unshift({id,project:args.project,text:args.text,voice_id:args.voiceId,purpose:args.preview?'preview':'speech',request_key:args.requestKey,draft_key:args.preview?.draftKey,asset_id:asset.id,status:'succeeded',message:'已保存',preview:args.preview});save(s);if(window.loseVoiceReceipt){window.loseVoiceReceipt=false;throw new Error('模拟提交回执丢失');}return id;
        }
        return original.invoke(command,args);
      }};
    }});
  });
  await page.goto('http://127.0.0.1:17996/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(()=>window.store.setState({cloudAuth:{logged_in:true,user_id:'tester'},cloudEntitlement:{user_id:'tester',tier:'pro',offline_state:'fresh',is_test_account:true,balances:{daily:0,sub:0,topup:0},generation_services:[],policy:{can_use_byo:true,can_use_cloud:true}}}));
  await selectCanvasTool(page, '角色声音');
  await page.mouse.click(890,180);
  const card=page.locator('.workflow-card.is-voice');
  await card.waitFor();
  assert.equal(await page.getByRole('dialog').count(),0);
  await page.waitForFunction(()=>window.voiceEnvironmentCalls?.includes('check'));
  const focusChecks=await page.evaluate(async()=>{
    const start=window.voiceEnvironmentCalls.length;
    for(let i=0;i<3;i++){
      window.dispatchEvent(new Event('focus'));
      await new Promise(resolve=>setTimeout(resolve,40));
    }
    return window.voiceEnvironmentCalls.length-start;
  });
  assert.ok(focusChecks<=1,`only one probe per focus burst, saw ${focusChecks}`);
  await page.evaluate(()=>{window.delayNextVoiceCheck=true;});
  await card.getByRole('button',{name:'配音环境',exact:true}).click();
  await page.waitForFunction(()=>typeof window.releaseVoiceCheck==='function');
  await page.getByRole('button',{name:'下载并启用'}).click();
  await page.getByRole('dialog',{name:'本机配音环境'}).waitFor({state:'hidden'});
  await page.evaluate(()=>window.releaseVoiceCheck({phase:'missing',message:'迟到的未安装状态',can_install:true}));
  await page.waitForTimeout(50);
  assert.ok(await card.getByRole('button',{name:'配音环境',exact:true}).evaluate(element=>element.classList.contains('is-ready')));
  const readyChecks=await page.evaluate(async()=>{
    const start=window.voiceEnvironmentCalls.length;
    window.dispatchEvent(new Event('focus'));
    await new Promise(resolve=>setTimeout(resolve,40));
    return window.voiceEnvironmentCalls.length-start;
  });
  assert.equal(readyChecks,0,'a ready environment ignores passive window focus while the dialog is closed');
  await card.getByRole('button',{name:'配音环境',exact:true}).click();
  await page.getByRole('button',{name:'重新检测',exact:true}).click();
  await page.waitForFunction(()=>window.voiceEnvironmentCalls.includes('recheck'));
  await page.getByRole('button',{name:'关闭',exact:true}).click();
  await card.getByRole('button',{name:'选择文件'}).click();
  await card.getByRole('textbox',{name:'试听台词'}).fill('这是编辑后的试听句。');
  await card.getByRole('spinbutton',{name:'入点秒数'}).fill('1');
  await card.getByRole('button',{name:'生成试听'}).click();
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.run?.status==='done');
  const preview=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('voice-fixture')).jobs[0]);
  assert.equal(preview.text,'这是编辑后的试听句。');assert.equal(preview.preview.start,1);assert.equal(preview.preview.assetId,'clip');
  await card.locator('.voice-card > .audio-waveform').waitFor();
  const player = card.locator('.voice-card > .audio-waveform .audio-waveform-play');
  await player.click();
  await page.waitForFunction(()=>{const a=document.querySelector('audio[data-audio-preview]');return a && !a.paused;});
  await player.click();
  await card.screenshot({path:resolve(output,'audition.png')});
  await card.getByRole('textbox',{name:'试听台词'}).fill('换一条来听。');
  assert.equal(await card.locator('.voice-card > .audio-waveform').count(),0);
  await card.getByRole('textbox',{name:'声音名称'}).fill('林岸');
  await card.getByRole('button',{name:'保存并使用'}).click();
  await card.getByRole('textbox',{name:'配音台词'}).fill('欢迎来到这里。');
  assert.equal(await card.getByRole('textbox',{name:'试听台词'}).count(),0);
  await page.evaluate(()=>{window.failVoiceDelivery=true;window.loseVoiceReceipt=true;});
  await card.getByRole('button',{name:'生成配音'}).click();
  await card.getByRole('button',{name:'继续工作流'}).click();
  await page.waitForFunction(()=>window.snapshot().nodes.some(n=>n.id==='workflow-voice:job-2'&&n.assetId==='audio-job-2'));
  const speech=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('voice-fixture')).jobs[0]);
  assert.equal(speech.text,'欢迎来到这里。');assert.equal(speech.voice_id,'saved');
  await card.screenshot({path:resolve(output,'speech.png')});
  await page.reload();
  await card.getByRole('textbox',{name:'配音台词'}).waitFor();
  assert.equal(await card.getByRole('textbox',{name:'配音台词'}).inputValue(),'欢迎来到这里。');
  assert.equal(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('voice-fixture')).jobs.length),2);
  await enableCanvasToolbarPro(page);
  await selectCanvasTool(page, '角色声音');
  await page.mouse.click(700,700);
  const second=page.locator('.workflow-card.is-voice').nth(1);
  await second.waitFor();
  assert.equal(await second.getByRole('textbox',{name:'配音台词'}).count(),0);
  await second.evaluate(async el=>{
    const drag=await import('/src/lib/dragPayload.ts');
    drag.setDragAssets(['clip']);
    el.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:new DataTransfer()}));
    drag.setDragAssets(null);
  });
  await second.getByRole('textbox',{name:'试听台词'}).waitFor();
  assert.equal(await page.locator('.workflow-card.is-voice').first().getByRole('textbox',{name:'配音台词'}).inputValue(),'欢迎来到这里。');
  await second.getByRole('button',{name:'配音环境',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'本机配音环境'});
  await dialog.getByRole('button',{name:'重新检测',exact:true}).waitFor();
  await page.waitForTimeout(5050);
  const sharedChecks=await page.evaluate(async()=>{
    const start=window.voiceEnvironmentCalls.length;
    for(let i=0;i<3;i++){
      window.dispatchEvent(new Event('focus'));
      await new Promise(resolve=>setTimeout(resolve,40));
    }
    return window.voiceEnvironmentCalls.slice(start);
  });
  assert.deepEqual(sharedChecks,['check'],'an open dialog refreshes through one shared focus check even with two cards');
  await dialog.getByText('连接已有环境',{exact:true}).click();
  await dialog.getByRole('button',{name:'选择 Python',exact:true}).click();
  await dialog.getByRole('button',{name:'选择模型目录',exact:true}).click();
  const explicit=await page.evaluate(()=>window.voiceEnvironmentCalls.filter(action=>action==='recheck').length);
  await dialog.getByRole('button',{name:'连接并检查',exact:true}).click();
  await page.waitForFunction(count=>window.voiceEnvironmentCalls.filter(action=>action==='recheck').length===count+1, explicit);
  assert.deepEqual(await page.evaluate(()=>window.connectedVoiceConfig),{python:'C:/sample.wav',model:'C:/sample.wav'});
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  await page.evaluate(()=>{window.releaseVoiceCheck=undefined;window.delayNextVoiceCheck=true;});
  await second.getByRole('button',{name:'配音环境',exact:true}).click();
  await page.waitForFunction(()=>typeof window.releaseVoiceCheck==='function');
  await page.evaluate(()=>{
    window.voiceLibraryMissing=true;
    window.store.setState(state=>({settings:{...state.settings,library_root:'D:/voice-fixture-other'}}));
  });
  await page.waitForFunction(()=>[...document.querySelectorAll('.workflow-card.is-voice [aria-label="配音环境"]')].every(button=>!button.classList.contains('is-ready')));
  await page.evaluate(()=>window.releaseVoiceCheck({phase:'ready',message:'旧资料库的迟到结果'}));
  await page.waitForTimeout(50);
  assert.equal(await page.locator('.workflow-card.is-voice .comfy-environment-dot.is-ready').count(),0);
  assert.deepEqual(errors,[]);
  console.log('PASS toolbox placement, shared focus checks, explicit CUDA recheck, environment setup, edited audition and crop, inline audio, voice selection, spoken output and card persistence');
} catch(e) {
  console.error(await page.locator('.workflow-card.is-voice').allTextContents(),errors,await page.evaluate(()=>({run: JSON.parse(sessionStorage.getItem('workflow-p')||'{}').document?.run, recent:window.calls.slice(-12).map(c=>c.command), alerts:document.body.innerText.slice(-650), voice:sessionStorage.getItem('voice-fixture')})));
  throw e;
} finally { await browser.close();await server.close(); }
