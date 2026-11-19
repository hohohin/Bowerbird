import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const dir = '.tmp/video-export';
await mkdir(dir, { recursive: true });
execFileSync(process.env.BOWERBIRD_FFMPEG_BINARY || resolve('../../.tmp/video-integration/tools/local/ffmpeg.exe'), ['-v','error','-y','-f','lavfi','-i','color=lime:s=180x320:r=25:d=2','-c:v','libx264','-pix_fmt','yuv420p',`${dir}/source.mp4`]);
await writeFile(`${dir}/index.html`, '<html data-theme="dark"><meta charset="utf-8"><div id="root"></div><script type="module" src="./fixture.tsx"></script></html>');
await writeFile(`${dir}/fixture.tsx`, `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {Lightbox} from '/src/components/Lightbox'; import {useStore} from '/src/store';
import '/src/styles.css'; import '/src/components/TacticalMenus.css'; import '/src/components/IndustrialTheme.css'; import '/src/components/IndustrialMenus.css';
const w=window as any; w.calls=[]; w.deliveries=[]; w.closeCount=0; w.failPlacement=true;
w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,invoke:async(cmd:string,args:any)=>{
  w.calls.push({cmd,args}); if(cmd==='extract_video_audio') return {id:'audio',name:'音轨',ext:'wav',store_path:'/audio.wav',duration:2}; return null;
}};
useStore.setState({activeProjectId:'original-project',projectRoutePending:false});
window.addEventListener('bowerbird:prepare-video-collection-project',(e:any)=>e.detail.result=Promise.resolve());
window.addEventListener('bowerbird:save-collected-video-to-canvas',(e:any)=>{ w.deliveries.push({...e.detail}); e.detail.result=w.failPlacement?Promise.reject(new Error('画板保存失败，请重试')):Promise.resolve(); });
createRoot(document.getElementById('root')!).render(<Lightbox images={['/${dir}/source.mp4']} index={0} onIndexChange={()=>{}} onClose={()=>w.closeCount++} videoFrameTarget="library" onAddVideoFrame={async f=>w.capturedFrame=f} onAddFrameToCanvas={async f=>w.canvasFrame=f}/>);
w.changeProject=(id='new-project')=>useStore.setState({activeProjectId:id});
`);
const server = await createServer({configFile:false, root:process.cwd(), resolve:{alias:{'@':resolve('src')}}, cacheDir:`${dir}/vite`, server:{host:'127.0.0.1',port:1746,strictPort:true,hmr:false,watch:null}});
await server.listen(); const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1100,height:900}}); page.setDefaultTimeout(15000);
const errors=[];page.on('pageerror',error=>errors.push(error.message));
try {
  await page.goto(`http://127.0.0.1:1746/${dir}/index.html`);
  await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2);
  const frame=page.getByRole('button',{name:'导出帧',exact:true});
  assert.equal(await frame.count(),1,'frame actions must be behind one export button');
  assert.equal(await page.getByRole('button',{name:'保存该帧到素材库',exact:true}).count(),0);
  const rect=await page.locator('.video-player').boundingBox(); await frame.click();
  assert.deepEqual(await page.locator('.video-player').boundingBox(),rect);
  await page.getByRole('menuitem',{name:'保存该帧到素材库',exact:true}).click();
  assert.ok(await page.evaluate(()=>window.capturedFrame?.dataUrl.startsWith('data:image/png')));
  await frame.click(); await page.keyboard.press('Escape'); assert.equal(await page.evaluate(()=>window.closeCount),0);
  const audio=page.getByRole('button',{name:'提取视频音轨',exact:true}); await audio.click();
  await page.getByRole('menuitem',{name:'添加到画板',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'画板保存失败'}).waitFor();
  await page.evaluate(()=>{window.failPlacement=false;window.changeProject();});
  await audio.click(); await page.getByRole('menuitem',{name:'添加到画板',exact:true}).click();
  await page.getByRole('status').filter({hasText:'音轨已添加到画板'}).waitFor();
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.cmd==='extract_video_audio').length),1,'retry must not extract twice');
  assert.deepEqual(await page.evaluate(()=>window.deliveries.map(d=>d.projectId)),['original-project','original-project']);
  assert.equal(await page.evaluate(()=>window.deliveries[0].operationId===window.deliveries[1].operationId),true);
  await audio.click(); await page.getByRole('menuitem',{name:'保存到素材库',exact:true}).click();
  await page.getByRole('status').filter({hasText:'音轨已保存到素材库'}).waitFor();
  await page.getByRole('button',{name:'全屏',exact:true}).click(); await frame.click();
  assert.equal(await page.getByRole('menu',{name:'导出帧',exact:true}).evaluate(e=>document.fullscreenElement.contains(e)),true);
  await page.keyboard.press('Escape'); assert.equal(await page.evaluate(()=>window.closeCount),0);
  await page.getByRole('button',{name:'退出全屏',exact:true}).click();
  for(const theme of ['dark','light']) {
    await page.setViewportSize({width:390,height:800});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    const before=await page.locator('.video-player').boundingBox();await audio.click();
    const menu=await page.getByRole('menu',{name:'提取视频音轨',exact:true}).boundingBox();
    assert.ok(menu.x>=0&&menu.x+menu.width<=390);assert.deepEqual(await page.locator('.video-player').boundingBox(),before);
    await page.screenshot({path:`${dir}/menu-${theme}.png`});await page.keyboard.press('Escape');
  }
  assert.deepEqual(errors,[]);
  await page.screenshot({path:`${dir}/controls.png`});
  console.log('PASS frame menu, layout, Escape/fullscreen, audio destinations and frozen retry');
} finally {await browser.close();await server.close();}
