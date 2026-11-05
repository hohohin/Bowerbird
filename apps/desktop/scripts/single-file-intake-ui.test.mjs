import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const server = await createServer({ configFile:false, root:process.cwd(), cacheDir:'.tmp/single-file-intake/vite', css:{postcss:{plugins:[]}}, esbuild:{jsx:'automatic'}, server:{host:'127.0.0.1', port:0, hmr:false, watch:null} });
await server.listen(); const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage();
try {
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/single-file-intake/preview.html`);
  await page.waitForFunction(()=>window.ready);
  for(const [name,type] of [['image.png','image/png'],['clip.mp4','video/mp4'],['voice.wav','audio/wav'],['notes.md','text/markdown']]) {
    const id=await page.evaluate(async ([name,type])=>{window.calls=[];return (await window.receive(name,type,1048583)).id;},[name,type]);
    assert.equal(id,'received');
    const calls=await page.evaluate(()=>window.calls);
    assert.deepEqual(calls.map(c=>c.command),['video_import_begin','video_import_append','video_import_append','video_import_finish']);
    assert.deepEqual(calls.filter(c=>c.command==='video_import_append').map(c=>c.args.offset),[0,1048576]);
    assert.equal(calls[0].args.projectId,null);
  }
  await page.evaluate(async ()=>{window.calls=[];await window.receive('known.png','image/png',10,'D:/known.png');});
  assert.deepEqual(await page.evaluate(()=>window.calls[0]),{command:'import_files',args:{sources:['D:/known.png'],projectId:null,collect:true}});
  await page.evaluate(async ()=>{window.calls=[];await window.receive('empty.md','',0);});
  assert.deepEqual(await page.evaluate(()=>window.calls.map(c=>c.command)),['video_import_begin','video_import_finish']);
  await page.evaluate(async ()=>{window.calls=[];window.failAppend=true;try {await window.receive('clip.mp4','video/mp4',10);} catch {} });
  assert.equal(await page.evaluate(()=>window.calls.at(-1).command),'video_import_cancel');
  await page.evaluate(async ()=>{window.calls=[];await window.receive('clipboard.png','image/png',10,undefined,'clipboard');});
  assert.equal(await page.evaluate(()=>window.calls.at(-1).command),'import_image_bytes');
  console.log('PASS standalone drops: all four media, 1 MiB chunks, known-path collection, failed upload cancellation, bitmap paste');
} finally { await browser.close(); await server.close(); }
