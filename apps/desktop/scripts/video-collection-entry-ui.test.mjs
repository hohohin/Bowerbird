import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server=await createServer({cacheDir:'.tmp/video-collection-entry/vite',
  server:{host:'127.0.0.1',port:1766,strictPort:true,hmr:false,watch:null}});
await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1280,height:840},reducedMotion:'reduce'});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const entry=()=>page.getByRole('button',{name:'采集视频',exact:true});
const dialog=()=>page.getByRole('dialog',{name:'采集视频',exact:true});
async function mockCollection(){await page.evaluate(()=>{
  const invoke=window.__TAURI_INTERNALS__.invoke;
  window.calls ||= [];
  window.__TAURI_INTERNALS__.invoke=async(command,args)=>{
    if(command==='video_collection'){window.calls.push({command,args});return [];}
    return invoke(command,args);
  };
});}
try{
  await mkdir('.tmp/video-collection-entry',{recursive:true});
  await page.goto('http://127.0.0.1:1766/scripts/fixtures/connected-collections/preview.html');
  await page.locator('[data-connection-entry="root-0"]').waitFor();await mockCollection();
  assert.equal(await entry().count(),0,'collection entry removed from library');
  await page.goto('http://127.0.0.1:1766/scripts/fixtures/explorer/preview.html');await mockCollection();
  await page.getByRole('button',{name:'探索',exact:true}).click();
  const panel=page.getByRole('region',{name:'探索浏览器'});
  await panel.waitFor();
  assert.equal(await panel.getByText('登录状态保存在本机',{exact:true}).count(),0,'explorer has no redundant local-login note');
  for(const width of [1280,900,700]){
    await page.setViewportSize({width,height:840});
    await entry().click();await dialog().waitFor();
    await page.getByRole('button',{name:'关闭',exact:true}).click();
    assert.equal(await panel.isVisible(),true,'closing collection preserves exploration');
    const bounds=await entry().boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width);
  }
  assert.equal(await panel.getByRole('button',{name:'浏览器插件',exact:true}).isVisible(),true);
  await page.screenshot({path:'.tmp/video-collection-entry/explorer-drag-only.png'});
  assert.deepEqual(errors,[]);
  console.log('PASS: library entry removed; explorer collection opens and closes at three widths');
}finally{await browser.close();await server.close();}
