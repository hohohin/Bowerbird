import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const directory = '.tmp/video-fine-strip';
await mkdir(directory, { recursive: true });
execFileSync(process.env.BOWERBIRD_FFMPEG_BINARY || resolve('../../.tmp/video-integration/tools/local/ffmpeg.exe'),
  ['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=red:s=160x90:r=10:d=20',
    '-f','lavfi','-i','color=lime:s=160x90:r=10:d=20','-f','lavfi','-i','color=blue:s=160x90:r=10:d=20',
    '-filter_complex','[0:v][1:v][2:v]concat=n=3:v=1:a=0','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',`${directory}/long.mp4`]);
const server = await createServer({ configFile:false, root:process.cwd(), cacheDir:`${directory}/vite`,
  esbuild:{jsx:'automatic'}, optimizeDeps:{entries:[],include:['react','react-dom/client','react/jsx-runtime']},
  server:{host:'127.0.0.1',port:1765,strictPort:true,hmr:false,watch:null} });
await server.listen();
const browser = await chromium.launch({channel:'chrome',headless:true});
const page = await browser.newPage({viewport:{width:1400,height:1000}});
const errors=[]; page.on('pageerror',error=>errors.push(error.message));
try {
  await page.route('**/fine-strip-test',route=>route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));
  await page.goto('http://127.0.0.1:1765/fine-strip-test');
  await page.evaluate(async()=>{
    window.__TAURI_INTERNALS__={convertFileSrc:path=>path,invoke:async()=>null};
    const original=document.createElement.bind(document); window.decoders=[];
    document.createElement=function(name,...args){const element=original(name,...args);if(name==='video')window.decoders.push(element);return element;};
    const descriptor=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'currentTime'); window.samples=[];
    Object.defineProperty(HTMLMediaElement.prototype,'currentTime',{...descriptor,set(value){
      if(!this.isConnected){window.samples.push(value);if(window.delaySampling){setTimeout(()=>{if(this.hasAttribute('src'))descriptor.set.call(this,value);},80);return;}}
      descriptor.set.call(this,value);
    }});
    const [{default:React},{default:{createRoot}},{VideoPlayer}]=await Promise.all([
      import('/.tmp/video-fine-strip/vite/deps/react.js'),import('/.tmp/video-fine-strip/vite/deps/react-dom_client.js'),import('/src/components/VideoPlayer.tsx')]);
    const root=createRoot(document.getElementById('root'));
    Object.assign(document.getElementById('root').style,{width:'900px',height:'800px'});
    window.closePlayer=()=>root.unmount();
    root.render(React.createElement(React.StrictMode,null,React.createElement(VideoPlayer,{path:'/.tmp/video-fine-strip/long.mp4',fitContainer:true})));
  });
  const film=page.locator('.video-player-film');
  const readyStrip=()=>page.waitForFunction(()=>document.querySelectorAll('.video-player-film img').length===12);
  const pixels=()=>film.locator('img').evaluateAll(async images=>Promise.all(images.map(async image=>{
    await image.decode();const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
    const context=canvas.getContext('2d');context.drawImage(image,0,0);return [...context.getImageData(canvas.width/2,canvas.height/2,1,1).data];
  })));
  const seek=async time=>{await page.locator('.video-player-screen video').evaluate((video,time)=>{video.currentTime=time;},time);
    await page.waitForFunction(time=>Math.abs(Number(document.querySelector('[aria-label="视频时间轴"]').getAttribute('aria-valuenow'))-time)<0.05,time);};
  await readyStrip();
  const full=await pixels();
  assert.ok(full[0][0]>220 && full[5][1]>220 && full[11][2]>220,'full strip spans all three scenes');
  const fullSources=await film.locator('img').evaluateAll(images=>images.map(image=>image.src));
  await seek(30); await page.getByRole('button',{name:'细调',exact:true}).click();
  await page.waitForTimeout(300); await readyStrip();
  assert.ok((await pixels()).every(pixel=>pixel[1]>220 && pixel[0]<30 && pixel[2]<30),'fine strip must sample only nearby green scene, not all 60 seconds');
  const localSamples=await page.evaluate(()=>window.samples.slice(-12));
  assert.ok(localSamples.every(time=>time>=27 && time<39),`unexpected fine sampling times: ${localSamples}`);
  assert.ok(localSamples.at(-1)-localSamples[0]<12);
  const beforeStable=await page.evaluate(()=>window.decoders.length);
  await seek(30.3);await seek(30.6);await seek(30.9);await page.waitForTimeout(250);
  assert.equal(await page.evaluate(()=>window.decoders.length),beforeStable,'timeupdates in the same window must not resample');
  const bounds=await page.getByRole('slider',{name:'视频时间轴'}).boundingBox();
  await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);await page.mouse.down();
  await page.mouse.move(bounds.x+bounds.width/2+350,bounds.y+bounds.height/2,{steps:16});await page.waitForTimeout(250);
  assert.equal(await page.evaluate(()=>window.decoders.length),beforeStable,'dragging across a window boundary does not start extraction');
  await page.mouse.up();await page.waitForTimeout(200);await readyStrip();
  await seek(30.9);await page.waitForTimeout(200);await readyStrip();
  const beforeRapid=await page.evaluate(()=>window.decoders.length);
  await seek(8);await seek(25);await seek(54);await page.waitForTimeout(300);await readyStrip();
  assert.equal(await page.evaluate(()=>window.decoders.length),beforeRapid+1,'rapid jumps coalesce into one final window decoder');
  assert.ok((await pixels()).every(pixel=>pixel[2]>220 && pixel[0]<30 && pixel[1]<30),'late old-window frames cannot replace the final blue window');
  const sampleTimes=await page.evaluate(()=>window.samples.slice(-12));
  assert.ok(sampleTimes.every(time=>time>=48 && time<60));
  const geometry=await film.evaluate(element=>({width:parseFloat(element.style.width),translate:new DOMMatrix(getComputedStyle(element).transform).m41}));
  assert.equal(geometry.width,12*192,'strip width describes its 12 seconds, not the full duration');
  assert.equal(geometry.translate,(48-54)*192,'strip position maps local timestamps to the fixed playhead');
  const beforeReturn=await page.evaluate(()=>window.decoders.length);
  await page.getByRole('button',{name:'细调',exact:true}).click();await readyStrip();
  assert.deepEqual(await film.locator('img').evaluateAll(images=>images.map(image=>image.src)),fullSources);
  assert.equal(await page.evaluate(()=>window.decoders.length),beforeReturn,'returning to full mode reuses its complete cache');
  await page.getByRole('button',{name:'细调',exact:true}).click();await readyStrip();
  // Delayed real decoder seeks leave an old range in flight when the target changes.
  await page.evaluate(()=>{window.delaySampling=true;});
  await seek(16);await page.waitForTimeout(180);
  await page.evaluate(()=>{window.oldSampler=window.decoders.at(-1);window.delaySampling=false;});
  await seek(54);await page.waitForTimeout(350);await readyStrip();
  assert.ok((await pixels()).every(pixel=>pixel[2]>220 && pixel[0]<30 && pixel[1]<30));
  assert.ok(await page.evaluate(()=>window.oldSampler.paused&&!window.oldSampler.hasAttribute('src')),'obsolete sampler is released before its delayed seek');
  await page.setViewportSize({width:2600,height:1000});
  await page.evaluate(()=>{document.getElementById('root').style.width='2400px';});
  await page.waitForTimeout(300);await readyStrip();
  assert.equal(await film.evaluate(element=>parseFloat(element.style.width)),25*192,'wide/fullscreen layouts sample enough local time for their actual viewport');
  assert.ok((await page.evaluate(()=>window.samples.slice(-12))).every(time=>time>=35 && time<60));
  await page.evaluate(()=>{document.getElementById('root').style.width='900px';});
  // Start an uncached range then close before completion: every detached source releases.
  await seek(8);await page.waitForTimeout(170);await page.evaluate(()=>window.closePlayer());
  await page.waitForTimeout(100);
  assert.ok(await page.evaluate(()=>window.decoders.every(video=>video.paused&&!video.hasAttribute('src'))));
  assert.deepEqual(errors,[]);
  console.log('PASS: real 60s scenes, local fine sample times/colors, stable windows, rapid-seek coalescing, timestamp geometry, full-cache restore and decoder release');
} finally {await browser.close();await server.close();}
