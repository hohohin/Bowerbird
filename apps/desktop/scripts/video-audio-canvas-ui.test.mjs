import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {createServer} from 'vite';
import {chromium} from '../../html-renderer/node_modules/playwright/index.mjs';
const dir='.tmp/video-audio-canvas'; await mkdir(dir,{recursive:true});
const ffmpeg=process.env.BOWERBIRD_FFMPEG_BINARY||resolve('../../.tmp/video-integration/tools/local/ffmpeg.exe');
execFileSync(ffmpeg,['-v','error','-y','-f','lavfi','-i','sine=frequency=440:duration=2',`${dir}/track.wav`]);
execFileSync(ffmpeg,['-v','error','-y','-f','lavfi','-i','color=lime:s=180x320:r=25:d=2','-c:v','libx264','-pix_fmt','yuv420p',`${dir}/source.mp4`]);
const server=await createServer({configFile:false,root:process.cwd(),resolve:{alias:{'@':resolve('src')}},cacheDir:`${dir}/vite`,server:{host:'127.0.0.1',port:1747,strictPort:true,hmr:false,watch:null}});
await server.listen();const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1500,height:1000}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const audio={id:'exported-audio',name:'提取音轨',ext:'wav',store_path:`/${dir}/track.wav`,duration:2,source:'video-audio',file_mtime:1};
async function install() {await page.evaluate(audio=>{
  const original=window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke=async(command,args={})=>{
    if(command==='extract_video_audio'){window.calls.push({command,args});return audio;}
    if(command==='audio_waveform')return {schemaVersion:1,duration:2,sampleRate:44100,channels:1,framesPerPeak:441,totalFrames:88200,peaks:Array.from({length:200},()=>[-0.3,0.3]),sourceVersion:'synthetic-audio'};
    return original(command,args);
  };
},audio);}
try {
  await page.goto('http://127.0.0.1:1747/scripts/fixtures/canvas-reference/preview.html?strict&detail-route');
  await page.evaluate(({audio,dir})=>sessionStorage.setItem('reference-drafts',JSON.stringify([audio,{id:'clip',name:'视频',ext:'mp4',store_path:`/${dir}/source.mp4`,width:180,height:320,duration:2}])),{audio,dir});
  await page.reload(); await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();await install();
  await page.evaluate(()=>window.store.getState().openDetail('clip'));
  const detail=page.locator('.asset-detail');await detail.waitFor();await page.waitForFunction(()=>document.querySelector('.asset-detail video')?.readyState>=2);
  await page.evaluate(()=>{window.failNodeSave=true;});
  await detail.getByRole('button',{name:'提取视频音轨',exact:true}).click();await page.getByRole('menuitem',{name:'添加到画板',exact:true}).click();
  await detail.getByRole('alert').waitFor();
  await page.evaluate(()=>{window.failNodeSave=false;});
  await detail.getByRole('button',{name:'提取视频音轨',exact:true}).click();await page.getByRole('menuitem',{name:'添加到画板',exact:true}).click();
  await detail.getByRole('status').filter({hasText:'音轨已添加到画板'}).waitFor();
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='extract_video_audio').length),1);
  const saved=await page.evaluate(()=>window.snapshot().nodes.filter(n=>n.assetId==='exported-audio'));
  assert.equal(saved.length,1);assert.equal(saved[0].projectId,'p');
  await detail.getByRole('button',{name:'返回',exact:true}).click();
  const card=page.locator(`[data-canvas-node-id="${saved[0].id}"]`);
  await page.screenshot({path:`${dir}/before-wave.png`});await card.locator('[data-wave-ready="true"]').waitFor();
  await card.getByRole('button',{name:'从头播放 提取音轨',exact:true}).click();
  await card.locator('[data-playing="true"]').waitFor();await card.getByRole('button',{name:'暂停 提取音轨',exact:true}).click();
  assert.equal(await card.locator('img').count(),0,'audio must never use the image renderer');
  await page.screenshot({path:`${dir}/canvas.png`});
  await page.evaluate(audio=>{window.save();const drafts=JSON.parse(sessionStorage.getItem('reference-drafts'));sessionStorage.setItem('reference-drafts',JSON.stringify([...drafts,audio]));},audio);
  await page.reload();await page.locator(`[data-canvas-node-id="${saved[0].id}"] .audio-waveform`).waitFor();
  console.log('PASS actual canvas queue retry, one node, audio playback, persisted reload');
}finally{await browser.close();await server.close();}
