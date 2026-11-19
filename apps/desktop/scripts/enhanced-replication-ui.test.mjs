import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const dir = '.tmp/enhanced-replication-ui';
await mkdir(dir, { recursive: true });
await writeFile(`${dir}/index.html`, '<html lang="zh"><meta charset="utf-8"><div id="root"></div><script type="module" src="./fixture.tsx"></script></html>');
await writeFile(`${dir}/fixture.tsx`, `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {EnhancedReplication} from '/src/components/EnhancedReplication';
import {replicationAnalysisNote} from '/src/lib/replicationAnalysisNote';
import {CanvasTextCard} from '/src/components/CanvasTextCard';
import {VideoPlayer} from '/src/components/VideoPlayer';
window.renderSeekTest=()=>{const host=document.createElement('div');document.body.append(host);const root=createRoot(host);let revision=0;window.seekShot=time=>root.render(<VideoPlayer path="/.tmp/video-redesign/wide.mp4" embedded seekRequest={{time,revision:++revision}}/>);window.seekShot(1);};
window.renderOutput=()=>{const host=document.createElement('div');host.style.cssText='width:640px;height:500px;position:relative';document.body.append(host);const root=createRoot(host);const render=()=>root.render(<CanvasTextCard value={window.note} selected={true} width={640} height={500} zoom={1} onSelect={()=>{}} onResize={()=>{}} onChange={value=>{window.note=value;render();}}/>);render();};
import '/src/styles.css'; import '/src/components/VideoReplication.css'; import '/src/components/IndustrialTheme.css';
document.documentElement.dataset.theme='dark';
document.body.style.cssText='background:var(--bb-bg);padding:24px;min-width:0;overflow:auto';
window.exports=[]; window.calls=[]; window.enabled=false; window.copied=[]; window.notices=[];
Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{if(window.copyFails)throw Error('clipboard denied');window.copied.push(text);}},configurable:true});
window.addEventListener('bowerbird://notify',event=>window.notices.push(event.detail));
window.record={id:'a'.repeat(32),slices:[{index:0,start:0,end:5,boundary:'start'},{index:1,start:5,end:12,boundary:'scene'}]};
window.__TAURI_INTERNALS__={convertFileSrc:path=>path,invoke:async(command,args)=>{
 if(command==='get_assets_by_ids')return args.assetIds.map(id=>({id,name:id,store_path:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="%2370848a"/></svg>'),width:320,height:180}));
 if(command!=='video_replication') return null;
 const {action}=args; window.calls.push(action);
 if(action==='enhanced-frame') return {index:args.data.index,time:2,dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7GQAAAAASUVORK5CYII='};
 if(action==='capabilities')return {services:['video-analysis','text-rewrite','speech-transcription'].map(operation=>({operation,available:operation!=='speech-transcription'||window.enabled,credits:3}))};
 if(action==='enhanced-prepare'||action==='enhanced-get')return structuredClone(window.record);
 if(action==='enhanced-analyze'){window.record={...window.record,state:'interrupted',resumeAction:action,error:'模拟断线'};return structuredClone(window.record);}
 if(action==='enhanced-plan'){window.record={...window.record,state:'planned',error:'',prompts:[{index:0,prompt:'人物说 [[intro|你好]]',duration:5},{index:1,prompt:'第二段人物走进画面',duration:7}]};return structuredClone(window.record);}
 if(action==='enhanced-save'){window.record={...window.record,prompts:args.data.prompts,message:'分镜已保存'};return structuredClone(window.record);}
 if(action==='enhanced-finish'){window.record={...window.record,state:'running',frozenPrompts:args.data.prompts};return structuredClone(window.record);}
 throw Error('unexpected '+action);
}};
createRoot(document.getElementById('root')).render(<React.StrictMode><main className="video-replication" style={{maxWidth:720,margin:"auto"}}><EnhancedReplication projectId="p" caseId="case" persona="编导" rules="保留节奏" direction="" beforePrepare={async()=>{}} onPrepared={()=>{}} onAddAnalysis={async output=>{window.exports.push(output);window.note=replicationAnalysisNote(output.rows.map(row=>({...row,assetId:"asset-"+row.index})));if(window.failExport)throw Error("模拟保存失败");}} /></main></React.StrictMode>);
`);
const server = await createServer({ configFile: false, root: process.cwd(), resolve:{alias:{'@':resolve('src')}}, optimizeDeps:{entries:[`${dir}/index.html`]}, cacheDir: `${dir}/vite`, server: { host:'127.0.0.1',port:1698,strictPort:true,hmr:false,watch:null } });
await server.listen();
const browser = await chromium.launch({channel:'chrome',headless:true});
try {
 const page = await browser.newPage({viewport:{width:700,height:1000}}), errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.goto(`http://127.0.0.1:1698/${dir}/index.html`);
 assert.equal(await page.locator('details').count(),0);
 await page.getByRole('button',{name:'检测切点并准备切片'}).click();
 await page.getByRole('button',{name:'逐段分析并识别语音'}).waitFor();
 assert.equal(await page.getByRole('button',{name:'复制镜头分析'}).isDisabled(),true);
 assert.equal(await page.getByRole('button',{name:'逐段分析并识别语音'}).isDisabled(),true);
 await page.evaluate(()=>{window.enabled=true;window.dispatchEvent(new Event('focus'));});
 await page.getByRole('button',{name:'逐段分析并识别语音'}).click();
 await page.getByRole('button',{name:'恢复原任务'}).waitFor();
 assert.equal(await page.evaluate(()=>window.calls.filter(a=>a==='enhanced-analyze').length),1);
 await page.evaluate(()=>{window.record={...window.record,state:'analyzed',error:'',speech:{text:'你好。接下来看看这款产品。'},analysis:[{index:0,analysis:{analysisText:'人物面向镜头说话，近景固定机位。背景保持简洁，重点是开场台词。'}},{index:1,analysis:{analysisText:'镜头转向桌上的产品，手部进入画面展示使用方式。'}}]};});
 await page.getByRole('button',{name:'改写各段分镜'}).click();
 await page.getByRole('checkbox',{name:'选择镜头 2',exact:true}).check();
 await page.getByRole('checkbox',{name:'选择镜头 1',exact:true}).check();
 await page.evaluate(()=>{window.failExport=true;});
 await page.getByRole('button',{name:'添加到画板',exact:true}).click();
 await page.evaluate(()=>{window.failExport=false;});
 await page.getByRole('button',{name:'添加到画板',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.exports[0].id===window.exports[1].id),true,'retry retains identity');
 assert.deepEqual(await page.evaluate(()=>window.exports[1].rows.map(row=>row.index)),[0,1]);
 assert.deepEqual(await page.evaluate(()=>window.note.cells.map(row=>row.map(cell=>cell.content_type))),[['image','text'],['image','text']]);
 assert.equal(await page.evaluate(()=>window.note.cells[1][0].image_refs[0].asset_id),'asset-1');
 assert.ok(await page.evaluate(()=>window.note.cells[0][1].text.includes(window.record.analysis[0].analysis.analysisText)));
 await page.getByRole('button',{name:'复制镜头分析'}).click();
 assert.equal(await page.evaluate(()=>window.copied.at(-1)),await page.evaluate(()=>window.record.analysis[0].analysis.analysisText));
 assert.equal(await page.evaluate(()=>window.notices.at(-1).tone),'success');
 await page.getByLabel('第 1 段生成提示词').fill('人物说 [[intro|新台词]]');
 await page.getByRole('button',{name:'查看镜头 2',exact:true}).focus();
 await page.keyboard.press('Enter');
 await page.getByRole('button',{name:'复制镜头分析'}).click();
 assert.equal(await page.evaluate(()=>window.copied.at(-1)),await page.evaluate(()=>window.record.analysis[1].analysis.analysisText));
 await page.evaluate(()=>{window.copyFails=true;});
 await page.getByRole('button',{name:'复制镜头分析'}).click();
 assert.equal(await page.evaluate(()=>window.notices.at(-1).tone),'error');
 await page.evaluate(()=>{window.copyFails=false;});
 await page.getByLabel('第 2 段生成提示词').fill('第二段改写内容');
 await page.getByRole('button',{name:'查看镜头 1',exact:true}).click();
 await page.waitForTimeout(2800);
 assert.equal(await page.getByLabel('第 1 段生成提示词').inputValue(),'人物说 [[intro|新台词]]');
 for(const theme of ['dark','light']){
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  for(const width of [760,390]){
   await page.setViewportSize({width,height:1000});
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');
   await page.screenshot({path:`${dir}/editor-${theme}-${width}.png`,fullPage:true});
  }
 }
 await page.getByRole('button',{name:'保存分镜'}).click();
 assert.equal(await page.getByRole('button',{name:'分镜已保存'}).isDisabled(),true);
 assert.equal(await page.evaluate(()=>window.record.prompts[1].prompt),'第二段改写内容');
 assert.equal(await page.evaluate(()=>window.record.prompts[0].prompt),'人物说 [[intro|新台词]]');
 await page.getByRole('button',{name:'逐段生成并合成字幕成片'}).click();
 assert.equal(await page.getByLabel('第 1 段生成提示词').isDisabled(),true);
 assert.equal(await page.evaluate(()=>window.calls.filter(a=>a==='enhanced-finish').length),1);
 await page.screenshot({path:`${dir}/running.png`,fullPage:true});
 await page.setViewportSize({width:900,height:1000});
 await page.evaluate(()=>window.renderOutput());
 await page.getByRole('textbox',{name:'第 1 行第 2 列',exact:true}).fill('在现有内容卡片中编辑');
 assert.equal(await page.evaluate(()=>window.note.cells[0][1].text),'在现有内容卡片中编辑');
 assert.equal(await page.getByRole('button',{name:'清空第 1 行第 1 列图片',exact:true}).count(),1);
 assert.equal(await page.getByRole('button',{name:'清空第 2 行第 1 列图片',exact:true}).count(),1);
 await page.screenshot({path:`${dir}/content-card.png`,fullPage:true});
 await page.evaluate(()=>window.renderSeekTest());
 await page.waitForFunction(()=>{const v=document.querySelector('video');return v&&v.readyState>=2&&!v.seeking&&Math.abs(v.currentTime-1)<.1;});
 await page.evaluate(()=>window.seekShot(2));
 await page.waitForFunction(()=>{const v=document.querySelector('video');return v&&v.paused&&!v.seeking&&Math.abs(v.currentTime-2)<.1;});
 assert.deepEqual(errors,[]);
 console.log('PASS: capability gate, explicit recovery, draft retention, frozen generation, StrictMode');
} finally { await browser.close(); await server.close(); }

