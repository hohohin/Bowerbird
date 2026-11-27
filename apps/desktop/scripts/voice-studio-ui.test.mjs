import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
import { selectCanvasTool } from './fixtures/canvas-reference/place-card.mjs';

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
    const assetTitle=text=>{
      const normalized=Array.from(text.trim().split(/\s+/u).join(' '));
      return normalized.length>48?normalized.slice(0,47).join('')+'…':normalized.join('');
    };
    const read=()=>JSON.parse(sessionStorage.getItem('voice-fixture')||'{"voices":[],"jobs":[],"assets":[]}');
    const save=s=>sessionStorage.setItem('voice-fixture',JSON.stringify(s));
    const emitJob=job=>ipc.invoke('plugin:event|emit',{event:'voice://job-updated',payload:{
      project:job.project,id:job.id,request_key:job.request_key,purpose:job.purpose,status:job.status,
    }});
    window.updateVoiceJob=async patch=>{
      const s=read(),job=s.jobs[0];
      Object.assign(job,patch);
      if(job.status==='succeeded' && !job.asset_id) {
        job.asset_id='audio-'+job.id;
        s.assets.push({...source,id:job.asset_id,name:assetTitle(job.text)});
      }
      save(s);
      await emitJob(job);
    };
    window.addVoiceHistory=async count=>{
      const s=read();
      for(let index=count;index>0;index--) s.jobs.push({
        id:'history-'+index,project:'p',voice_id:'saved',purpose:'speech',status:'succeeded',message:'已保存',
        text:'历史配音 '+index,asset_id:null,
      });
      save(s);
      await emitJob(s.jobs[0]);
    };
    Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,get:()=>ipc,set:original=>{
      ipc={...original,invoke:async(command,args)=>{
        const s=read();
        if(command.startsWith('voice_')) (window.voiceCalls??=[]).push({command,args});
        if(command==='project_canvas_node_create' && window.failVoiceDelivery) { window.failVoiceDelivery=false;throw new Error('模拟画板写入失败'); }
        if(command==='voice_environment'){
          (window.voiceEnvironmentCalls??=[]).push(args.action);
          if(args.action==='check' && window.delayNextVoiceCheck) {
            window.delayNextVoiceCheck=false;
            return await new Promise(resolve=>{window.releaseVoiceCheck=resolve;});
          }
          if(window.showVoiceInstallProgress) return {phase:'installing',message:'正在准备 PyTorch CUDA 安装包',
            install_step:'pytorch',progress_percent:72,active_seconds:9,completed_bytes:123,total_bytes:123};
          if(args.action==='install') sessionStorage.setItem('voice-ready','yes');
          const ready=!!sessionStorage.getItem('voice-ready') && !window.voiceLibraryMissing;
          return {phase:ready?'ready':'missing',message:ready?'环境已就绪':'需要安装配音环境',can_install:!ready,total_bytes:1,completed_bytes:0};
        }
        if(command==='voice_snapshot'){
          const history=s.jobs.filter(job=>job.project===args.project&&job.purpose!=='preview');
          const start=args.before?history.findIndex(job=>job.id===args.before)+1:0;
          const limit=args.historyLimit??30;
          const jobs=history.slice(start,start+limit);
          return {...s,jobs,assets:s.assets.filter(asset=>jobs.some(job=>job.asset_id===asset.id)),
            config:{python:'',model:''},has_history:history.length>0,has_more:start+limit<history.length};
        }
        if(command==='voice_job'){
          const job=s.jobs.find(job=>job.project===args.project&&(args.id?job.id===args.id:job.request_key===args.requestKey));
          return job?{job,asset:s.assets.find(asset=>asset.id===job.asset_id)??null}:null;
        }
        if(command==='voice_diagnostic'){window.openVoiceDiagnostic=args;return;}
        if(command==='voice_configure'){window.connectedVoiceConfig=args.config;return;}
        if(command==='plugin:dialog|open') return 'C:/sample.wav';
        if(command==='import_files'){s.assets=[source];save(s);return [source];}
        if(command==='get_assets_by_ids')return [...await original.invoke(command,args),...s.assets.filter(a=>args.assetIds.includes(a.id))];
        if(command==='audio_waveform')return {sourceVersion:'fixture',duration:4,sampleRate:8000,channels:1,peaks:[[-.5,.5]],framesPerPeak:32000,totalFrames:32000};
        if(command==='voice_save'){const voice={id:'saved',name:args.name,asset_id:args.assetId,reference:source.store_path,duration:4};s.voices.push(voice);save(s);return voice;}
        if(command==='voice_start'){
          const id='job-'+(s.jobs.length+1), asset={...source,id:'audio-'+id,name:assetTitle(args.text)};
          const hold=!!window.holdNextVoice;
          window.holdNextVoice=false;
          const job={id,project:args.project,text:args.text,voice_id:args.voiceId,purpose:args.preview?'preview':'speech',
            request_key:args.requestKey,draft_key:args.preview?.draftKey,asset_id:hold?null:asset.id,
            status:hold?'running':'succeeded',stage:hold?'loading_model':null,
            message:hold?'推理处理中':'已保存',preview:args.preview,seed:args.seed,language:args.language};
          if(!hold) s.assets.push(asset);
          s.jobs.unshift(job);
          save(s);
          await emitJob(job);
          if(window.loseVoiceReceipt){window.loseVoiceReceipt=false;throw new Error('模拟提交回执丢失');}
          return id;
        }
        return original.invoke(command,args);
      }};
    }});
  });
  await page.goto('http://127.0.0.1:17996/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(()=>window.store.setState({cloudAuth:{logged_in:true,user_id:'tester'},cloudEntitlement:{user_id:'tester',tier:'pro',offline_state:'fresh',is_test_account:true,balances:{daily:0,sub:0,topup:0},generation_services:[],policy:{can_use_byo:true,can_use_cloud:true}}}));
  await selectCanvasTool(page,'角色声音');
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
  await page.evaluate(()=>{window.showVoiceInstallProgress=true;});
  await page.getByRole('button',{name:'下载并启用'}).click();
  const installing=page.getByRole('dialog',{name:'本机配音环境'});
  await installing.getByRole('status').filter({hasText:'第 3 步，共 5 步'}).waitFor();
  assert.deepEqual(await installing.getByRole('progressbar',{name:'安装进度'}).evaluate(bar=>[bar.value,bar.max]),[72,100]);
  await installing.getByText('72% · 当前安装进程已运行 9 秒',{exact:true}).waitFor();
  await page.evaluate(()=>{window.showVoiceInstallProgress=false;sessionStorage.setItem('voice-ready','yes');});
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
  const language=card.getByRole('combobox',{name:'配音语种'});
  const chooseLanguage=async name=>{
    await language.click();
    await page.getByRole('listbox',{name:'配音语种'}).getByRole('option',{name,exact:true}).click();
  };
  await language.getByText('自动（随台词）',{exact:true}).waitFor();
  await chooseLanguage('粤语');
  await card.getByRole('textbox',{name:'试听台词'}).fill('这是编辑后的试听句。');
  await card.getByRole('spinbutton',{name:'入点秒数'}).fill('1');
  await card.getByText('高级设置',{exact:true}).click();
  await card.getByRole('spinbutton',{name:'随机种子'}).fill('321');
  await card.getByText('高级设置',{exact:true}).click();
  await page.evaluate(()=>{window.holdNextVoice=true;});
  await card.getByRole('button',{name:'生成试听'}).click();
  await card.getByRole('status').filter({hasText:'正在加载模型'}).waitFor();
  const voiceReads=await page.evaluate(()=>window.voiceCalls.filter(call=>call.command==='voice_snapshot').length);
  const jobReads=await page.evaluate(()=>window.voiceCalls.filter(call=>call.command==='voice_job').length);
  await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'voice://job-updated',
    payload:{project:'other-project',id:'job-1',purpose:'preview',status:'running'}}));
  await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(()=>window.voiceCalls.filter(call=>call.command==='voice_job').length),jobReads);
  await page.evaluate(()=>window.updateVoiceJob({stage:'synthesizing',progress:42}));
  await card.getByRole('status').filter({hasText:'正在合成音频 · 42%'}).waitFor({timeout:1500});
  assert.equal(await page.evaluate(()=>window.voiceCalls.filter(call=>call.command==='voice_snapshot').length),voiceReads);
  await page.evaluate(()=>window.updateVoiceJob({status:'succeeded',stage:'saving',progress:100,message:'已保存'}));
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('workflow-p')).document.run?.status==='done');
  const preview=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('voice-fixture')).jobs[0]);
  assert.equal(preview.text,'这是编辑后的试听句。');assert.equal(preview.preview.start,1);assert.equal(preview.preview.assetId,'clip');assert.equal(preview.seed,321);
  assert.equal(await page.evaluate(()=>window.voiceCalls.find(call=>call.command==='voice_start'&&call.args.preview)?.args.language),'yue');
  await card.locator('.voice-card > .audio-waveform').waitFor();
  const player = card.locator('.voice-card > .audio-waveform .audio-waveform-play');
  await player.click();
  await page.waitForFunction(()=>{const a=document.querySelector('audio[data-audio-preview]');return a && !a.paused;});
  await player.click();
  await card.screenshot({path:resolve(output,'audition.png')});
  await chooseLanguage('英语');
  await card.locator('.voice-card > .audio-waveform').waitFor({state:'hidden'});
  await chooseLanguage('粤语');
  await card.locator('.voice-card > .audio-waveform').waitFor();
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
  assert.equal(await page.evaluate(()=>window.voiceCalls.find(call=>call.command==='voice_start'&&!call.args.preview)?.args.language),'yue');
  assert.ok(await page.evaluate(key=>window.voiceCalls.some(call=>call.command==='voice_job'&&call.args.requestKey===key),speech.request_key));
  assert.equal(await page.evaluate(()=>window.store.getState().settings?.canvas_show_asset_names??false),false);
  const speechTitle=page.locator('[data-canvas-node-id="workflow-voice:job-2"] .canvas-node-name');
  await speechTitle.waitFor({state:'visible'});
  assert.equal(await speechTitle.textContent(),'欢迎来到这里。');
  assert.equal(await speechTitle.getAttribute('title'),'欢迎来到这里。');
  await card.screenshot({path:resolve(output,'speech.png')});
  await page.evaluate(()=>{window.holdNextVoice=true;});
  await card.getByRole('button',{name:'生成配音'}).click();
  await card.getByRole('status').filter({hasText:'正在加载模型'}).waitFor();
  await page.evaluate(()=>window.updateVoiceJob({
    status:'failed',stage:'failed',message:'显存不足，请关闭占用显存的程序后重试',error_code:'cuda_oom',has_diagnostic:true,
  }));
  await card.getByRole('alert').filter({hasText:'显存不足，请关闭占用显存的程序后重试'}).waitFor({timeout:1500});
  await card.getByRole('button',{name:'查看诊断日志',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.openVoiceDiagnostic),{project:'p',id:'job-3'});
  await card.screenshot({path:resolve(output,'speech-error.png')});
  await page.reload();
  await card.getByRole('textbox',{name:'配音台词'}).waitFor();
  assert.equal(await card.getByRole('textbox',{name:'配音台词'}).inputValue(),'欢迎来到这里。');
  await language.getByText('粤语',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('voice-fixture')).jobs.length),3);
  await card.getByText('高级设置',{exact:true}).click();
  assert.equal(await card.getByRole('spinbutton',{name:'随机种子'}).inputValue(),'321');
  await card.getByText('高级设置',{exact:true}).click();
  assert.ok(await page.evaluate(()=>window.voiceCalls.filter(call=>call.command==='voice_snapshot').every(call=>call.args.historyLimit===0)));
  await page.evaluate(()=>window.addVoiceHistory(32));
  await card.getByText('项目配音',{exact:true}).click();
  await card.getByRole('button',{name:'更多配音'}).click();
  await card.getByText('历史配音 1',{exact:true}).waitFor();
  assert.ok(await page.evaluate(()=>window.voiceCalls.some(call=>call.command==='voice_snapshot'&&call.args.historyLimit===30&&call.args.before)));
  await chooseLanguage('英语');
  const savedSpeech=card.locator('.voice-card-list > div').filter({hasText:'欢迎来到这里。',has:page.getByRole('button',{name:'导出',exact:true})});
  await savedSpeech.getByRole('button',{name:'复用台词',exact:true}).click();
  await language.getByText('粤语',{exact:true}).waitFor();
  const dismissIssue=page.getByRole('button',{name:'关闭工作流问题'});
  if(await dismissIssue.isVisible()) await dismissIssue.click();
  await page.evaluate(async()=>{
    const {canvasWorkflowController}=await import('/src/lib/canvasWorkflowRuntime.ts');
    const {newWorkflowNode}=await import('/src/lib/canvasWorkflow.ts');
    const controller=canvasWorkflowController('p');
    const first=controller.document.nodes.find(node=>node.kind==='voice');
    await controller.edit([...controller.document.nodes,newWorkflowNode('voice',first.x-490,first.y,'codex')]);
  });
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
  console.log('PASS role voice setup, audition and crop, seeded language requests, audio asset title, event updates, idempotent recovery, diagnostics, paginated history and card persistence');
} catch(e) {
  console.error(await page.locator('.workflow-card.is-voice').allTextContents(),errors,await page.evaluate(()=>({run: JSON.parse(sessionStorage.getItem('workflow-p')||'{}').document?.run, recent:window.calls.slice(-12).map(c=>c.command), alerts:document.body.innerText.slice(-650), voice:sessionStorage.getItem('voice-fixture')})));
  throw e;
} finally { await browser.close();await server.close(); }
