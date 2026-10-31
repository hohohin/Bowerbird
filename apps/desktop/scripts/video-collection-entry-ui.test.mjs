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
  assert.equal((await entry().textContent()).trim(),'采集视频','the collection action must be readable without hovering an unexplained camera icon');
  for(const width of [1280,900,700]){
    await page.setViewportSize({width,height:840});await page.mouse.move(0,830);await page.waitForTimeout(120);
    assert.equal(await entry().isVisible(),true,'collection stays outside the collapsed overflow at narrow widths');
    assert.equal(await entry().evaluate(button=>!!button.closest('[inert], [aria-hidden="true"]')),false);
    const bounds=await entry().boundingBox();assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width,'entry remains inside the viewport');
    const more=page.getByRole('button',{name:'更多素材库控件',exact:true});
    if(await more.isVisible()){
      const moreBounds=await more.boundingBox(),heading=await page.locator('.file-view-heading').boundingBox();
      assert.ok(moreBounds.x + moreBounds.width <= Math.min(width,heading.x + heading.width),`more controls must stay inside the heading and viewport: ${JSON.stringify({width,bounds,moreBounds,heading,grid:await page.locator('.file-view-heading').evaluate(el=>getComputedStyle(el).gridTemplateColumns)})}`);
      assert.ok(bounds.x + bounds.width <= moreBounds.x,'collection and more controls must not overlap');
      await more.click();await page.getByRole('dialog',{name:'素材库控件',exact:true}).waitFor();
      await page.keyboard.press('Escape');
    }
    await entry().click();await dialog().waitFor();
    await page.getByRole('button',{name:'关闭',exact:true}).click();
  }
  await page.screenshot({path:'.tmp/video-collection-entry/library-narrow.png'});
  await page.evaluate(()=>{window.folders=[];window.entries=[];window.changed();});
  await page.getByText('点击「建立连接」选择素材文件夹。',{exact:true}).waitFor();
  await entry().click();await dialog().waitFor();
  await page.getByRole('button',{name:'关闭',exact:true}).click();
  await page.goto('http://127.0.0.1:1766/scripts/fixtures/explorer/preview.html');await mockCollection();
  await page.getByRole('button',{name:'探索',exact:true}).click();
  const panel=page.getByRole('region',{name:'探索浏览器'});
  await panel.waitFor();
  assert.equal(await panel.getByText('登录状态保存在本机',{exact:true}).count(),0,'explorer has no redundant local-login note');
  assert.equal(await panel.getByRole('button',{name:'采集视频',exact:true}).count(),0,'explorer uses direct dragging instead of a collection button');
  assert.equal(await panel.getByRole('button',{name:'浏览器插件',exact:true}).isVisible(),true);
  await page.screenshot({path:'.tmp/video-collection-entry/explorer-drag-only.png'});
  assert.deepEqual(errors,[]);
  console.log('PASS: readable persistent library entry at three widths and empty state; explorer removes redundant login note and collection button');
}finally{await browser.close();await server.close();}
