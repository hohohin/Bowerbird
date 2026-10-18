import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from '../../html-renderer/node_modules/playwright/index.mjs';

// One second of silent PCM: a real decodable media source, without external files.
const wav=Buffer.alloc(44+16000);
wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);
wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);
wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);
wav.write('data',36);wav.writeUInt32LE(16000,40);
const src=`data:audio/wav;base64,${wav.toString('base64')}`;
const html=`<video muted autoplay loop src="${src}"></video>`;
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
  const baseline=await browser.newPage();
  await baseline.goto(`data:text/html,${encodeURIComponent(html)}`);
  await baseline.waitForFunction(()=>document.querySelector('video').currentTime>0.1);
  await baseline.close();
  const context=await browser.newContext();
  await context.addInitScript(await readFile('src-tauri/src/commands/video_replication/douyin_quiet.js','utf8'));
  const page=await context.newPage();
  await page.goto(`data:text/html,${encodeURIComponent(html)}`);
  const denied=await page.locator('video').evaluate(v=>v.play().then(()=>false,e=>e.name));
  assert.equal(denied,'NotAllowedError');
  await page.evaluate(src=>{const audio=new Audio(src);audio.autoplay=true;audio.loop=true;document.body.append(audio);document.querySelector('video').autoplay=true;},src);
  await page.waitForTimeout(1200);
  const media=await page.locator('video,audio').evaluateAll(items=>items.map(v=>({paused:v.paused,time:v.currentTime,muted:v.muted,autoplay:v.autoplay})));
  assert.equal(media.length,2);
  assert.ok(media.every(v=>v.paused&&v.time===0&&v.muted&&!v.autoplay),JSON.stringify(media));
  await context.close();
  console.log('PASS declarative autoplay, explicit play and dynamically added media remain paused');
} finally {await browser.close();}
